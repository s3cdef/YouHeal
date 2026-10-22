#Requires -Version 5.1
<#
.SYNOPSIS
    Authenticode-sign the YOU HEAL Clinical PowerShell scripts with a code-signing certificate from the store.

.DESCRIPTION
    Production hosts should run these scripts under the AllSigned execution policy, enforced by Group Policy
    (Computer Configuration > Administrative Templates > Windows Components > Windows PowerShell >
    Turn on Script Execution = "Allow only signed scripts"), instead of relying on the process-scope
    Bypass the scripts apply for convenience. This script signs every *.ps1 / *.psm1 / *.psd1 under -Path
    with the certificate identified by -Thumbprint, RFC 3161 timestamps the signature (so it stays valid
    after the certificate expires), and verifies the result.

    Order of operations for a release: sign -> build the offline bundle (checksums are computed over the
    signed files) -> sign/attest the bundle checksums (see deploy/offline SIGNATURES.md).

    Requirements: a certificate with the Code Signing EKU (1.3.6.1.5.5.7.3.3) and its private key in
    Cert:\CurrentUser\My or Cert:\LocalMachine\My (an HSM/smart-card backed key is recommended); the issuing
    CA chain must be trusted on target hosts, and the signer certificate must be in "Trusted Publishers"
    there to avoid prompts under AllSigned.

.PARAMETER Thumbprint
    SHA-1 thumbprint of the code-signing certificate (spaces allowed).
.PARAMETER StoreLocation
    CurrentUser (default) or LocalMachine.
.PARAMETER Path
    Directories (or files) to sign. Default: the deploy\windows and deploy\offline folders next to this script.
.PARAMETER TimestampServer
    RFC 3161 timestamp URL. Default http://timestamp.digicert.com (empty string disables timestamping).
.PARAMETER HashAlgorithm
    SHA256 (default), SHA384 or SHA512.
.PARAMETER LogPath
    Log file. Default %TEMP%\YouHeal\sign-<timestamp>.log.
.PARAMETER DryRun
    List the files that would be signed and validate the certificate only.

.EXAMPLE
    .\Sign-Scripts.ps1 -Thumbprint 'AB12 CD34 ...'
.EXAMPLE
    .\Sign-Scripts.ps1 -Thumbprint AB12CD34... -StoreLocation LocalMachine -TimestampServer http://timestamp.sectigo.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Thumbprint,
    [ValidateSet('CurrentUser', 'LocalMachine')][string]$StoreLocation = 'CurrentUser',
    [string[]]$Path = @($PSScriptRoot, (Join-Path (Split-Path -Parent $PSScriptRoot) 'offline')),
    [string]$TimestampServer = 'http://timestamp.digicert.com',
    [ValidateSet('SHA256', 'SHA384', 'SHA512')][string]$HashAlgorithm = 'SHA256',
    [string]$LogPath = (Join-Path $env:TEMP ('YouHeal\sign-{0}.log' -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))),
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
# Signing needs the private key of the chosen store, not admin rights (LocalMachine keys may need elevation).
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'sign' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin:($StoreLocation -eq 'LocalMachine')

try {
    $tp = ($Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    if ($tp.Length -ne 40) { throw "Thumbprint must be 40 hex characters (got $($tp.Length))" }
    $cert = Get-Item -LiteralPath ("Cert:\{0}\My\{1}" -f $StoreLocation, $tp) -ErrorAction SilentlyContinue
    if (-not $cert) { throw "certificate $tp not found in Cert:\$StoreLocation\My" }
    if (-not $cert.HasPrivateKey) { throw "certificate $tp has no accessible private key" }
    $eku = @($cert.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId })
    if ($eku -notcontains '1.3.6.1.5.5.7.3.3') { throw "certificate $tp lacks the Code Signing EKU (1.3.6.1.5.5.7.3.3)" }
    if ($cert.NotAfter -lt (Get-Date)) { throw "certificate $tp expired on $($cert.NotAfter)" }
    if ($cert.NotAfter -lt (Get-Date).AddDays(30)) { Write-YHLog "certificate expires $($cert.NotAfter); renew soon" -Level WARN }
    Write-YHLog "signing certificate: $($cert.Subject) (issuer $($cert.Issuer), expires $($cert.NotAfter.ToString('yyyy-MM-dd')))" -Level OK

    $files = foreach ($p in $Path) {
        if (Test-Path -LiteralPath $p -PathType Container) { Get-ChildItem -LiteralPath $p -Recurse -File -Include '*.ps1', '*.psm1', '*.psd1' }
        elseif (Test-Path -LiteralPath $p -PathType Leaf) { Get-Item -LiteralPath $p }
        else { Write-YHLog "path not found: $p" -Level WARN }
    }
    $files = @($files | Sort-Object FullName -Unique)
    if (-not $files.Count) { throw 'no PowerShell files found to sign' }

    $failed = 0
    foreach ($f in $files) {
        if ($DryRun) { Write-YHLog "sign $($f.FullName)" -Level DRY; continue }
        $params = @{ FilePath = $f.FullName; Certificate = $cert; HashAlgorithm = $HashAlgorithm; IncludeChain = 'NotRoot' }
        if ($TimestampServer) { $params.TimestampServer = $TimestampServer }
        $null = Set-AuthenticodeSignature @params
        $sig = Get-AuthenticodeSignature -FilePath $f.FullName
        if ($sig.Status -eq 'Valid') { Write-YHLog "signed  $($f.FullName)" -Level OK }
        else { Write-YHLog "FAILED  $($f.FullName): $($sig.Status) $($sig.StatusMessage)" -Level ERROR; $failed++ }
    }
    if ($failed) { throw "$failed file(s) failed signature verification" }
    Write-YHLog "$($files.Count) file(s) $(if ($DryRun) { 'would be signed' } else { 'signed and verified' })" -Level OK
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    exit 1
}
