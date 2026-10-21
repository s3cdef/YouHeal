#Requires -Version 5.1
<#
.SYNOPSIS
    Restore YOU HEAL Clinical from an encrypted backup, with automatic rollback.

.DESCRIPTION
    Verifies the backup (.sha256 sidecar), asks for confirmation, stops the service, snapshots db\ and keys\
    (cold copy, zip), optionally installs a master key (disaster recovery to a new host), runs the
    application restore command (`node --run restore`), applies migrations, starts and health-checks.
    Any failure after the snapshot restores it and restarts the previous state.

.PARAMETER InputFile
    Backup file (*.yhbak).
.PARAMETER MasterKeyPath
    Install this master key first (DR). The previous key is kept under keys\retired\ (decrypt-only).
.PARAMETER NoSafetyBackup
    Skip the pre-restore snapshot (disables rollback; not recommended).
.PARAMETER RestoreArguments
    Extra arguments passed unchanged to the application restore command.
.PARAMETER Force
    Do not ask for confirmation.
.PARAMETER DataDir
    Data root. Default %ProgramData%\YouHeal.
.PARAMETER LogPath
    Log file. Default %ProgramData%\YouHeal\logs\restore-<timestamp>.log.
.PARAMETER DryRun
    Show what would happen.

.EXAMPLE
    .\Restore-YouHeal.ps1 -InputFile D:\backups\youheal-clinic01-20261020T021700Z.yhbak
.EXAMPLE
    .\Restore-YouHeal.ps1 -InputFile E:\youheal.yhbak -MasterKeyPath E:\escrow\master.key -Force
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$InputFile,
    [string]$MasterKeyPath,
    [switch]$NoSafetyBackup,
    [string[]]$RestoreArguments = @(),
    [switch]$Force,
    [string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'),
    [string]$LogPath,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'restore' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin

$snapshot = $null
$armed = $false
try {
    $state = Get-YHState -DataDir $DataDir
    $envFile = Join-Path $DataDir 'config\youheal.env'
    $svc = $state.ServiceName
    if (-not (Test-Path -LiteralPath $InputFile)) { throw "cannot read $InputFile" }
    $InputFile = (Resolve-Path -LiteralPath $InputFile).Path
    if (Test-Path -LiteralPath "$InputFile.sha256") {
        $expected = ((Get-Content -LiteralPath "$InputFile.sha256" -TotalCount 1) -split '\s+')[0]
        Assert-YHSha256 -Path $InputFile -Expected $expected
    } else {
        Write-YHLog "no $InputFile.sha256 sidecar; integrity relies on the application's authenticated decryption" -Level WARN
    }

    if (-not $Force -and -not $DryRun) {
        $answer = Read-Host "This REPLACES the current YOU HEAL Clinical database on $env:COMPUTERNAME. Type YES to continue"
        if ($answer -ne 'YES') { throw 'aborted by operator' }
    }

    Invoke-YHServiceControl -Action Stop -Name $svc
    if (-not $NoSafetyBackup) {
        $snapshot = Join-Path $DataDir ('backups\pre-restore-{0}.zip' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
        Invoke-YHStep "safety snapshot (db\ + keys\) -> $snapshot" {
            Compress-Archive -Path (Join-Path $DataDir 'db'), (Join-Path $DataDir 'keys') -DestinationPath $snapshot -CompressionLevel Optimal
        }
        $armed = $true
    }

    if ($MasterKeyPath) {
        if (-not (Test-YHMasterKeyFile -Path $MasterKeyPath)) { throw "$MasterKeyPath is not base64 of exactly 32 bytes" }
        $env0 = Read-YHEnvFile -Path $envFile
        $keyFile = if ($env0.Contains('YH_MASTER_KEY_FILE')) { $env0['YH_MASTER_KEY_FILE'] } else { Join-Path $DataDir 'keys\master.key' }
        $newKey = (Get-Content -LiteralPath $MasterKeyPath -Raw).Trim()
        if ((Test-Path -LiteralPath $keyFile) -and ((Get-Content -LiteralPath $keyFile -Raw).Trim() -ne $newKey)) {
            Invoke-YHStep 'retire current master key (decrypt-only)' {
                $ret = Join-Path $DataDir 'keys\retired'; New-Item -ItemType Directory -Path $ret -Force | Out-Null
                Copy-Item -LiteralPath $keyFile -Destination (Join-Path $ret ('pre-restore-{0}.key' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')))
            }
        }
        Write-YHTextFile -Path $keyFile -Content ($newKey + "`n")
        Write-YHLog 'master key installed for restore' -Level OK
    }

    $staged = Join-Path $DataDir ('backups\.restore-' + (Split-Path -Leaf $InputFile))
    Invoke-YHStep "stage $InputFile -> $staged" { Copy-Item -LiteralPath $InputFile -Destination $staged -Force }
    Write-YHLog 'running application restore'
    Invoke-YHNodeScript -NodeExe $state.NodeExe -AppDir $state.AppDir -EnvFile $envFile -Name 'restore' -Arguments (@($staged, '--yes') + $RestoreArguments)
    Invoke-YHStep "remove staged copy" { Remove-Item -LiteralPath $staged -Force }
    Write-YHLog 'applying migrations (backup may predate the installed release)'
    Invoke-YHNodeScript -NodeExe $state.NodeExe -AppDir $state.AppDir -EnvFile $envFile -Name 'migrate'

    Invoke-YHServiceControl -Action Start -Name $svc
    if (-not (Test-YHHealth -NodeExe $state.NodeExe -AppDir $state.AppDir -EnvFile $envFile -Retries 30)) { throw 'service unhealthy after restore' }
    $armed = $false
    Write-YHLog 'restore complete. Verify: sign in, open a known patient, and run Audit > Verify chain (GET /api/v1/audit/verify).' -Level OK
    if ($snapshot) { Write-YHLog "pre-restore snapshot retained at $snapshot (PHI + keys; delete once satisfied)" }
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    if ($armed -and $snapshot -and (Test-Path -LiteralPath $snapshot)) {
        Write-YHLog "rolling back to $snapshot" -Level WARN
        try {
            Invoke-YHServiceControl -Action Stop -Name $state.ServiceName
            Remove-Item -LiteralPath (Join-Path $DataDir 'db'), (Join-Path $DataDir 'keys') -Recurse -Force -ErrorAction SilentlyContinue
            Expand-Archive -LiteralPath $snapshot -DestinationPath $DataDir -Force
            Set-YHRestrictedAcl -Path $DataDir -ServiceAccount $state.ServiceAccount
            Invoke-YHServiceControl -Action Start -Name $state.ServiceName
            if (Test-YHHealth -NodeExe $state.NodeExe -AppDir $state.AppDir -EnvFile (Join-Path $DataDir 'config\youheal.env') -Retries 30) {
                Write-YHLog 'rolled back; service healthy on the previous data' -Level WARN
            } else { Write-YHLog 'rollback finished but the service is NOT healthy - see docs/OPERATIONS.md' -Level ERROR }
        } catch { Write-YHLog "ROLLBACK FAILED: $($_.Exception.Message)" -Level ERROR }
    }
    exit 1
}
