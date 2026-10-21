#Requires -Version 5.1
<#
.SYNOPSIS
    Shared helpers for the YOU HEAL Clinical Windows deployment scripts.

.DESCRIPTION
    Imported by Install-, Uninstall-, Backup-, Restore- and Upgrade-YouHeal.ps1. Provides:
      * process-scope execution policy bypass (never machine-wide) and self-elevation (UAC, RunAs)
      * logging to console + file, dry-run aware step execution
      * native command invocation that is safe under $ErrorActionPreference = 'Stop' on PS 5.1
      * architecture detection, HTTPS download, SHA-256 verification
      * env-file + install-state handling, ACL hardening (SID based, locale independent)
      * self-signed certificate generation with PEM export on Windows PowerShell 5.1 and PowerShell 7+
      * health probe via deploy/common/healthcheck.mjs

    This file is intentionally pure ASCII: Windows PowerShell 5.1 decodes BOM-less files with the
    ANSI code page, and UTF-8 punctuation would be mis-decoded (some bytes map to quote characters).

.NOTES
    Works on Windows PowerShell 5.1 and PowerShell 7+ (Windows only).
#>

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:YHDryRun = $false
$script:YHLogPath = $null
$script:YHProduct = 'YOU HEAL Clinical'
$script:YHNodeMin = [version]'22.13.0'

# WinSW v2.12.0 (MIT, https://github.com/winsw/winsw). The .NET Framework 4.6.1 build runs on x64, x86
# and ARM64 Windows 10 / Server 2016+ (which ship .NET Framework >= 4.6.2). Hash pinned at authoring
# time from the release asset; update both together.
$script:YHWinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe'
$script:YHWinSWSha256 = 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F'

# Well-known SIDs (locale independent; "Administrators" is localized on non-English Windows).
$script:SidSystem = 'S-1-5-18'
$script:SidAdmins = 'S-1-5-32-544'

function Get-YHNodeMin { $script:YHNodeMin }
function Get-YHWinSWInfo { [pscustomobject]@{ Url = $script:YHWinSWUrl; Sha256 = $script:YHWinSWSha256 } }
function Test-YHDryRun { $script:YHDryRun }

# ------------------------------------------------------------------------------------------------
# Logging
# ------------------------------------------------------------------------------------------------
function Write-YHLog {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory, Position = 0)][AllowEmptyString()][string]$Message,
        [ValidateSet('INFO', 'OK', 'WARN', 'ERROR', 'DRY', 'DEBUG')][string]$Level = 'INFO'
    )
    $line = '{0} {1,-5} {2}' -f ([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')), $Level, $Message
    switch ($Level) {
        'ERROR' { Write-Host $line -ForegroundColor Red }
        'WARN' { Write-Host $line -ForegroundColor Yellow }
        'OK' { Write-Host $line -ForegroundColor Green }
        'DRY' { Write-Host $line -ForegroundColor Cyan }
        'DEBUG' { Write-Verbose $line }
        default { Write-Host $line }
    }
    if ($script:YHLogPath) {
        try { Add-Content -LiteralPath $script:YHLogPath -Value $line -Encoding UTF8 } catch { Write-Verbose 'log file not writable' }
    }
}

function Get-YHLogPath { $script:YHLogPath }

# ------------------------------------------------------------------------------------------------
# Elevation / execution policy / initialization
# ------------------------------------------------------------------------------------------------
function Test-YHAdmin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$id).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function ConvertTo-YHLiteral {
    # Render a bound parameter value as PowerShell source (single-quoted literals; arrays as @()).
    param([AllowNull()]$Value)
    if ($null -eq $Value) { return '$null' }
    if ($Value -is [System.Management.Automation.SwitchParameter]) { if ($Value.IsPresent) { return '$true' } else { return '$false' } }
    if ($Value -is [bool]) { if ($Value) { return '$true' } else { return '$false' } }
    if ($Value -is [int] -or $Value -is [long] -or $Value -is [double]) { return [string]$Value }
    if ($Value -is [System.Array]) { return '@(' + (($Value | ForEach-Object { ConvertTo-YHLiteral $_ }) -join ',') + ')' }
    return "'" + ([string]$Value).Replace("'", "''") + "'"
}

function Initialize-YHScript {
    <#
    .SYNOPSIS
        Strict mode, process-scope execution policy bypass, self-elevation and logging for a script.
    .PARAMETER ScriptPath
        $PSCommandPath of the calling script (re-launched elevated when needed).
    .PARAMETER BoundParameters
        $PSBoundParameters of the calling script (re-passed verbatim, with types, to the elevated copy).
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$ScriptPath,
        [Parameter(Mandatory)][hashtable]$BoundParameters,
        [Parameter(Mandatory)][string]$LogName,
        [string]$LogPath,
        [switch]$DryRun,
        [switch]$RequireAdmin
    )
    if ($env:OS -ne 'Windows_NT') { throw "$script:YHProduct Windows scripts must run on Windows. Use deploy/linux/*.sh elsewhere." }

    # Execution policy: bypass for THIS PROCESS ONLY so the companion module/scripts load.
    # Never touches LocalMachine/CurrentUser scope. A Group Policy (MachinePolicy/UserPolicy) still wins;
    # in that case sign the scripts (Sign-Scripts.ps1) and run under AllSigned.
    try {
        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop
    } catch {
        Write-Warning ("Process-scope execution policy could not be set (Group Policy override?): {0}" -f $_.Exception.Message)
    }

    # TLS 1.2+ for Invoke-WebRequest on Windows PowerShell 5.1 (.NET Framework defaults can be older).
    try {
        $proto = [Net.SecurityProtocolType]::Tls12
        if ([enum]::GetNames([Net.SecurityProtocolType]) -contains 'Tls13') { $proto = $proto -bor [Net.SecurityProtocolType]::Tls13 }
        [Net.ServicePointManager]::SecurityProtocol = $proto
    } catch { Write-Verbose 'TLS protocol defaults unchanged' }

    $script:YHDryRun = [bool]$DryRun
    if (-not $LogPath) {
        $base = Join-Path $env:ProgramData 'YouHeal'
        $dir = Join-Path $base 'logs'
        if (-not (Test-YHAdmin) -or $DryRun) { $dir = Join-Path $env:TEMP 'YouHeal' }
        $LogPath = Join-Path $dir ('{0}-{1}.log' -f $LogName, [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
    }

    if ($RequireAdmin -and -not (Test-YHAdmin)) {
        if ($DryRun) {
            Write-Warning 'Not elevated; continuing because -DryRun makes no changes.'
        } else {
            $exe = (Get-Process -Id $PID).Path
            $bound = @{}
            foreach ($k in $BoundParameters.Keys) { $bound[$k] = $BoundParameters[$k] }
            $bound['LogPath'] = $LogPath
            $parts = foreach ($k in $bound.Keys) { '-{0}:{1}' -f $k, (ConvertTo-YHLiteral $bound[$k]) }
            $cmd = "& '{0}' {1}; exit `$LASTEXITCODE" -f $ScriptPath.Replace("'", "''"), ($parts -join ' ')
            $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($cmd))
            Write-Host "[$script:YHProduct] Administrator rights are required. Windows will show a UAC prompt..." -ForegroundColor Yellow
            try {
                $p = Start-Process -FilePath $exe -Verb RunAs -Wait -PassThru `
                    -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded)
            } catch {
                throw "Elevation was cancelled or failed: $($_.Exception.Message)"
            }
            Write-Host ("Elevated run finished with exit code {0}. Log: {1}" -f $p.ExitCode, $LogPath)
            if (Test-Path -LiteralPath $LogPath) { Get-Content -LiteralPath $LogPath -Tail 25 | ForEach-Object { Write-Host "  | $_" } }
            exit $p.ExitCode
        }
    }

    $logDir = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    $script:YHLogPath = $LogPath
    Write-YHLog ("----- {0} (PS {1} {2}, pid {3}, admin={4}, dry-run={5}) -----" -f (Split-Path -Leaf $ScriptPath),
        $PSVersionTable.PSVersion, $PSVersionTable.PSEdition, $PID, (Test-YHAdmin), [bool]$DryRun)
}

# ------------------------------------------------------------------------------------------------
# Execution helpers
# ------------------------------------------------------------------------------------------------
function Invoke-YHStep {
    <# Run a script block unless in dry-run mode, logging the description either way. #>
    param([Parameter(Mandatory)][string]$Description, [Parameter(Mandatory)][scriptblock]$Action)
    if ($script:YHDryRun) { Write-YHLog $Description -Level DRY; return }
    Write-YHLog $Description -Level DEBUG
    & $Action
}

function Invoke-YHNative {
    <#
    .SYNOPSIS
        Run a native executable, stream its output to the log, and throw on an unexpected exit code.
        Locally relaxes $ErrorActionPreference: on PS 5.1, stderr from a native command under 'Stop'
        becomes a terminating NativeCommandError even when the command succeeds.
    #>
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$ArgumentList = @(),
        [int[]]$AllowedExitCodes = @(0),
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory,
        [switch]$NoDryRun,
        [switch]$PassThruOutput
    )
    $display = '{0} {1}' -f $FilePath, ($ArgumentList -join ' ')
    if ($script:YHDryRun -and -not $NoDryRun) { Write-YHLog $display -Level DRY; return }
    Write-YHLog "exec: $display" -Level DEBUG
    $saved = @{}
    foreach ($k in $Environment.Keys) { $saved[$k] = [Environment]::GetEnvironmentVariable($k, 'Process'); [Environment]::SetEnvironmentVariable($k, [string]$Environment[$k], 'Process') }
    $oldLocation = $null
    if ($WorkingDirectory) { $oldLocation = Get-Location; Set-Location -LiteralPath $WorkingDirectory }
    $eap = $ErrorActionPreference
    $collected = New-Object System.Collections.Generic.List[string]
    try {
        $ErrorActionPreference = 'Continue'
        & $FilePath @ArgumentList 2>&1 | ForEach-Object {
            $t = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
            $collected.Add($t)
            Write-YHLog "    $t"
        }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $eap
        if ($null -ne $oldLocation) { Set-Location $oldLocation }
        foreach ($k in $saved.Keys) { [Environment]::SetEnvironmentVariable($k, $saved[$k], 'Process') }
    }
    if ($null -eq $code) { $code = 0 }
    if ($AllowedExitCodes -notcontains $code) { throw "'$display' failed with exit code $code" }
    if ($PassThruOutput) { return , $collected.ToArray() }
}

# ------------------------------------------------------------------------------------------------
# Platform
# ------------------------------------------------------------------------------------------------
function Get-YHArch {
    $a = $env:PROCESSOR_ARCHITEW6432
    if (-not $a) { $a = $env:PROCESSOR_ARCHITECTURE }
    switch ($a) {
        'AMD64' { 'x64' }
        'ARM64' { 'arm64' }
        'x86' { 'x86' }
        default { throw "Unsupported processor architecture: $a" }
    }
}

function Get-YHNodeVersion {
    param([Parameter(Mandatory)][string]$NodeExe)
    if (-not (Test-Path -LiteralPath $NodeExe)) { return $null }
    try {
        $eap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
        $v = (& $NodeExe --version 2>$null | Select-Object -First 1)
        $ErrorActionPreference = $eap
        if ($v -match '^v(\d+\.\d+\.\d+)') { return [version]$Matches[1] }
    } catch { Write-Verbose "cannot run $NodeExe" }
    return $null
}

function Find-YHSystemNode {
    $candidates = New-Object System.Collections.Generic.List[string]
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { $candidates.Add($cmd.Source) }
    $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    foreach ($c in $candidates) {
        # Skip per-user installs (nvm-windows, scoop under the profile): the service account cannot rely on them.
        if ($c -like "$env:USERPROFILE*" -or $c -like "$env:LOCALAPPDATA*" -or $c -like "$env:APPDATA*") { continue }
        $v = Get-YHNodeVersion -NodeExe $c
        if ($v -and $v -ge $script:YHNodeMin) { return [pscustomobject]@{ Path = $c; Version = $v } }
    }
    return $null
}

# ------------------------------------------------------------------------------------------------
# Download + integrity
# ------------------------------------------------------------------------------------------------
function Invoke-YHDownload {
    param([Parameter(Mandatory)][string]$Uri, [Parameter(Mandatory)][string]$OutFile)
    if ($Uri -notmatch '^https://') { throw "Refusing non-HTTPS download: $Uri" }
    if ($script:YHDryRun) { Write-YHLog "download $Uri -> $OutFile" -Level DRY; return }
    Write-YHLog "downloading $Uri"
    $pp = $ProgressPreference
    try {
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing -MaximumRedirection 5
    } finally { $ProgressPreference = $pp }
}

function Get-YHSha256 { param([Parameter(Mandatory)][string]$Path) (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant() }

function Assert-YHSha256 {
    param([Parameter(Mandatory)][string]$Path, [string]$Expected, [string]$ShaSumsFile)
    if ($script:YHDryRun -and -not (Test-Path -LiteralPath $Path)) { Write-YHLog "verify SHA-256 of $Path" -Level DRY; return }
    $name = Split-Path -Leaf $Path
    if (-not $Expected) {
        if (-not $ShaSumsFile) { throw 'Assert-YHSha256: -Expected or -ShaSumsFile is required' }
        foreach ($line in Get-Content -LiteralPath $ShaSumsFile) {
            $p = $line -split '\s+', 2
            if ($p.Count -eq 2 -and ($p[1].TrimStart('*') -eq $name)) { $Expected = $p[0]; break }
        }
        if (-not $Expected) { throw "$name is not listed in $ShaSumsFile" }
    }
    $actual = Get-YHSha256 -Path $Path
    if ($actual -ne $Expected.ToUpperInvariant()) { throw "SHA-256 mismatch for ${name}: expected $Expected, got $actual. Aborting." }
    Write-YHLog "SHA-256 verified: $name ($actual)" -Level OK
}

function Test-YHBundle {
    <# Verify CHECKSUMS.sha256 of an extracted offline bundle. #>
    param([Parameter(Mandatory)][string]$BundleDir)
    $sums = Join-Path $BundleDir 'CHECKSUMS.sha256'
    if (-not (Test-Path -LiteralPath $sums)) { throw "Bundle has no CHECKSUMS.sha256: $BundleDir" }
    $bad = 0
    foreach ($line in Get-Content -LiteralPath $sums) {
        if (-not $line.Trim()) { continue }
        $p = $line -split '\s+', 2
        $rel = $p[1].TrimStart('*').TrimStart('.', '/').Replace('/', '\')
        $f = Join-Path $BundleDir $rel
        if (-not (Test-Path -LiteralPath $f)) { Write-YHLog "missing: $rel" -Level ERROR; $bad++; continue }
        if ((Get-YHSha256 -Path $f) -ne $p[0].ToUpperInvariant()) { Write-YHLog "checksum mismatch: $rel" -Level ERROR; $bad++ }
    }
    if ($bad) { throw "Offline bundle failed integrity verification ($bad problems). Do not install it." }
    if ((Test-Path -LiteralPath (Join-Path $BundleDir 'CHECKSUMS.sha256.sig')) -or (Test-Path -LiteralPath (Join-Path $BundleDir 'CHECKSUMS.sha256.asc'))) {
        Write-YHLog 'Bundle carries a detached signature; verify it out-of-band per SIGNATURES.md.' -Level WARN
    } else {
        Write-YHLog 'Bundle is UNSIGNED (checksums detect corruption, not substitution). See SIGNATURES.md.' -Level WARN
    }
    Write-YHLog 'bundle integrity verified' -Level OK
}

# ------------------------------------------------------------------------------------------------
# Config files
# ------------------------------------------------------------------------------------------------
function Read-YHEnvFile {
    param([Parameter(Mandatory)][string]$Path)
    $h = [ordered]@{}
    if (Test-Path -LiteralPath $Path) {
        foreach ($line in Get-Content -LiteralPath $Path) {
            if ($line -match '^\s*([A-Z_][A-Z0-9_]*)=(.*)$') { $h[$Matches[1]] = $Matches[2] }
        }
    }
    return $h
}

function Get-YHState {
    param([string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'))
    $f = Join-Path $DataDir 'config\install.state.json'
    if (-not (Test-Path -LiteralPath $f)) { throw "Install state not found at $f. Is $script:YHProduct installed? (use -DataDir)" }
    return (Get-Content -LiteralPath $f -Raw | ConvertFrom-Json)
}

function Write-YHTextFile {
    <# Write UTF-8 (no BOM) text atomically; honours dry-run. #>
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][AllowEmptyString()][string]$Content)
    if ($script:YHDryRun) {
        Write-YHLog "write $Path :" -Level DRY
        foreach ($l in ($Content -split "`n")) { Write-YHLog ("        | " + $l.TrimEnd("`r")) -Level DRY }
        return
    }
    $dir = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $tmp = "$Path.tmp"
    [IO.File]::WriteAllText($tmp, $Content, (New-Object System.Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $tmp -Destination $Path -Force
}

# ------------------------------------------------------------------------------------------------
# ACLs (icacls with SIDs; inheritance removed so nothing from %ProgramData% leaks in)
# ------------------------------------------------------------------------------------------------
function Set-YHRestrictedAcl {
    <#
    .SYNOPSIS
        Restrict a directory tree to SYSTEM + Administrators (Full) and optionally the service account.
    .PARAMETER ServiceAccount
        e.g. 'NT SERVICE\YouHeal' (virtual account; exists once the service is registered).
    .PARAMETER ServiceRights
        icacls rights for the service account: M (modify, default) or RX (read/execute).
    #>
    param([Parameter(Mandatory)][string]$Path, [string]$ServiceAccount, [ValidateSet('M', 'RX', 'R')][string]$ServiceRights = 'M')
    $isDir = (Test-Path -LiteralPath $Path -PathType Container) -or $script:YHDryRun
    $inh = if ($isDir) { '(OI)(CI)' } else { '' }
    $grants = @('/grant:r', ('*{0}:{1}F' -f $script:SidSystem, $inh), ('*{0}:{1}F' -f $script:SidAdmins, $inh))
    if ($ServiceAccount) { $grants += ('{0}:{1}{2}' -f $ServiceAccount, $inh, $ServiceRights) }
    Invoke-YHNative -FilePath "$env:SystemRoot\System32\icacls.exe" -ArgumentList (@($Path, '/inheritance:r') + $grants + @('/Q'))
    # Remove well-known broad principals if they were ever granted explicitly (Users, Authenticated Users, Everyone, CREATOR OWNER).
    foreach ($sid in @('S-1-5-32-545', 'S-1-5-11', 'S-1-1-0', 'S-1-3-0')) {
        Invoke-YHNative -FilePath "$env:SystemRoot\System32\icacls.exe" -ArgumentList @($Path, '/remove:g', "*$sid", '/T', '/Q') -AllowedExitCodes @(0, 1, 2, 5)
    }
    Invoke-YHNative -FilePath "$env:SystemRoot\System32\icacls.exe" -ArgumentList @($Path, '/setowner', "*$script:SidAdmins", '/Q') -AllowedExitCodes @(0, 1)
}

# ------------------------------------------------------------------------------------------------
# Keys + certificates
# ------------------------------------------------------------------------------------------------
function New-YHMasterKeyString {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes)
}

function Test-YHMasterKeyFile {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    $raw = Get-Content -LiteralPath $Path -Raw
    if ($null -eq $raw) { return $false }
    $s = $raw.Trim()
    if ($s -notmatch '^[A-Za-z0-9+/]+={0,2}$') { return $false }
    try { return ([Convert]::FromBase64String($s).Length -eq 32) } catch { return $false }
}

function Get-YHKeyFingerprint {
    param([Parameter(Mandatory)][string]$Path)
    $bytes = [Convert]::FromBase64String((Get-Content -LiteralPath $Path -Raw).Trim())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
    return ((($h | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0, 16))
}

function ConvertTo-YHPem {
    param([Parameter(Mandatory)][byte[]]$Bytes, [Parameter(Mandatory)][string]$Label)
    $b64 = [Convert]::ToBase64String($Bytes)
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append("-----BEGIN $Label-----`n")
    for ($i = 0; $i -lt $b64.Length; $i += 64) { [void]$sb.Append($b64.Substring($i, [Math]::Min(64, $b64.Length - $i))).Append("`n") }
    [void]$sb.Append("-----END $Label-----`n")
    return $sb.ToString()
}

function Export-YHPrivateKeyPkcs8 {
    <#
    .SYNOPSIS
        Export a certificate's private key as PKCS#8 DER on PS 5.1 (.NET Framework) and PS 7 (.NET).
    .DESCRIPTION
        PS 7 / .NET Core 3.0+: AsymmetricAlgorithm.ExportPkcs8PrivateKey().
        PS 5.1 / .NET Framework 4.6.1+: the key is a CNG key (Microsoft Software Key Storage Provider) created
        with KeyExportPolicy Exportable (= plaintext export allowed), so CngKey.Export(Pkcs8PrivateBlob) works.
    #>
    param([Parameter(Mandatory)][System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate, [ValidateSet('ec', 'rsa')][string]$Algorithm)
    if ($Algorithm -eq 'rsa') {
        $key = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($Certificate)
    } else {
        $key = [System.Security.Cryptography.X509Certificates.ECDsaCertificateExtensions]::GetECDsaPrivateKey($Certificate)
    }
    if ($null -eq $key) { throw 'Certificate has no accessible private key' }
    try {
        if ($key.PSObject.Methods.Name -contains 'ExportPkcs8PrivateKey') {
            try { return , $key.ExportPkcs8PrivateKey() } catch { Write-YHLog "ExportPkcs8PrivateKey failed ($($_.Exception.Message)); trying CNG blob export" -Level DEBUG }
        }
        if ($key.PSObject.Properties.Name -contains 'Key' -and $key.Key -is [System.Security.Cryptography.CngKey]) {
            return , $key.Key.Export([System.Security.Cryptography.CngKeyBlobFormat]::Pkcs8PrivateBlob)
        }
        throw "Private key type $($key.GetType().FullName) cannot be exported as PKCS#8 on this runtime"
    } finally { $key.Dispose() }
}

function New-YHSelfSignedPem {
    <#
    .SYNOPSIS
        Create a self-signed TLS server certificate and write cert.pem + key.pem (PKCS#8).
    .DESCRIPTION
        Uses New-SelfSignedCertificate in Cert:\LocalMachine\My (CNG software KSP), exports PEM, then deletes
        the certificate AND its private key from the store so the only copy is the ACL-protected key.pem.
    #>
    param(
        [Parameter(Mandatory)][string[]]$DnsNames,
        [string[]]$IpAddresses = @(),
        [ValidateSet('ec', 'rsa')][string]$Algorithm = 'ec',
        [int]$Days = 825,
        [Parameter(Mandatory)][string]$CertPath,
        [Parameter(Mandatory)][string]$KeyPath
    )
    $san = @()
    foreach ($d in $DnsNames) { $san += "DNS=$d" }
    foreach ($ip in $IpAddresses) { $san += "IPAddress=$ip" }
    $sanExt = '2.5.29.17={text}' + ($san -join '&')
    if ($script:YHDryRun) { Write-YHLog "New-SelfSignedCertificate $Algorithm $Days days SAN: $($san -join ', ') -> $CertPath / $KeyPath" -Level DRY; return }
    $params = @{
        Subject           = "CN=$($DnsNames[0]), O=YOU HEAL Clinical (self-signed)"
        CertStoreLocation = 'Cert:\LocalMachine\My'
        NotAfter          = (Get-Date).AddDays($Days)
        KeyExportPolicy   = 'Exportable'
        Provider          = 'Microsoft Software Key Storage Provider'
        HashAlgorithm     = 'SHA256'
        TextExtension     = @($sanExt, '2.5.29.37={text}1.3.6.1.5.5.7.3.1')
        FriendlyName      = 'YOU HEAL Clinical TLS (temporary, exported to PEM)'
    }
    if ($Algorithm -eq 'rsa') { $params.KeyAlgorithm = 'RSA'; $params.KeyLength = 3072; $params.KeyUsage = @('DigitalSignature', 'KeyEncipherment') }
    else { $params.KeyAlgorithm = 'ECDSA_nistP256'; $params.KeyUsage = @('DigitalSignature') }
    $cert = New-SelfSignedCertificate @params
    try {
        $keyBytes = Export-YHPrivateKeyPkcs8 -Certificate $cert -Algorithm $Algorithm
        # The caller restricts the parent directory (SYSTEM + Administrators [+ service]) BEFORE this runs;
        # the key file inherits that ACL from the moment it is created.
        foreach ($p in @($KeyPath, $CertPath)) { $d = Split-Path -Parent $p; if (-not (Test-Path -LiteralPath $d)) { throw "directory $d must exist (and be ACL-restricted) before key generation" } }
        [IO.File]::WriteAllText($KeyPath, (ConvertTo-YHPem -Bytes $keyBytes -Label 'PRIVATE KEY'), (New-Object System.Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($CertPath, (ConvertTo-YHPem -Bytes $cert.RawData -Label 'CERTIFICATE'), (New-Object System.Text.UTF8Encoding($false)))
        [Array]::Clear($keyBytes, 0, $keyBytes.Length)
        Write-YHLog ("self-signed certificate created: SHA-256 fingerprint {0}" -f (Get-YHCertFingerprint -CertPath $CertPath)) -Level OK
    } finally {
        try { Remove-Item -LiteralPath ("Cert:\LocalMachine\My\{0}" -f $cert.Thumbprint) -DeleteKey -ErrorAction Stop }
        catch { Write-YHLog "could not delete temporary certificate $($cert.Thumbprint) from LocalMachine\My: $($_.Exception.Message)" -Level WARN }
    }
}

function Get-YHCertFingerprint {
    param([Parameter(Mandatory)][string]$CertPath)
    $pem = Get-Content -LiteralPath $CertPath -Raw
    $b64 = ($pem -replace '-----[^-]+-----', '' -replace '\s', '')
    $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($b64))
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $h = $sha.ComputeHash($x.RawData) } finally { $sha.Dispose() }
    return (($h | ForEach-Object { $_.ToString('X2') }) -join ':')
}

function Get-YHCertInfo {
    param([Parameter(Mandatory)][string]$CertPath)
    $pem = Get-Content -LiteralPath $CertPath -Raw
    $b64 = (($pem -split '-----END CERTIFICATE-----')[0] -replace '-----BEGIN CERTIFICATE-----', '' -replace '\s', '')
    $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 (, [Convert]::FromBase64String($b64))
    return [pscustomobject]@{ Subject = $x.Subject; Issuer = $x.Issuer; NotAfter = $x.NotAfter; SelfSigned = ($x.Subject -eq $x.Issuer) }
}

function Get-YHHostIdentity {
    $fqdn = $env:COMPUTERNAME
    try { $fqdn = [System.Net.Dns]::GetHostEntry('').HostName } catch { Write-Verbose 'DNS lookup failed; using COMPUTERNAME' }
    $ips = @()
    try {
        $ips = @(Get-NetIPAddress -AddressState Preferred -ErrorAction Stop |
                Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.|fe80:|::1$)' } |
                Select-Object -ExpandProperty IPAddress)
    } catch { Write-Verbose 'Get-NetIPAddress unavailable' }
    return [pscustomobject]@{ Fqdn = $fqdn; Short = $env:COMPUTERNAME; IPs = $ips }
}

# ------------------------------------------------------------------------------------------------
# App scripts + health
# ------------------------------------------------------------------------------------------------
function Invoke-YHNodeScript {
    <# Run a package.json script with `node --run` (no npm), environment taken from the env file. #>
    param(
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$AppDir,
        [Parameter(Mandatory)][string]$EnvFile,
        [Parameter(Mandatory)][string]$Name,
        [string[]]$Arguments = @()
    )
    $envs = @{}
    $parsed = Read-YHEnvFile -Path $EnvFile
    foreach ($k in $parsed.Keys) { $envs[$k] = $parsed[$k] }
    $envs['PATH'] = (Split-Path -Parent $NodeExe) + ';' + $env:SystemRoot + '\System32'
    $argv = @('--run', $Name)
    if ($Arguments.Count) { $argv += '--'; $argv += $Arguments }
    Invoke-YHNative -FilePath $NodeExe -ArgumentList $argv -Environment $envs -WorkingDirectory $AppDir
}

function Test-YHHealth {
    param(
        [Parameter(Mandatory)][string]$NodeExe,
        [Parameter(Mandatory)][string]$AppDir,
        [Parameter(Mandatory)][string]$EnvFile,
        [int]$Retries = 30
    )
    $probe = Join-Path $AppDir 'deploy\common\healthcheck.mjs'
    $envs = @{}
    $parsed = Read-YHEnvFile -Path $EnvFile
    foreach ($k in $parsed.Keys) { $envs[$k] = $parsed[$k] }
    $argv = @($probe, '--retries', [string]$Retries, '--interval', '2000')
    if ($parsed.Contains('YH_TLS_SELF_SIGNED') -and $parsed['YH_TLS_SELF_SIGNED'] -eq '1' -and $parsed.Contains('YH_TLS_CERT')) { $argv += @('--ca', $parsed['YH_TLS_CERT']) }
    if ($script:YHDryRun) { Write-YHLog "health check: node $($argv -join ' ')" -Level DRY; return $true }
    try { Invoke-YHNative -FilePath $NodeExe -ArgumentList $argv -Environment $envs; return $true } catch { return $false }
}

function Invoke-YHServiceControl {
    <# Start/stop the Windows service with a timeout; honours dry-run. #>
    param([Parameter(Mandatory)][ValidateSet('Start', 'Stop')][string]$Action, [string]$Name = 'YouHeal', [int]$TimeoutSeconds = 60)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) { Write-YHLog "service $Name not registered; skip $Action" -Level DEBUG; return }
    if ($script:YHDryRun) { Write-YHLog "$Action-Service $Name" -Level DRY; return }
    if ($Action -eq 'Stop' -and $svc.Status -ne 'Stopped') {
        Stop-Service -Name $Name -Force
        $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($TimeoutSeconds))
    } elseif ($Action -eq 'Start' -and $svc.Status -ne 'Running') {
        Start-Service -Name $Name
        $svc.WaitForStatus('Running', [TimeSpan]::FromSeconds($TimeoutSeconds))
    }
    Write-YHLog "service $Name $($Action.ToLower())ed" -Level OK
}

Export-ModuleMember -Function *-YH*
