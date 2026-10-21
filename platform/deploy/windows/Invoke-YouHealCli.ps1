#Requires -Version 5.1
<#
.SYNOPSIS
    Run a YOU HEAL Clinical maintenance command (package.json script) with the installed configuration.

.DESCRIPTION
    Loads %ProgramData%\YouHeal\config\youheal.env into the process environment and runs
    `node --run <Script> -- <Arguments>` in the installed application directory, as Administrator.
    Typical scripts: create-admin, rotate-key, migrate, catalog:load.

.PARAMETER Script
    package.json script name, e.g. create-admin.
.PARAMETER Arguments
    Extra arguments passed to the script after `--`.
.PARAMETER DataDir
    Data root holding config\install.state.json. Default %ProgramData%\YouHeal.
.PARAMETER LogPath
    Log file. Default %ProgramData%\YouHeal\logs\cli-<timestamp>.log.
.PARAMETER DryRun
    Show the command without running it.

.EXAMPLE
    .\Invoke-YouHealCli.ps1 create-admin
.EXAMPLE
    .\Invoke-YouHealCli.ps1 rotate-key
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)][ValidatePattern('^[a-z][a-z0-9:-]*$')][string]$Script,
    [Parameter(Position = 1, ValueFromRemainingArguments)][string[]]$Arguments = @(),
    [string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'),
    [string]$LogPath,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'cli' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin

try {
    $state = Get-YHState -DataDir $DataDir
    $envFile = Join-Path $DataDir 'config\youheal.env'
    Write-YHLog "running '$Script' in $($state.AppDir)"
    # Interactive scripts (create-admin prompts for a password) need the console, so do not capture output.
    $parsed = Read-YHEnvFile -Path $envFile
    if ($DryRun) { Write-YHLog "$($state.NodeExe) --run $Script $(if ($Arguments.Count) { '-- ' + ($Arguments -join ' ') })" -Level DRY; exit 0 }
    foreach ($k in $parsed.Keys) { [Environment]::SetEnvironmentVariable($k, [string]$parsed[$k], 'Process') }
    Push-Location -LiteralPath $state.AppDir
    try {
        $argv = @('--run', $Script)
        if ($Arguments.Count) { $argv += '--'; $argv += $Arguments }
        & $state.NodeExe @argv
        $code = $LASTEXITCODE
    } finally { Pop-Location }
    Write-YHLog "'$Script' exited with $code" -Level $(if ($code -eq 0) { 'OK' } else { 'ERROR' })
    exit $code
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    exit 1
}
