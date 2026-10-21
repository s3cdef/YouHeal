#Requires -Version 5.1
<#
.SYNOPSIS
    Upgrade YOU HEAL Clinical in place with automatic rollback.

.DESCRIPTION
    1. Preflight: new source / offline bundle integrity, version, Node engine requirement.
    2. Encrypted backup (Backup-YouHeal.ps1) - the offline recovery point.
    3. Stop the service; cold snapshot of db\ (migrations are forward-only); save env, state, WinSW XML.
    4. Stage the new release with ITS OWN Install-YouHeal.ps1 (-NoStart -SkipMigrate -SkipCatalog), in a
       child PowerShell process; it switches the 'current' junction and regenerates the service definition.
    5. Migrate + catalog load.
    6. Start + health check.
    On failure in 4-6: stop, point 'current' back to the previous release, restore db\ and the saved config,
    re-register the previous service definition, start, health check.

.PARAMETER From
    New release: a source tree (package.json), an offline bundle folder, or youheal-<ver>-win-<arch>.zip.
.PARAMETER SkipBackup
    Skip step 2 (NOT recommended).
.PARAMETER Force
    Do not ask for confirmation.
.PARAMETER DataDir
    Data root. Default %ProgramData%\YouHeal.
.PARAMETER LogPath
    Log file. Default %ProgramData%\YouHeal\logs\upgrade-<timestamp>.log.
.PARAMETER DryRun
    Show what would happen (the nested installer also runs with -DryRun).

.EXAMPLE
    .\Upgrade-YouHeal.ps1 -From D:\youheal-1.1.0-win-x64.zip
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$From,
    [switch]$SkipBackup,
    [switch]$Force,
    [string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'),
    [string]$LogPath,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'upgrade' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin

$armed = $false
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('youheal-up-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    $state = Get-YHState -DataDir $DataDir
    $envFile = Join-Path $DataDir 'config\youheal.env'
    $stateFile = Join-Path $DataDir 'config\install.state.json'
    $svcName = $state.ServiceName
    $current = Join-Path $state.Prefix 'current'
    $oldRelease = (Get-Item -LiteralPath $current).Target
    if ($oldRelease -is [array]) { $oldRelease = $oldRelease[0] }
    $oldVersion = $state.Version

    # ---- 1. preflight ----------------------------------------------------------------------------
    $bundleDir = $null
    if (Test-Path -LiteralPath $From -PathType Leaf) {
        Expand-Archive -LiteralPath $From -DestinationPath (Join-Path $tmp 'new') -Force
        $From = (Get-ChildItem -LiteralPath (Join-Path $tmp 'new') -Directory | Select-Object -First 1).FullName
    }
    if (-not (Test-Path -LiteralPath $From -PathType Container)) { throw "-From $From not found" }
    $From = (Resolve-Path -LiteralPath $From).Path
    if (Test-Path -LiteralPath (Join-Path $From 'BUNDLE.json')) { $bundleDir = $From; Test-YHBundle -BundleDir $bundleDir; $newSrc = Join-Path $From 'app' } else { $newSrc = $From }
    $newInstaller = Join-Path $newSrc 'deploy\windows\Install-YouHeal.ps1'
    if (-not (Test-Path -LiteralPath (Join-Path $newSrc 'package.json')) -or -not (Test-Path -LiteralPath $newInstaller)) { throw "$newSrc is not a YOU HEAL Clinical release" }
    $pkg = Get-Content -LiteralPath (Join-Path $newSrc 'package.json') -Raw | ConvertFrom-Json
    $newVersion = [string]$pkg.version
    $needNode = $null
    if ($pkg.PSObject.Properties.Name -contains 'engines' -and $pkg.engines.PSObject.Properties.Name -contains 'node' -and $pkg.engines.node -match '(\d+\.\d+(\.\d+)?)') { $needNode = [version]$Matches[1] }
    $curNode = Get-YHNodeVersion -NodeExe $state.NodeExe
    Write-YHLog "upgrade plan: $oldVersion ($oldRelease) -> $newVersion ($newSrc); node $curNode, required >= $needNode"
    if (-not $Force -and -not $DryRun) {
        $answer = Read-Host "Upgrade YOU HEAL Clinical on $env:COMPUTERNAME from $oldVersion to $newVersion? The service will be briefly stopped. Type YES"
        if ($answer -ne 'YES') { throw 'aborted by operator' }
    }

    # NEW-4: this release rejects unknown Host headers unless listed in YH_ALLOWED_HOSTS.
    function Test-HostConfig {
        $e = Read-YHEnvFile -Path $envFile
        $h = if ($e.Contains('YH_HOST')) { $e['YH_HOST'] } else { '0.0.0.0' }
        if ($h -match '^(127\.|localhost$|::1$)') { return }
        $a = if ($e.Contains('YH_ALLOWED_HOSTS')) { $e['YH_ALLOWED_HOSTS'] } else { '' }
        $o = if ($e.Contains('YH_PUBLIC_ORIGIN')) { $e['YH_PUBLIC_ORIGIN'] } else { '' }
        if (-not $a -and -not $o) {
            Write-YHLog "YH_ALLOWED_HOSTS and YH_PUBLIC_ORIGIN are both empty on non-loopback bind $h; browsers using other names/IPs will get 'Host not allowed'. Add YH_ALLOWED_HOSTS (docs/OPERATIONS.md section 8)." -Level WARN
        }
    }
    Test-HostConfig

    # ---- 2. backup -------------------------------------------------------------------------------
    $psExe = (Get-Process -Id $PID).Path
    if (-not $SkipBackup) {
        Write-YHLog 'step 2/6: encrypted backup'
        $bk = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $oldRelease 'deploy\windows\Backup-YouHeal.ps1'), '-Keep', '0', '-DataDir', $DataDir)
        if ($DryRun) { $bk += '-DryRun' }
        Invoke-YHNative -FilePath $psExe -ArgumentList $bk -NoDryRun
    } else { Write-YHLog 'step 2/6: backup skipped (-SkipBackup)' -Level WARN }

    # ---- 3. stop + snapshot ----------------------------------------------------------------------
    Write-YHLog 'step 3/6: stop service and snapshot'
    $saved = Join-Path $tmp 'saved'; New-Item -ItemType Directory -Path $saved -Force | Out-Null
    Copy-Item -LiteralPath $envFile, $stateFile -Destination $saved
    $svcXml = Join-Path $state.Prefix "service\$svcName.xml"
    if (Test-Path -LiteralPath $svcXml) { Copy-Item -LiteralPath $svcXml -Destination $saved }
    Assert-YHNoReparsePoint -Path $DataDir
    Invoke-YHServiceControl -Action Stop -Name $svcName
    $snapshot = Join-Path $DataDir ('backups\pre-upgrade-{0}-{1}.zip' -f $oldVersion, [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
    Invoke-YHStep "snapshot db\ -> $snapshot" { Compress-Archive -Path (Join-Path $DataDir 'db') -DestinationPath $snapshot }
    $armed = $true

    # ---- 4. stage via the NEW installer (child process) -------------------------------------------
    Write-YHLog "step 4/6: install release $newVersion"
    $inst = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $newInstaller,
        '-Prefix', $state.Prefix, '-DataDir', $DataDir, '-Source', $newSrc, '-BindHost', $state.BindHost, '-Port', [string]$state.Port,
        '-HostName', $state.HostName, '-NoStart', '-SkipMigrate', '-SkipCatalog', '-KeepReleases', [string]$state.KeepReleases)
    if ($state.TrustProxy) { $inst += '-TrustProxy' }
    if ($state.PublicOrigin) { $inst += @('-PublicOrigin', $state.PublicOrigin) }
    if ($state.PSObject.Properties.Name -contains 'TrustedProxies' -and $state.TrustedProxies) { $inst += @('-TrustedProxies', $state.TrustedProxies) }
    if ($state.PSObject.Properties.Name -contains 'AllowedHosts' -and $state.AllowedHosts) { $inst += @('-AllowedHosts', $state.AllowedHosts) }
    if ($bundleDir) { $inst += @('-OfflineBundle', $bundleDir) }
    if ($needNode -and $curNode -and $curNode -ge $needNode) { $inst += @('-NodeSource', 'System') }
    if ($DryRun) { $inst += '-DryRun' }
    Invoke-YHNative -FilePath $psExe -ArgumentList $inst -NoDryRun
    $state2 = if ($DryRun) { $state } else { Get-YHState -DataDir $DataDir }

    if (-not $DryRun) { Test-HostConfig }

    # ---- 5. migrate + catalog --------------------------------------------------------------------
    Write-YHLog 'step 5/6: migrations + catalog'
    Invoke-YHNodeScript -NodeExe $state2.NodeExe -AppDir $state2.AppDir -EnvFile $envFile -Name 'migrate'
    $catDir = Join-Path $state2.AppDir 'data\catalog'
    if ($DryRun -or (Test-Path -LiteralPath (Join-Path $catDir 'points.json')) -or (Test-Path -LiteralPath (Join-Path $catDir 'manifest.json'))) {
        Invoke-YHNodeScript -NodeExe $state2.NodeExe -AppDir $state2.AppDir -EnvFile $envFile -Name 'catalog:load'
    } else { Write-YHLog 'no catalog JSON in the new release - catalog load skipped' -Level WARN }

    # ---- 6. start + verify -----------------------------------------------------------------------
    Write-YHLog 'step 6/6: start and health check'
    Invoke-YHServiceControl -Action Start -Name $svcName
    if (-not (Test-YHHealth -NodeExe $state2.NodeExe -AppDir $state2.AppDir -EnvFile $envFile -Retries 45)) { throw 'new release failed its health check' }
    $armed = $false
    Write-YHLog "upgraded $oldVersion -> $newVersion" -Level OK
    Invoke-YHStep "remove pre-upgrade snapshot $snapshot (upgrade succeeded)" { Remove-Item -LiteralPath $snapshot -Force }
    Write-YHLog 'the encrypted pre-upgrade backup remains in backups\ for later manual rollback'
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    if ($armed -and -not $DryRun) {
        Write-YHLog "rolling back to $oldVersion ($oldRelease)" -Level WARN
        try {
            Invoke-YHServiceControl -Action Stop -Name $svcName
            if (Test-Path -LiteralPath $current) { [IO.Directory]::Delete($current) }
            New-Item -ItemType Junction -Path $current -Target $oldRelease | Out-Null
            Assert-YHNoReparsePoint -Path $DataDir   # PS 5.1 Remove-Item -Recurse follows junctions
            Remove-Item -LiteralPath (Join-Path $DataDir 'db') -Recurse -Force -ErrorAction SilentlyContinue
            Expand-Archive -LiteralPath $snapshot -DestinationPath $DataDir -Force
            Write-YHLog "pre-upgrade snapshot KEPT for analysis: $snapshot (PHI ciphertext; delete when done)" -Level WARN
            Copy-Item -LiteralPath (Join-Path $saved 'youheal.env') -Destination $envFile -Force
            Copy-Item -LiteralPath (Join-Path $saved 'install.state.json') -Destination $stateFile -Force
            $svcExe = Join-Path $state.Prefix "service\$svcName.exe"
            if (Test-Path -LiteralPath (Join-Path $saved "$svcName.xml")) {
                Copy-Item -LiteralPath (Join-Path $saved "$svcName.xml") -Destination $svcXml -Force
                Invoke-YHNative -FilePath $svcExe -ArgumentList @('uninstall') -AllowedExitCodes @(0, 1)
                Start-Sleep -Seconds 2
                Invoke-YHNative -FilePath $svcExe -ArgumentList @('install')
                Invoke-YHNative -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList @('sidtype', $svcName, 'unrestricted')
                Invoke-YHNative -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList @('config', $svcName, 'obj=', $state.ServiceAccount)
            }
            Set-YHRestrictedAcl -Path $DataDir -ServiceAccount $state.ServiceAccount
            Invoke-YHServiceControl -Action Start -Name $svcName
            if (Test-YHHealth -NodeExe $state.NodeExe -AppDir $current -EnvFile $envFile -Retries 30) {
                Write-YHLog "ROLLED BACK: $oldVersion is running and healthy" -Level WARN
            } else { Write-YHLog 'ROLLBACK INCOMPLETE: service unhealthy. Restore from the encrypted backup (Restore-YouHeal.ps1).' -Level ERROR }
        } catch { Write-YHLog "ROLLBACK FAILED: $($_.Exception.Message)" -Level ERROR }
    }
    exit 1
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
