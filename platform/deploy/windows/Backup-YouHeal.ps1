#Requires -Version 5.1
<#
.SYNOPSIS
    Create an encrypted YOU HEAL Clinical backup, apply retention, optionally copy offsite and schedule it.

.DESCRIPTION
    Wraps the application's backup command (`node --run backup`), which writes an AES-256-GCM encrypted
    archive keyed from the master key (CP-9, SC-28). Adds a predictable name, a .sha256 sidecar, retention,
    a verified second copy (-CopyTo, e.g. a NAS share or removable drive) and a daily Scheduled Task.

    The master key is deliberately NOT inside the backup. Escrow it separately (docs/OPERATIONS.md).

.PARAMETER OutDir
    Backup directory. Default: <DataDir>\backups (ACL-restricted).
.PARAMETER Keep
    Keep the N newest backups in OutDir and CopyTo. 0 keeps all. Default 14.
.PARAMETER CopyTo
    Also copy backup + .sha256 to this directory and verify the copy.
.PARAMETER InstallSchedule
    Register the Scheduled Task "YOU HEAL Clinical Backup" (daily at -At, runs as SYSTEM) with the same
    -Keep/-CopyTo/-OutDir, then exit.
.PARAMETER At
    Daily time for -InstallSchedule (HH:mm). Default 02:17.
.PARAMETER RemoveSchedule
    Remove the Scheduled Task, then exit.
.PARAMETER BackupArguments
    Extra arguments passed unchanged to the application backup command.
.PARAMETER DataDir
    Data root holding config\install.state.json. Default %ProgramData%\YouHeal.
.PARAMETER LogPath
    Log file. Default %ProgramData%\YouHeal\logs\backup-<timestamp>.log.
.PARAMETER DryRun
    Show what would happen.

.EXAMPLE
    .\Backup-YouHeal.ps1 -Keep 30 -CopyTo \\nas\youheal-backups
.EXAMPLE
    .\Backup-YouHeal.ps1 -InstallSchedule -At 02:17 -Keep 30 -CopyTo E:\YouHealBackups
#>
[CmdletBinding()]
param(
    [string]$OutDir,
    [ValidateRange(0, 10000)][int]$Keep = 14,
    [string]$CopyTo,
    [switch]$InstallSchedule,
    [ValidatePattern('^\d{2}:\d{2}$')][string]$At = '02:17',
    [switch]$RemoveSchedule,
    [string[]]$BackupArguments = @(),
    [string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'),
    [string]$LogPath,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'backup' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin

$TaskName = 'YOU HEAL Clinical Backup'
try {
    $state = Get-YHState -DataDir $DataDir
    $envFile = Join-Path $DataDir 'config\youheal.env'
    if (-not $OutDir) { $OutDir = Join-Path $DataDir 'backups' }

    if ($RemoveSchedule) {
        Invoke-YHStep "unregister scheduled task '$TaskName'" { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue }
        Write-YHLog 'backup schedule removed' -Level OK
        exit 0
    }
    if ($InstallSchedule) {
        $self = Join-Path $state.AppDir 'deploy\windows\Backup-YouHeal.ps1'
        $hostExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $arg = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Keep {1} -OutDir "{2}" -DataDir "{3}"' -f $self, $Keep, $OutDir, $DataDir
        if ($CopyTo) { $arg += (' -CopyTo "{0}"' -f $CopyTo) }
        Invoke-YHStep "register scheduled task '$TaskName' daily at $At as SYSTEM: $hostExe $arg" {
            $action = New-ScheduledTaskAction -Execute $hostExe -Argument $arg
            $trigger = New-ScheduledTaskTrigger -Daily -At $At
            $principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
            Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
                -Description 'Encrypted backup of YOU HEAL Clinical (deploy/windows/Backup-YouHeal.ps1)' -Force | Out-Null
        }
        Write-YHLog "backup scheduled daily at $At (task '$TaskName')" -Level OK
        exit 0
    }

    if (-not (Test-Path -LiteralPath $OutDir)) {
        Invoke-YHStep "mkdir $OutDir (restricted ACL)" { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
        Set-YHRestrictedAcl -Path $OutDir -ServiceAccount $state.ServiceAccount
    }
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
    $file = Join-Path $OutDir ('youheal-{0}-{1}.yhbak' -f $env:COMPUTERNAME.ToLowerInvariant(), $stamp)
    $start = Get-Date
    Write-YHLog "creating encrypted backup -> $file"
    Invoke-YHNodeScript -NodeExe $state.NodeExe -AppDir $state.AppDir -EnvFile $envFile -Name 'backup' -Arguments (@('--out', $file) + $BackupArguments)

    if (-not $DryRun) {
        if (-not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) {
            # Fallback: the app wrote to its default directory and ignored --out.
            $newest = Get-ChildItem -LiteralPath (Join-Path $DataDir 'backups'), $OutDir -File -ErrorAction SilentlyContinue |
                Where-Object { $_.LastWriteTime -ge $start -and $_.Extension -ne '.sha256' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
            if (-not $newest) { throw 'backup command finished but produced no file' }
            Move-Item -LiteralPath $newest.FullName -Destination $file -Force
        }
        $sum = Get-YHSha256 -Path $file
        Set-Content -LiteralPath "$file.sha256" -Encoding ASCII -Value ('{0}  {1}' -f $sum.ToLowerInvariant(), (Split-Path -Leaf $file))
        Write-YHLog ("backup written: {0} ({1:N0} bytes, sha256 {2})" -f $file, (Get-Item -LiteralPath $file).Length, $sum) -Level OK
    }
    Write-YHLog 'verifying backup (GCM authentication tag) with the application'
    Invoke-YHNodeScript -NodeExe $state.NodeExe -AppDir $state.AppDir -EnvFile $envFile -Name 'backup' -Arguments @('--verify', $file)

    if ($CopyTo) {
        Invoke-YHStep "copy to $CopyTo" {
            if (-not (Test-Path -LiteralPath $CopyTo)) { New-Item -ItemType Directory -Path $CopyTo -Force | Out-Null }
            Copy-Item -LiteralPath $file, "$file.sha256" -Destination $CopyTo -Force
            $copy = Join-Path $CopyTo (Split-Path -Leaf $file)
            if ((Get-YHSha256 -Path $copy) -ne $sum) { throw "copy verification failed in $CopyTo" }
        }
        Write-YHLog "verified copy in $CopyTo" -Level OK
    }

    function Invoke-Rotation([string]$Dir) {
        if ($Keep -le 0 -or -not (Test-Path -LiteralPath $Dir)) { return }
        Get-ChildItem -LiteralPath $Dir -Filter 'youheal-*.yhbak' -File | Sort-Object Name -Descending | Select-Object -Skip $Keep | ForEach-Object {
            $f = $_.FullName
            Invoke-YHStep "rotate out $f" { Remove-Item -LiteralPath $f, "$f.sha256" -Force -ErrorAction SilentlyContinue }
        }
    }
    Invoke-Rotation $OutDir
    if ($CopyTo) { Invoke-Rotation $CopyTo }
    Write-YHLog "backup complete (retention $Keep)" -Level OK
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    exit 1
}
