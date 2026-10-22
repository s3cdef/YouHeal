#Requires -Version 5.1
<#
.SYNOPSIS
    Remove YOU HEAL Clinical from this Windows host. Data is kept unless -Purge is given.

.DESCRIPTION
    Default: stops and deletes the service, removes the firewall rule, the backup Scheduled Task and the
    application under <Prefix>; keeps <DataDir> (database, master key, TLS, backups, config) for reinstall.

    -Purge additionally CRYPTO-ERASES and deletes the data: the master key and every retired key are
    overwritten with random bytes and deleted FIRST - which makes every PHI ciphertext and every encrypted
    backup (including offsite copies) undecryptable (NIST SP 800-88 Rev. 1 cryptographic erase) - and then
    <DataDir> is removed. Escrowed key copies must be destroyed separately. Requires typing a confirmation
    phrase unless -Force.

    Node.js (installed machine-wide by MSI) is left in place; remove it from Apps & Features if unused.

.PARAMETER Purge
    Crypto-erase and delete all data.
.PARAMETER Force
    Skip confirmations (automation only).
.PARAMETER DataDir
    Data root. Default %ProgramData%\YouHeal.
.PARAMETER LogPath
    Log file. Default: %TEMP%\YouHeal\uninstall-<timestamp>.log (the data dir may be deleted).
.PARAMETER DryRun
    Show what would happen.

.EXAMPLE
    .\Uninstall-YouHeal.ps1
.EXAMPLE
    .\Uninstall-YouHeal.ps1 -Purge
#>
[CmdletBinding()]
param(
    [switch]$Purge,
    [switch]$Force,
    [string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'),
    [string]$LogPath = (Join-Path $env:TEMP ('YouHeal\uninstall-{0}.log' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))),
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'uninstall' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin

try {
    $state = Get-YHState -DataDir $DataDir
    $prefix = [string]$state.Prefix
    foreach ($p in @($prefix, $DataDir)) {
        if (-not $p -or $p.TrimEnd('\') -in @($env:SystemDrive, $env:SystemRoot, $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:ProgramData, $env:USERPROFILE)) {
            throw "refusing to operate on suspicious path '$p' from install.state.json"
        }
    }
    Write-YHLog ("plan: remove service {0}, app {1}, firewall rule {2}, backup task; data {3} -> {4}" -f $state.ServiceName, $prefix,
        $(if ($state.FirewallRule) { $state.FirewallRule } else { 'none' }), $DataDir, $(if ($Purge) { 'CRYPTO-ERASE + DELETE' } else { 'KEPT' }))

    if (-not $DryRun -and -not $Force) {
        if ($Purge) {
            $phrase = "PURGE $env:COMPUTERNAME"
            Write-YHLog '-Purge permanently destroys ALL patient data on this host and makes every backup undecryptable.' -Level WARN
            if ((Read-Host "Type '$phrase' to continue") -ne $phrase) { throw 'confirmation phrase did not match; nothing was changed' }
        } elseif ((Read-Host "Uninstall YOU HEAL Clinical (data in $DataDir is kept)? Type YES") -ne 'YES') { throw 'aborted by operator' }
    }

    # Service
    $svcExe = Join-Path $prefix ("service\{0}.exe" -f $state.ServiceName)
    if (Get-Service -Name $state.ServiceName -ErrorAction SilentlyContinue) {
        Invoke-YHServiceControl -Action Stop -Name $state.ServiceName
        if (Test-Path -LiteralPath $svcExe) { Invoke-YHNative -FilePath $svcExe -ArgumentList @('uninstall') }
        else { Invoke-YHNative -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList @('delete', $state.ServiceName) }
        Write-YHLog 'service removed' -Level OK
    }
    # Firewall + schedule
    if ($state.FirewallRule) { Invoke-YHStep "remove firewall rule $($state.FirewallRule)" { Get-NetFirewallRule -Name $state.FirewallRule -ErrorAction SilentlyContinue | Remove-NetFirewallRule } }
    Invoke-YHStep 'remove backup scheduled task' { Unregister-ScheduledTask -TaskName 'YOU HEAL Clinical Backup' -Confirm:$false -ErrorAction SilentlyContinue }
    # Application
    if (Test-Path -LiteralPath $prefix) {
        Invoke-YHStep "remove $prefix" {
            $cur = Join-Path $prefix 'current'
            if (Test-Path -LiteralPath $cur) { [IO.Directory]::Delete($cur) }   # junction first, never its target
            Remove-Item -LiteralPath $prefix -Recurse -Force
        }
        Write-YHLog "application removed ($prefix)" -Level OK
    }

    if ($Purge) {
        # Never overwrite or recursively delete through a junction planted by the service account (F-03;
        # Windows PowerShell 5.1 Remove-Item -Recurse and Get-ChildItem -Recurse follow junctions).
        if (-not $DryRun) { Assert-YHNoReparsePoint -Path $DataDir }
        Write-YHLog 'crypto-erase: destroying master and retired keys'
        $envMap = Read-YHEnvFile -Path (Join-Path $DataDir 'config\youheal.env')
        $keyFiles = @(Get-ChildItem -LiteralPath (Join-Path $DataDir 'keys') -Recurse -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
        if ($envMap.Contains('YH_MASTER_KEY_FILE') -and (Test-Path -LiteralPath $envMap['YH_MASTER_KEY_FILE'])) { $keyFiles += $envMap['YH_MASTER_KEY_FILE'] }
        foreach ($k in ($keyFiles | Select-Object -Unique)) {
            Invoke-YHStep "overwrite + delete $k" {
                $len = [Math]::Max(64, (Get-Item -LiteralPath $k).Length)
                $buf = New-Object byte[] $len
                $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
                try {
                    for ($i = 0; $i -lt 3; $i++) {
                        $rng.GetBytes($buf)
                        $fs = [IO.File]::Open($k, 'Open', 'Write', 'None')
                        try { $fs.Write($buf, 0, $len); $fs.Flush($true) } finally { $fs.Dispose() }
                    }
                } finally { $rng.Dispose() }
                Remove-Item -LiteralPath $k -Force
            }
        }
        Write-YHLog 'keys destroyed - remaining ciphertext (db, backups, offsite copies) is now undecryptable' -Level OK
        Invoke-YHStep "remove $DataDir" { Remove-Item -LiteralPath $DataDir -Recurse -Force }
        Write-YHLog 'SSDs and volume shadow copies may retain old blocks; crypto-erase is what protects them. Destroy ALL escrowed key copies, delete VSS snapshots (vssadmin) and record the sanitization (MP-6).' -Level WARN
    } else {
        Write-YHLog "data kept in $DataDir. Reinstall with Install-YouHeal.ps1 -DataDir `"$DataDir`"." -Level OK
    }
    Write-YHLog "uninstall complete. Log: $(Get-YHLogPath)" -Level OK
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    exit 1
}
