<#
.SYNOPSIS
  Starts a YOU HEAL Clinical iPad/tablet TEST instance on this Windows PC (fictitious data only).
.DESCRIPTION
  Runs tools/ipad-test.mjs as the current user. With -OpenFirewall the script self-elevates ONLY to add
  Windows Firewall rules for the test ports (Private profile), then continues unelevated. Execution policy is
  bypassed for this process only. LAN mode needs openssl (installed with Git for Windows); otherwise use
  -Mode tailscale.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\deploy\windows\Start-YouHealIPadTest.ps1 -OpenFirewall
.EXAMPLE
  .\deploy\windows\Start-YouHealIPadTest.ps1 -Mode tailscale
#>
[CmdletBinding()]
param(
  [ValidateSet('lan', 'tailscale')][string]$Mode = 'lan',
  [ValidateRange(1024, 65535)][int]$Port = 8443,
  [ValidateRange(1024, 65535)][int]$CaPort = 8099,
  [switch]$OpenFirewall,
  [switch]$Reset,
  [switch]$FirewallOnly   # internal: used by the elevated child process
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force

function Test-IsAdmin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}
function Add-YHTestFirewallRule {
  foreach ($p in @($Port, $CaPort)) {
    $name = "YOU HEAL iPad test TCP $p"
    if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
      New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow -Profile Private | Out-Null
    }
  }
  Write-Information -InformationAction Continue "[ipad-test] firewall: inbound TCP $Port and $CaPort allowed on Private networks (remove with: Get-NetFirewallRule -DisplayName 'YOU HEAL iPad test*' | Remove-NetFirewallRule)"
}

if ($FirewallOnly) { Add-YHTestFirewallRule; return }

if ($OpenFirewall -and $Mode -eq 'lan') {
  if (Test-IsAdmin) { Add-YHTestFirewallRule }
  else {
    $exe = (Get-Process -Id $PID).Path
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-FirewallOnly', '-Port', $Port, '-CaPort', $CaPort)
    $p = Start-Process -FilePath $exe -ArgumentList $argList -Verb RunAs -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "elevated firewall step failed (exit $($p.ExitCode))" }
  }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js >= 22.13 is required (https://nodejs.org).' }
if ($Mode -eq 'lan' -and -not (Get-Command openssl -ErrorAction SilentlyContinue)) {
  $gitSsl = Join-Path ${env:ProgramFiles} 'Git\usr\bin'
  if (Test-Path (Join-Path $gitSsl 'openssl.exe')) { $env:PATH = "$gitSsl;$env:PATH" }
  else { throw 'openssl not found: install Git for Windows, or run with -Mode tailscale.' }
}
$app = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$cli = @((Join-Path $app 'tools\ipad-test.mjs'), '--mode', $Mode, '--port', $Port, '--ca-port', $CaPort)
if ($Reset) { $cli += '--reset' }
& $node.Source @cli
exit $LASTEXITCODE
