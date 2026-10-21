#Requires -Version 5.1
<#
.SYNOPSIS
    Install or update YOU HEAL Clinical as a hardened Windows service.

.DESCRIPTION
    Idempotent installer for Windows 10/11 and Windows Server 2016+ (x64, ARM64), on Windows PowerShell 5.1
    and PowerShell 7+. Re-running converges the host to the requested state.

      1. Process-scope execution-policy bypass; self-elevates through UAC when not Administrator.
      2. Ensures Node.js >= 22.13: existing machine-wide install, the official MSI (SHA-256 verified against
         SHASUMS256.txt and Authenticode-checked), winget, or the runtime inside an offline bundle.
      3. Copies the application to <Prefix>\releases\<version>-<timestamp> and points the <Prefix>\current
         junction at it. Code is writable only by Administrators/SYSTEM.
      4. Creates <DataDir> (default %ProgramData%\YouHeal) with inheritance removed and access limited to
         SYSTEM, Administrators and the service's virtual account NT SERVICE\YouHeal.
      5. Generates the master key (32 random bytes, base64) and a self-signed TLS certificate exported to PEM
         (unless provided), writes config\youheal.env and config\install.state.json.
      6. Registers the service with WinSW (checksum-pinned), switches it to the virtual account, configures
         recovery, optionally opens the firewall, runs migrations + catalog load, starts and health-checks.

    Service host choice: WinSW rather than a Scheduled Task. Node cannot talk to the Service Control
    Manager itself, so a wrapper is required. WinSW gives a real service (SCM start/stop, dependencies,
    recovery, Ctrl+C graceful stop, log rotation) that can run as a virtual service account; Task Scheduler
    cannot use virtual accounts (only SYSTEM / LOCAL SERVICE / NETWORK SERVICE or a password-bearing user),
    hard-kills on stop and is invisible to service monitoring. See docs/adr and docs/OPERATIONS.md.

.PARAMETER Prefix
    Application root. Default: %ProgramFiles%\YouHeal.
.PARAMETER DataDir
    PHI data root (db, keys, tls, backups, logs, config). Default: %ProgramData%\YouHeal.
.PARAMETER Source
    Application source tree to install. Default: the checkout containing this script.
.PARAMETER BindHost
    Listen address (YH_HOST). Default 0.0.0.0. Use 127.0.0.1 behind a local reverse proxy.
.PARAMETER Port
    Listen port (YH_PORT). Default 8443.
.PARAMETER HostName
    Certificate CN / first SAN. Default: the machine FQDN.
.PARAMETER Sans
    Extra SANs, e.g. 'clinic.lan','192.168.1.20' (IP addresses are detected automatically).
.PARAMETER TlsCertPath
    Use this PEM certificate (chain) instead of generating one. Requires -TlsKeyPath.
.PARAMETER TlsKeyPath
    PEM private key (PKCS#8 or PKCS#1) for -TlsCertPath.
.PARAMETER CertAlgorithm
    Self-signed key type: ec (P-256, default) or rsa (RSA-3072).
.PARAMETER CertDays
    Self-signed validity in days. Default 825.
.PARAMETER RegenerateCert
    Replace an existing self-signed certificate.
.PARAMETER MasterKeyPath
    Import an existing master key (base64 of 32 bytes), e.g. for disaster recovery onto a new host.
.PARAMETER ForceKey
    Allow -MasterKeyPath to replace a different existing key (the old one is kept as a retired key).
.PARAMETER TrustProxy
    Set YH_TRUST_PROXY=1 (only behind a reverse proxy you control; see deploy/reverse-proxy). Forces
    -BindHost 127.0.0.1 unless -TrustedProxies is given.
.PARAMETER TrustedProxies
    Proxy addresses/CIDRs allowed to send X-Forwarded-* (YH_TRUSTED_PROXIES; backend default: loopback).
.PARAMETER AllowedHosts
    Extra Host header values to accept. YH_ALLOWED_HOSTS is otherwise derived from the certificate names
    and IPs (HostName, computer name, localhost, detected IPs, -Sans) plus the -PublicOrigin host.
.PARAMETER PublicOrigin
    External origin users browse to (YH_PUBLIC_ORIGIN), e.g. https://clinic.example.org.
.PARAMETER NodeSource
    Auto (default: existing >= 22.13, else MSI) | System | Msi | Winget.
.PARAMETER NodeVersion
    Node.js version for the MSI. Default: latest v22.x on the mirror.
.PARAMETER NodeMirror
    HTTPS mirror of https://nodejs.org/dist.
.PARAMETER OfflineBundle
    Air-gapped install from deploy/offline (youheal-<ver>-win-<arch>.zip or its extracted folder).
.PARAMETER WinSWPath
    Use a local WinSW executable (verified against -WinSWSha256, default: the pinned v2.12.0 hash).
.PARAMETER WinSWSha256
    Expected SHA-256 of -WinSWPath when it is not the pinned release.
.PARAMETER OpenFirewall
    Create an inbound Windows Defender Firewall rule for the port (Domain/Private profiles).
.PARAMETER FirewallRemoteAddress
    Remote addresses allowed by the rule. Default: LocalSubnet. Example: 192.168.1.0/24.
.PARAMETER NoStart
    Install everything but do not start the service.
.PARAMETER SkipMigrate
    Do not run database migrations.
.PARAMETER SkipCatalog
    Do not run the catalog load.
.PARAMETER KeepReleases
    Previous releases kept for rollback. Default 3.
.PARAMETER LogPath
    Installer log file. Default: %ProgramData%\YouHeal\logs\install-<timestamp>.log.
.PARAMETER DryRun
    Print the plan and every action without changing anything (no elevation needed).

.EXAMPLE
    .\Install-YouHeal.ps1 -HostName clinic.lan -OpenFirewall -FirewallRemoteAddress 192.168.1.0/24

.EXAMPLE
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install-YouHeal.ps1 -DryRun

.EXAMPLE
    .\Install-YouHeal.ps1 -OfflineBundle E:\youheal-1.0.0-win-x64.zip

.NOTES
    Pure ASCII on purpose (Windows PowerShell 5.1 reads BOM-less files as ANSI).
    Sign for production with Sign-Scripts.ps1 and enforce AllSigned via Group Policy (docs/OPERATIONS.md).
#>
[CmdletBinding()]
param(
    [string]$Prefix = (Join-Path $env:ProgramFiles 'YouHeal'),
    [string]$DataDir = (Join-Path $env:ProgramData 'YouHeal'),
    [string]$Source,
    [string]$BindHost = '0.0.0.0',
    [ValidateRange(1024, 65535)][int]$Port = 8443,
    [string]$HostName,
    [string[]]$Sans = @(),
    [string]$TlsCertPath,
    [string]$TlsKeyPath,
    [ValidateSet('ec', 'rsa')][string]$CertAlgorithm = 'ec',
    [ValidateRange(1, 3650)][int]$CertDays = 825,
    [switch]$RegenerateCert,
    [string]$MasterKeyPath,
    [switch]$ForceKey,
    [switch]$TrustProxy,
    [string[]]$TrustedProxies = @(),
    [string[]]$AllowedHosts = @(),
    [string]$PublicOrigin,
    [ValidateSet('Auto', 'System', 'Msi', 'Winget')][string]$NodeSource = 'Auto',
    [string]$NodeVersion,
    [string]$NodeMirror = 'https://nodejs.org/dist',
    [string]$OfflineBundle,
    [string]$WinSWPath,
    [string]$WinSWSha256,
    [switch]$OpenFirewall,
    [string[]]$FirewallRemoteAddress = @('LocalSubnet'),
    [switch]$NoStart,
    [switch]$SkipMigrate,
    [switch]$SkipCatalog,
    [ValidateRange(0, 50)][int]$KeepReleases = 3,
    [string]$LogPath,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $PSScriptRoot 'YouHeal.Common.psm1') -Force -DisableNameChecking
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'install' -LogPath $LogPath -DryRun:$DryRun -RequireAdmin

$ServiceName = 'YouHeal'
$ServiceAccount = "NT SERVICE\$ServiceName"
$Product = 'YOU HEAL Clinical'

try {
    # --------------------------------------------------------------------------------------------
    # Resolve inputs
    # --------------------------------------------------------------------------------------------
    if (-not $Source) { $Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
    if (($TlsCertPath -and -not $TlsKeyPath) -or ($TlsKeyPath -and -not $TlsCertPath)) { throw '-TlsCertPath and -TlsKeyPath must be given together' }
    if ($PublicOrigin -and $PublicOrigin -notmatch '^https?://[^\s/]+$') { throw '-PublicOrigin must be an origin like https://clinic.example.org' }
    if ($BindHost -notmatch '^[A-Za-z0-9.:\-\[\]]+$') { throw "-BindHost '$BindHost' is invalid" }
    $Sans = @($Sans | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
    $TrustedProxies = @($TrustedProxies | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
    $AllowedHosts = @($AllowedHosts | ForEach-Object { $_ -split ',' } | Where-Object { $_ })
    foreach ($v in @($TrustedProxies + $AllowedHosts)) { if ($v -notmatch '^[A-Za-z0-9.:/\-\[\]]+$') { throw "invalid host/proxy value '$v'" } }
    if ($TrustProxy -and $TrustedProxies.Count -eq 0 -and $BindHost -ne '127.0.0.1') {
        Write-YHLog '-TrustProxy without -TrustedProxies: binding to 127.0.0.1 so only a local proxy can reach the app (F-09)' -Level WARN
        $BindHost = '127.0.0.1'
    }
    $arch = Get-YHArch
    $hostId = Get-YHHostIdentity
    if (-not $HostName) { $HostName = $hostId.Fqdn }

    # Auto-detect running from an extracted bundle (<bundle>\app\deploy\windows\Install-YouHeal.ps1)
    $bundleCandidate = Split-Path -Parent $Source
    if (-not $OfflineBundle -and (Test-Path -LiteralPath (Join-Path $bundleCandidate 'BUNDLE.json'))) {
        $OfflineBundle = $bundleCandidate
        Write-YHLog "detected offline bundle at $OfflineBundle"
    }

    $paths = [ordered]@{
        Releases = Join-Path $Prefix 'releases'
        Current  = Join-Path $Prefix 'current'
        Service  = Join-Path $Prefix 'service'
        Db       = Join-Path $DataDir 'db'
        Keys     = Join-Path $DataDir 'keys'
        Tls      = Join-Path $DataDir 'tls'
        Backups  = Join-Path $DataDir 'backups'
        Logs     = Join-Path $DataDir 'logs'
        Config   = Join-Path $DataDir 'config'
    }
    $keyFile = Join-Path $paths.Keys 'master.key'
    $certFile = Join-Path $paths.Tls 'cert.pem'
    $tlsKeyFile = Join-Path $paths.Tls 'key.pem'
    $envFile = Join-Path $paths.Config 'youheal.env'
    $stateFile = Join-Path $paths.Config 'install.state.json'

    Write-YHLog "$Product installer - plan"
    @(
        "    windows       : $([Environment]::OSVersion.VersionString) ($arch), PowerShell $($PSVersionTable.PSVersion) $($PSVersionTable.PSEdition)"
        "    source        : $(if ($OfflineBundle) { "$OfflineBundle (offline bundle)" } else { $Source })"
        "    prefix        : $Prefix  (releases\, current -> active release, service\)"
        "    data dir      : $DataDir (SYSTEM, Administrators, $ServiceAccount only)"
        "    listen        : ${BindHost}:$Port (TLS)  trust proxy: $([int][bool]$TrustProxy)"
        "    certificate   : $(if ($TlsCertPath) { $TlsCertPath } else { "self-signed $CertAlgorithm $CertDays d for $HostName" })"
        "    master key    : $(if ($MasterKeyPath) { "import $MasterKeyPath" } else { "$keyFile (generated if absent)" })"
        "    node          : source=$NodeSource min=$(Get-YHNodeMin)$(if ($NodeVersion) { " version=$NodeVersion" })"
        "    service       : $ServiceName via WinSW as $ServiceAccount; start=$(-not $NoStart)"
        "    firewall      : $(if ($OpenFirewall) { "allow TCP $Port from $($FirewallRemoteAddress -join ',')" } else { 'unchanged' })"
        "    log           : $(Get-YHLogPath)"
    ) | ForEach-Object { Write-YHLog $_ }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("youheal-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp -Force | Out-Null

    # --------------------------------------------------------------------------------------------
    # Offline bundle
    # --------------------------------------------------------------------------------------------
    $bundleDir = $null
    if ($OfflineBundle) {
        if (Test-Path -LiteralPath $OfflineBundle -PathType Container) { $bundleDir = (Resolve-Path $OfflineBundle).Path }
        elseif (Test-Path -LiteralPath $OfflineBundle -PathType Leaf) {
            Write-YHLog "extracting $OfflineBundle"
            Expand-Archive -LiteralPath $OfflineBundle -DestinationPath (Join-Path $tmp 'bundle') -Force
            $bundleDir = (Get-ChildItem -LiteralPath (Join-Path $tmp 'bundle') -Directory | Select-Object -First 1).FullName
        } else { throw "-OfflineBundle $OfflineBundle not found" }
        Test-YHBundle -BundleDir $bundleDir
        $Source = Join-Path $bundleDir 'app'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $Source 'package.json'))) { throw "No package.json in $Source" }
    $pkg = Get-Content -LiteralPath (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json
    $appVersion = [string]$pkg.version

    # --------------------------------------------------------------------------------------------
    # Node.js
    # --------------------------------------------------------------------------------------------
    $nodeExe = $null
    $existing = Find-YHSystemNode
    if ($NodeSource -in @('Auto', 'System') -and $existing) {
        $nodeExe = $existing.Path
        Write-YHLog "using Node.js $($existing.Version) at $nodeExe" -Level OK
    } elseif ($NodeSource -eq 'System') {
        throw "-NodeSource System: no machine-wide node.exe >= $(Get-YHNodeMin) found"
    } elseif ($NodeSource -eq 'Winget') {
        $wg = Get-Command winget.exe -ErrorAction SilentlyContinue
        if (-not $wg) { throw 'winget is not available on this host; use -NodeSource Msi or -OfflineBundle' }
        Invoke-YHNative -FilePath $wg.Source -ArgumentList @('install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--scope', 'machine',
            '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity')
        $nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    } else {
        # MSI (online or from bundle)
        if ($bundleDir) {
            $msi = Get-ChildItem -LiteralPath (Join-Path $bundleDir 'runtime') -Filter "node-v*-$arch.msi" | Select-Object -First 1
            if (-not $msi) { throw "Bundle has no runtime\node-v*-$arch.msi for this architecture" }
            $msiPath = $msi.FullName
            $sums = Join-Path $bundleDir 'runtime\SHASUMS256.txt'
        } else {
            if (-not $NodeVersion) {
                $latest = Join-Path $tmp 'latest.txt'
                if ($DryRun) { $NodeVersion = '22.x (resolved at install time)' } else {
                    Invoke-YHDownload -Uri "$NodeMirror/latest-v22.x/SHASUMS256.txt" -OutFile $latest
                    $m = Select-String -LiteralPath $latest -Pattern 'node-v(22\.\d+\.\d+)-x64\.msi' | Select-Object -First 1
                    if (-not $m) { throw "Could not resolve the latest Node.js v22.x from $NodeMirror" }
                    $NodeVersion = $m.Matches[0].Groups[1].Value
                }
            }
            $NodeVersion = $NodeVersion.TrimStart('v')
            $msiName = "node-v$NodeVersion-$arch.msi"
            $msiPath = Join-Path $tmp $msiName
            $sums = Join-Path $tmp 'SHASUMS256.txt'
            Invoke-YHDownload -Uri "$NodeMirror/v$NodeVersion/SHASUMS256.txt" -OutFile $sums
            Invoke-YHDownload -Uri "$NodeMirror/v$NodeVersion/$msiName" -OutFile $msiPath
        }
        Assert-YHSha256 -Path $msiPath -ShaSumsFile $sums
        if (-not $DryRun) {
            $sig = Get-AuthenticodeSignature -FilePath $msiPath
            if ($sig.Status -ne 'Valid') { Write-YHLog "Authenticode status of the Node.js MSI is '$($sig.Status)' (SHA-256 already verified against SHASUMS256.txt)" -Level WARN }
            else { Write-YHLog "Authenticode: $($sig.SignerCertificate.Subject)" -Level OK }
        }
        $msiLog = Join-Path (Split-Path -Parent (Get-YHLogPath)) 'node-msi.log'
        # msiexec parses its own command line, so pass ONE pre-quoted string via Start-Process.
        Invoke-YHStep "msiexec /i $msiPath /qn (log: $msiLog)" {
            $p = Start-Process -FilePath "$env:SystemRoot\System32\msiexec.exe" -Wait -PassThru `
                -ArgumentList ('/i "{0}" /qn /norestart /l*v "{1}"' -f $msiPath, $msiLog)
            if (@(0, 3010, 1641) -notcontains $p.ExitCode) { throw "Node.js MSI failed with exit code $($p.ExitCode); see $msiLog" }
            if ($p.ExitCode -ne 0) { Write-YHLog "Node.js MSI requests a reboot (exit $($p.ExitCode)); the service will still start" -Level WARN }
        }
        $nodeExe = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    }
    if (-not $DryRun) {
        $v = Get-YHNodeVersion -NodeExe $nodeExe
        if (-not $v -or $v -lt (Get-YHNodeMin)) { throw "node at $nodeExe is missing or older than $(Get-YHNodeMin)" }
        Write-YHLog "Node.js $v ready at $nodeExe" -Level OK
    }

    # --------------------------------------------------------------------------------------------
    # Application release (robocopy with exclusions) + junction
    # --------------------------------------------------------------------------------------------
    $exclude = @('data\sources', 'data\db', 'data\keys', 'data\backups', 'data\tls', 'node_modules', '.git', 'tests', 'importer', 'dist') |
        ForEach-Object { Join-Path $Source $_ }
    $digestInput = Get-ChildItem -LiteralPath $Source -Recurse -File | Where-Object {
        $f = $_.FullName; -not ($exclude | Where-Object { $f.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase) }) -and $_.Name -notlike '*.sqlite*' -and $_.Name -ne '.youheal-release'
    } | Sort-Object FullName | ForEach-Object { '{0}  {1}' -f (Get-YHSha256 -Path $_.FullName), $_.FullName.Substring($Source.Length).Replace('\', '/') }
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $treeDigest = (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($digestInput -join "`n"))) | ForEach-Object { $_.ToString('x2') }) -join '')
    $sha.Dispose()

    $currentDigest = $null
    $marker = Join-Path $paths.Current '.youheal-release'
    if (Test-Path -LiteralPath $marker) {
        $line = Select-String -LiteralPath $marker -Pattern '^TREE_SHA256=(.+)$' | Select-Object -First 1
        if ($line) { $currentDigest = $line.Matches[0].Groups[1].Value }
    }
    if ($currentDigest -eq $treeDigest) {
        $releaseDir = (Get-Item -LiteralPath $paths.Current).Target
        if ($releaseDir -is [array]) { $releaseDir = $releaseDir[0] }
        Write-YHLog "release $appVersion already installed and identical" -Level OK
    } else {
        $releaseDir = Join-Path $paths.Releases ('{0}-{1}' -f $appVersion, [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
        Write-YHLog "installing release $appVersion -> $releaseDir (tree sha256 $($treeDigest.Substring(0,16))...)"
        $rc = @($Source, $releaseDir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/XD') + $exclude + @('/XF', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '.env')
        Invoke-YHNative -FilePath "$env:SystemRoot\System32\robocopy.exe" -ArgumentList $rc -AllowedExitCodes @(0, 1, 2, 3, 4, 5, 6, 7)
        Invoke-YHStep "write release marker" {
            Set-Content -LiteralPath (Join-Path $releaseDir '.youheal-release') -Encoding ASCII -Value @(
                "VERSION=$appVersion", "TREE_SHA256=$treeDigest", "SOURCE=$Source", ("INSTALLED_AT=" + [DateTime]::UtcNow.ToString('o')))
        }
        Invoke-YHStep "junction $($paths.Current) -> $releaseDir" {
            if (Test-Path -LiteralPath $paths.Current) { [IO.Directory]::Delete($paths.Current) }   # removes the junction only
            New-Item -ItemType Junction -Path $paths.Current -Target $releaseDir | Out-Null
        }
    }
    $appDir = $paths.Current

    # --------------------------------------------------------------------------------------------
    # Data directory (restricted BEFORE any secret is written)
    # --------------------------------------------------------------------------------------------
    foreach ($d in @($DataDir, $paths.Db, $paths.Keys, $paths.Tls, $paths.Backups, $paths.Logs, $paths.Config)) {
        if (-not (Test-Path -LiteralPath $d)) { Invoke-YHStep "mkdir $d" { New-Item -ItemType Directory -Path $d -Force | Out-Null } }
    }
    if (-not $DryRun) { Assert-YHNoReparsePoint -Path $DataDir }
    $svcExists = [bool](Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    if ($svcExists) { Set-YHRestrictedAcl -Path $DataDir -ServiceAccount $ServiceAccount } else { Set-YHRestrictedAcl -Path $DataDir }
    Set-YHRestrictedAcl -Path $paths.Config
    Write-YHLog "data dir $DataDir restricted to SYSTEM + Administrators$(if ($svcExists) { " + $ServiceAccount" }); config\ to SYSTEM + Administrators only" -Level OK

    # --------------------------------------------------------------------------------------------
    # Master key
    # --------------------------------------------------------------------------------------------
    $keyGenerated = $false
    if ($MasterKeyPath) {
        if (-not (Test-YHMasterKeyFile -Path $MasterKeyPath)) { throw "-MasterKeyPath $MasterKeyPath is not base64 of exactly 32 bytes" }
        $newKey = (Get-Content -LiteralPath $MasterKeyPath -Raw).Trim()
        if ((Test-Path -LiteralPath $keyFile) -and ((Get-Content -LiteralPath $keyFile -Raw).Trim() -ne $newKey)) {
            if (-not $ForceKey) { throw "A DIFFERENT master key already exists at $keyFile; replacing it makes existing PHI unreadable. Use -ForceKey only if you are sure." }
            Invoke-YHStep 'retire existing master key' {
                $ret = Join-Path $paths.Keys 'retired'; New-Item -ItemType Directory -Path $ret -Force | Out-Null
                Copy-Item -LiteralPath $keyFile -Destination (Join-Path $ret ("replaced-{0}.key" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')))
            }
        }
        Write-YHTextFile -Path $keyFile -Content ($newKey + "`n")
        Write-YHLog "imported master key from $MasterKeyPath" -Level OK
    } elseif (Test-Path -LiteralPath $keyFile) {
        if (-not (Test-YHMasterKeyFile -Path $keyFile)) { throw "Existing $keyFile is not a valid key; restore it from escrow" }
        Write-YHLog "master key present (fingerprint $(Get-YHKeyFingerprint -Path $keyFile))" -Level OK
    } else {
        if ($DryRun) { Write-YHLog "generate 32 random bytes (base64) -> $keyFile" -Level DRY }
        else { Write-YHTextFile -Path $keyFile -Content ((New-YHMasterKeyString) + "`n"); $keyGenerated = $true; Write-YHLog "generated NEW master key $keyFile" -Level WARN }
    }

    # --------------------------------------------------------------------------------------------
    # TLS
    # --------------------------------------------------------------------------------------------
    $selfSigned = $true
    if ($TlsCertPath) {
        Invoke-YHStep "install operator-supplied certificate" {
            Copy-Item -LiteralPath $TlsCertPath -Destination $certFile -Force
            Copy-Item -LiteralPath $TlsKeyPath -Destination $tlsKeyFile -Force
        }
        $selfSigned = $false
    } elseif ((Test-Path -LiteralPath $certFile) -and (Test-Path -LiteralPath $tlsKeyFile) -and -not $RegenerateCert) {
        $ci = Get-YHCertInfo -CertPath $certFile
        $selfSigned = $ci.SelfSigned
        if ($ci.NotAfter -lt (Get-Date).AddDays(30)) { Write-YHLog "$certFile expires $($ci.NotAfter); re-run with -RegenerateCert or supply -TlsCertPath/-TlsKeyPath" -Level WARN }
        Write-YHLog "keeping existing certificate ($($ci.Subject), expires $($ci.NotAfter.ToString('yyyy-MM-dd')))" -Level OK
    } else {
        $dns = @($HostName, $hostId.Short, 'localhost') + @($Sans | Where-Object { $_ -notmatch '^[0-9.:]+$' }) | Select-Object -Unique
        $ips = @('127.0.0.1', '::1') + @($hostId.IPs) + @($Sans | Where-Object { $_ -match '^[0-9.:]+$' }) | Select-Object -Unique
        New-YHSelfSignedPem -DnsNames $dns -IpAddresses $ips -Algorithm $CertAlgorithm -Days $CertDays -CertPath $certFile -KeyPath $tlsKeyFile
    }

    # --------------------------------------------------------------------------------------------
    # Config
    # --------------------------------------------------------------------------------------------
    # YH_ALLOWED_HOSTS (F-05, DNS-rebinding defence): the certificate names/IPs plus explicit extras.
    $allowed = @($HostName, $hostId.Short, 'localhost', '127.0.0.1', '::1') + @($hostId.IPs) + $Sans + $AllowedHosts
    if ($PublicOrigin) { $allowed += ($PublicOrigin -replace '^https?://', '' -replace ':\d+$', '') }
    $allowedHosts = (@($allowed | Where-Object { $_ } | ForEach-Object { $_.ToLowerInvariant() } | Select-Object -Unique) -join ',')
    $preserved = ''
    if (Test-Path -LiteralPath $envFile) {
        $old = Get-Content -LiteralPath $envFile
        $idx = [Array]::IndexOf($old, '# --- local settings (preserved by Install-YouHeal.ps1) ---')
        if ($idx -ge 0 -and $idx -lt $old.Count - 1) { $preserved = ($old[($idx + 1)..($old.Count - 1)] -join "`n") }
    }
    $envLines = @(
        "# $Product - service environment. Managed by Install-YouHeal.ps1 ($appVersion, $([DateTime]::UtcNow.ToString('o')))."
        '# KEY=value only. The service reads these values from service\YouHeal.xml (regenerated from this file).'
        '# The master key is NOT stored here; YH_MASTER_KEY_FILE points at it (ACL: SYSTEM, Administrators, service).'
        'NODE_ENV=production'
        "YH_HOST=$BindHost"
        "YH_PORT=$Port"
        "YH_DATA_DIR=$DataDir"
        "YH_TLS_CERT=$certFile"
        "YH_TLS_KEY=$tlsKeyFile"
        "YH_TLS_SELF_SIGNED=$([int][bool]$selfSigned)"
        "YH_MASTER_KEY_FILE=$keyFile"
        "YH_CATALOG_DIR=$(Join-Path $appDir 'data\catalog')"
        "YH_TRUST_PROXY=$([int][bool]$TrustProxy)"
        "YH_ALLOWED_HOSTS=$allowedHosts"
    )
    if ($TrustedProxies.Count) { $envLines += "YH_TRUSTED_PROXIES=$($TrustedProxies -join ',')" }
    if ($PublicOrigin) { $envLines += "YH_PUBLIC_ORIGIN=$PublicOrigin" }
    $envLines += '# --- local settings (preserved by Install-YouHeal.ps1) ---'
    $envContent = ($envLines -join "`n") + "`n" + $preserved
    Write-YHTextFile -Path $envFile -Content $envContent
    $envMap = Read-YHEnvFile -Path $envFile
    if ($DryRun) { $envMap = [ordered]@{}; foreach ($l in $envLines) { if ($l -match '^([A-Z_][A-Z0-9_]*)=(.*)$') { $envMap[$Matches[1]] = $Matches[2] } } }

    # --------------------------------------------------------------------------------------------
    # WinSW service
    # --------------------------------------------------------------------------------------------
    $winsw = Get-YHWinSWInfo
    $svcExe = Join-Path $paths.Service "$ServiceName.exe"
    $svcXml = Join-Path $paths.Service "$ServiceName.xml"
    $wantSha = $winsw.Sha256
    if ($WinSWPath -and $WinSWSha256) { $wantSha = $WinSWSha256 }
    $needExe = -not ((Test-Path -LiteralPath $svcExe) -and ((Get-YHSha256 -Path $svcExe) -eq $wantSha.ToUpperInvariant()))
    if ($needExe) {
        $src = $null
        if ($WinSWPath) { $src = $WinSWPath }
        elseif ($bundleDir -and (Test-Path -LiteralPath (Join-Path $bundleDir 'winsw\WinSW.NET461.exe'))) { $src = Join-Path $bundleDir 'winsw\WinSW.NET461.exe' }
        else { $src = Join-Path $tmp 'WinSW.NET461.exe'; Invoke-YHDownload -Uri $winsw.Url -OutFile $src }
        Assert-YHSha256 -Path $src -Expected $wantSha
        Invoke-YHStep "install WinSW -> $svcExe" {
            New-Item -ItemType Directory -Path $paths.Service -Force | Out-Null
            if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { Invoke-YHServiceControl -Action Stop -Name $ServiceName }
            Copy-Item -LiteralPath $src -Destination $svcExe -Force
        }
    }
    $xmlEnv = foreach ($k in $envMap.Keys) { '  <env name="{0}" value="{1}"/>' -f $k, [Security.SecurityElement]::Escape([string]$envMap[$k]) }
    $xml = @"
<?xml version="1.0" encoding="UTF-8"?>
<!-- $Product service definition. Generated by Install-YouHeal.ps1 from $envFile - edit that file and re-run. -->
<service>
  <id>$ServiceName</id>
  <name>$Product</name>
  <description>$Product - Biomagnetic Pair practitioner platform (PHI). Runs as $ServiceAccount.</description>
  <executable>$([Security.SecurityElement]::Escape($nodeExe))</executable>
  <arguments>--disable-warning=ExperimentalWarning server/index.js</arguments>
  <workingdirectory>$([Security.SecurityElement]::Escape($appDir))</workingdirectory>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>30 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$([Security.SecurityElement]::Escape($paths.Logs))</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
$($xmlEnv -join "`n")
</service>
"@
    Write-YHTextFile -Path $svcXml -Content $xml

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc) {
        Invoke-YHServiceControl -Action Stop -Name $ServiceName
        # Re-register so WinSW picks up the regenerated XML (executable/arguments are cached by the SCM).
        Invoke-YHNative -FilePath $svcExe -ArgumentList @('uninstall')
        if (-not $DryRun) { Start-Sleep -Seconds 2 }
    }
    Invoke-YHNative -FilePath $svcExe -ArgumentList @('install')
    # Virtual service account: unique SID, no password, no interactive logon, least privilege.
    Invoke-YHNative -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList @('sidtype', $ServiceName, 'unrestricted')
    Invoke-YHNative -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList @('config', $ServiceName, 'obj=', $ServiceAccount)
    Invoke-YHNative -FilePath "$env:SystemRoot\System32\sc.exe" -ArgumentList @('failureflag', $ServiceName, '1')
    Set-YHRestrictedAcl -Path $DataDir -ServiceAccount $ServiceAccount
    # config\ holds youheal.env + install state, read by ELEVATED scripts: never writable by the service (F-03).
    Set-YHRestrictedAcl -Path $paths.Config
    Write-YHLog "service $ServiceName registered (WinSW) as $ServiceAccount" -Level OK

    # --------------------------------------------------------------------------------------------
    # Firewall
    # --------------------------------------------------------------------------------------------
    $fwName = 'YouHeal-HTTPS-In'
    if ($OpenFirewall) {
        Invoke-YHStep "firewall rule $fwName (TCP $Port from $($FirewallRemoteAddress -join ','))" {
            Get-NetFirewallRule -Name $fwName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
            New-NetFirewallRule -Name $fwName -DisplayName "$Product (TCP $Port)" -Group $Product -Direction Inbound -Action Allow `
                -Protocol TCP -LocalPort $Port -Program $nodeExe -RemoteAddress $FirewallRemoteAddress -Profile Domain, Private | Out-Null
        }
        Write-YHLog "firewall: inbound TCP $Port allowed for node.exe from $($FirewallRemoteAddress -join ',') (Domain/Private profiles)" -Level OK
    }

    # --------------------------------------------------------------------------------------------
    # State
    # --------------------------------------------------------------------------------------------
    $state = [ordered]@{
        Product = $Product; Version = $appVersion; Prefix = $Prefix; DataDir = $DataDir; AppDir = $appDir
        NodeExe = $nodeExe; NodeSource = $NodeSource; ServiceName = $ServiceName; ServiceAccount = $ServiceAccount
        BindHost = $BindHost; Port = $Port; HostName = $HostName; TrustProxy = [bool]$TrustProxy; TrustedProxies = ($TrustedProxies -join ','); AllowedHosts = ($AllowedHosts -join ','); PublicOrigin = $PublicOrigin
        FirewallRule = $(if ($OpenFirewall) { $fwName } else { $null }); KeepReleases = $KeepReleases
        InstalledAt = [DateTime]::UtcNow.ToString('o')
    }
    if (Test-Path -LiteralPath $stateFile) {
        $prev = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
        if (-not $OpenFirewall -and $prev.PSObject.Properties.Name -contains 'FirewallRule') { $state.FirewallRule = $prev.FirewallRule }
    }
    Write-YHTextFile -Path $stateFile -Content ($state | ConvertTo-Json)

    # --------------------------------------------------------------------------------------------
    # Migrate, catalog, prune, start, health
    # --------------------------------------------------------------------------------------------
    if (-not $SkipMigrate) { Write-YHLog 'running database migrations'; Invoke-YHNodeScript -NodeExe $nodeExe -AppDir $appDir -EnvFile $envFile -Name 'migrate'; Write-YHLog 'migrations applied' -Level OK }
    if (-not $SkipCatalog) {
        $catDir = Join-Path $appDir 'data\catalog'
        if ($DryRun -or (Test-Path -LiteralPath (Join-Path $catDir 'points.json')) -or (Test-Path -LiteralPath (Join-Path $catDir 'manifest.json'))) {
            Write-YHLog 'loading catalog'; Invoke-YHNodeScript -NodeExe $nodeExe -AppDir $appDir -EnvFile $envFile -Name 'catalog:load'; Write-YHLog 'catalog loaded' -Level OK
        } else { Write-YHLog 'data\catalog is empty - catalog load skipped' -Level WARN }
    }
    if (Test-Path -LiteralPath $paths.Releases) {
        $active = $releaseDir
        Get-ChildItem -LiteralPath $paths.Releases -Directory | Sort-Object { ($_.Name -split '-')[-1] } -Descending |
            Select-Object -Skip ($KeepReleases + 1) | Where-Object { $_.FullName -ne $active } |
            ForEach-Object { $dir = $_.FullName; Invoke-YHStep "prune old release $dir" { Remove-Item -LiteralPath $dir -Recurse -Force } }
    }

    $health = 'not checked'
    if (-not $NoStart) {
        Invoke-YHServiceControl -Action Start -Name $ServiceName
        if (Test-YHHealth -NodeExe $nodeExe -AppDir $appDir -EnvFile $envFile -Retries 30) { $health = 'healthy' }
        else {
            $health = 'UNHEALTHY'
            Write-YHLog "service did not become healthy; see $($paths.Logs)\$ServiceName.*.log" -Level ERROR
            Get-ChildItem -LiteralPath $paths.Logs -Filter "$ServiceName*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending |
                Select-Object -First 1 | ForEach-Object { Get-Content -LiteralPath $_.FullName -Tail 40 | ForEach-Object { Write-YHLog "    $_" } }
            exit 1
        }
    }

    $fpr = if (-not $DryRun -and (Test-Path -LiteralPath $certFile)) { Get-YHCertFingerprint -CertPath $certFile } else { "<see $certFile>" }
    $banner = @(
        ''
        '============================================================================================'
        " $Product $appVersion $(if ($DryRun) { '- DRY RUN, nothing was changed' } else { "installed   (health: $health)" })"
        '--------------------------------------------------------------------------------------------'
        ' First-run setup (creates the clinic + first admin; LOOPBACK ONLY, needs the one-time setup token):'
        "   setup token:             Get-Content `"$DataDir\setup-token`"   (elevated; also in $($paths.Logs))"
        "   on this host:            https://localhost:$Port/#/setup"
        "   from a workstation:      ssh -L ${Port}:127.0.0.1:$Port <admin>@$HostName   (OpenSSH Server on Windows)"
        "                            then browse https://localhost:$Port/#/setup"
        "   or CLI on this host:     & `"$appDir\deploy\windows\Invoke-YouHealCli.ps1`" create-admin"
        " After setup, users sign in at: https://${HostName}:$Port/"
        ' TLS certificate SHA-256 fingerprint (compare in the browser before trusting it):'
        "   $fpr"
        " Master key: $keyFile$(if ($keyGenerated) { "`n   NEW KEY - escrow it OFFLINE now (two sealed copies). Without it, PHI and backups are unrecoverable." })"
        " Service: Get-Service $ServiceName    Logs: $($paths.Logs)    Config: $envFile"
        " Backups: & `"$appDir\deploy\windows\Backup-YouHeal.ps1`" -InstallSchedule"
        " Runbook: $appDir\docs\OPERATIONS.md     Installer log: $(Get-YHLogPath)"
        '============================================================================================'
    )
    $banner | ForEach-Object { Write-YHLog $_ }
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    Write-YHLog ("at {0}" -f $_.InvocationInfo.PositionMessage) -Level ERROR
    Write-YHLog "full log: $(Get-YHLogPath)" -Level ERROR
    exit 1
} finally {
    if ((Get-Variable -Name tmp -Scope Script -ErrorAction SilentlyContinue) -and $tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
}
