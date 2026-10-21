#Requires -Version 5.1
<#
.SYNOPSIS
    Build an air-gapped YOU HEAL Clinical install bundle (Windows build machine; PS 5.1 or 7+).

.DESCRIPTION
    Produces <OutDir>\youheal-<version>-<os>-<arch>.zip (win) or .tar.gz (linux, darwin; uses the tar.exe
    bundled with Windows 10 1803+), plus a .sha256 sidecar. Layout and verification rules are identical to
    build-bundle.sh:

      youheal-<version>-<os>-<arch>\
        BUNDLE.json  CHECKSUMS.sha256  SIGNATURES.md  README-OFFLINE.txt
        app\        application tree (no PHI, keys, licensed PDFs, tests, importer)
        runtime\    official Node.js MSI / archive + SHASUMS256.txt (+ .asc)
        winsw\      (win) WinSW.NET461.exe, verified against the hash pinned in YouHeal.Common.psm1

    Runs UNPRIVILEGED on purpose (least privilege): building needs no administrator rights, so this script
    never elevates. Sign the Windows scripts (deploy\windows\Sign-Scripts.ps1) BEFORE building, because the
    checksums are computed over the files as shipped.

.PARAMETER OS
    Target OS: win (default), linux, darwin.
.PARAMETER Arch
    Target architecture: x64 (default), arm64 (win also x86).
.PARAMETER NodeVersion
    Node.js version. Default: latest v22.x on the mirror.
.PARAMETER NodeMirror
    HTTPS mirror of https://nodejs.org/dist.
.PARAMETER NodeFile
    Pre-downloaded Node.js MSI/archive (requires -ShaSumsFile).
.PARAMETER ShaSumsFile
    SHASUMS256.txt matching -NodeFile.
.PARAMETER WinSWFile
    Pre-downloaded WinSW.NET461.exe (verified against the pinned hash).
.PARAMETER Source
    Application tree. Default: the checkout containing this script.
.PARAMETER OutDir
    Output directory. Default: <Source>\dist.
.PARAMETER AllowInternalUse
    Do not fail when the catalog contains 'internal-use' licensed content (internal bundles only; ADR-007).
.PARAMETER LogPath
    Log file. Default: <OutDir>\build-bundle.log.
.PARAMETER DryRun
    Show what would happen.

.EXAMPLE
    .\build-bundle.ps1 -OS win -Arch x64
.EXAMPLE
    .\build-bundle.ps1 -OS linux -Arch arm64 -NodeVersion 22.23.3 -AllowInternalUse
#>
[CmdletBinding()]
param(
    [ValidateSet('win', 'linux', 'darwin')][string]$OS = 'win',
    [ValidateSet('x64', 'arm64', 'x86')][string]$Arch = 'x64',
    [string]$NodeVersion,
    [string]$NodeMirror = 'https://nodejs.org/dist',
    [string]$NodeFile,
    [string]$ShaSumsFile,
    [string]$WinSWFile,
    [string]$Source = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
    [string]$OutDir,
    [switch]$AllowInternalUse,
    [string]$LogPath,
    [switch]$DryRun
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
try { Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force -ErrorAction Stop } catch { Write-Warning "Process execution policy: $($_.Exception.Message)" }
Import-Module (Join-Path $Source 'deploy\windows\YouHeal.Common.psm1') -Force -DisableNameChecking
if (-not $OutDir) { $OutDir = Join-Path $Source 'dist' }
if (-not (Test-Path -LiteralPath $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
if (-not $LogPath) { $LogPath = Join-Path $OutDir 'build-bundle.log' }
# No -RequireAdmin: bundle building is deliberately unprivileged.
Initialize-YHScript -ScriptPath $PSCommandPath -BoundParameters $PSBoundParameters -LogName 'build-bundle' -LogPath $LogPath -DryRun:$DryRun
if (Test-YHAdmin) { Write-YHLog 'running elevated is unnecessary for building a bundle (least privilege)' -Level WARN }

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('youheal-bundle-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
try {
    if ($OS -ne 'win' -and $Arch -eq 'x86') { throw "x86 is only supported for -OS win" }
    if ($NodeFile -and -not $ShaSumsFile) { throw '-NodeFile requires -ShaSumsFile' }
    $pkg = Get-Content -LiteralPath (Join-Path $Source 'package.json') -Raw | ConvertFrom-Json
    $version = [string]$pkg.version
    $name = "youheal-$version-$OS-$Arch"
    $stage = Join-Path $OutDir $name
    Write-YHLog "building $name from $Source -> $OutDir"

    # ---- licensing gate (ADR-007) ----
    $sourcesJson = Join-Path $Source 'data\catalog\sources.json'
    if ((Test-Path -LiteralPath $sourcesJson) -and (Select-String -LiteralPath $sourcesJson -Pattern '"internal-use"' -Quiet)) {
        if ($AllowInternalUse) { Write-YHLog "catalog contains 'internal-use' content; this bundle must NOT leave the licensed organization" -Level WARN }
        else { throw "catalog contains 'internal-use' content (ADR-007). Distribution requires a license - see docs/REGULATORY.md. Use -AllowInternalUse for an internal bundle." }
    }

    # ---- app ----
    Invoke-YHStep "stage app -> $stage\app" {
        if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
        New-Item -ItemType Directory -Path (Join-Path $stage 'runtime') -Force | Out-Null
    }
    $exclude = @('data\sources', 'data\db', 'data\keys', 'data\backups', 'data\tls', 'node_modules', '.git', 'tests', 'importer', 'dist') | ForEach-Object { Join-Path $Source $_ }
    $rc = @($Source, (Join-Path $stage 'app'), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/R:1', '/W:1', '/XD') + $exclude + @('/XF', '*.sqlite', '*.sqlite-wal', '*.sqlite-shm', '.env', '*.yhbak')
    Invoke-YHNative -FilePath "$env:SystemRoot\System32\robocopy.exe" -ArgumentList $rc -AllowedExitCodes @(0, 1, 2, 3, 4, 5, 6, 7)

    # ---- Node runtime ----
    $runtime = Join-Path $stage 'runtime'
    if ($NodeFile) {
        $nodeName = Split-Path -Leaf $NodeFile
        if ($nodeName -match '^node-v(\d+\.\d+\.\d+)-') { $NodeVersion = $Matches[1] }
        Invoke-YHStep "copy $NodeFile" { Copy-Item -LiteralPath $NodeFile -Destination $runtime; Copy-Item -LiteralPath $ShaSumsFile -Destination (Join-Path $runtime 'SHASUMS256.txt') }
    } else {
        if (-not $NodeVersion) {
            $latest = Join-Path $tmp 'latest.txt'
            Invoke-WebRequest -Uri "$NodeMirror/latest-v22.x/SHASUMS256.txt" -OutFile $latest -UseBasicParsing
            $m = Select-String -LiteralPath $latest -Pattern 'node-v(22\.\d+\.\d+)-' | Select-Object -First 1
            if (-not $m) { throw 'could not resolve latest Node.js v22.x' }
            $NodeVersion = $m.Matches[0].Groups[1].Value
        }
        $NodeVersion = $NodeVersion.TrimStart('v')
        if ([version]$NodeVersion -lt (Get-YHNodeMin)) { throw "Node $NodeVersion < $(Get-YHNodeMin)" }
        $nodeName = switch ($OS) { 'win' { "node-v$NodeVersion-$Arch.msi" } 'linux' { "node-v$NodeVersion-linux-$Arch.tar.xz" } 'darwin' { "node-v$NodeVersion-darwin-$Arch.tar.gz" } }
        Invoke-YHDownload -Uri "$NodeMirror/v$NodeVersion/SHASUMS256.txt" -OutFile (Join-Path $runtime 'SHASUMS256.txt')
        if (-not $DryRun) {
            try { Invoke-YHDownload -Uri "$NodeMirror/v$NodeVersion/SHASUMS256.txt.asc" -OutFile (Join-Path $runtime 'SHASUMS256.txt.asc') }
            catch { Write-YHLog 'SHASUMS256.txt.asc not available' -Level WARN }
        }
        Invoke-YHDownload -Uri "$NodeMirror/v$NodeVersion/$nodeName" -OutFile (Join-Path $runtime $nodeName)
    }
    $nodeSha = ''
    if (-not $DryRun) {
        Assert-YHSha256 -Path (Join-Path $runtime $nodeName) -ShaSumsFile (Join-Path $runtime 'SHASUMS256.txt')
        $nodeSha = (Get-YHSha256 -Path (Join-Path $runtime $nodeName)).ToLowerInvariant()
    }

    # ---- WinSW ----
    $winswSha = ''
    if ($OS -eq 'win') {
        $w = Get-YHWinSWInfo
        $winswDir = Join-Path $stage 'winsw'
        $dest = Join-Path $winswDir 'WinSW.NET461.exe'
        Invoke-YHStep "mkdir $winswDir" { New-Item -ItemType Directory -Path $winswDir -Force | Out-Null }
        if ($WinSWFile) { Invoke-YHStep "copy $WinSWFile" { Copy-Item -LiteralPath $WinSWFile -Destination $dest } }
        else { Invoke-YHDownload -Uri $w.Url -OutFile $dest }
        Assert-YHSha256 -Path $dest -Expected $w.Sha256
        $winswSha = $w.Sha256.ToLowerInvariant()
    }

    # ---- manifest + docs ----
    $rev = 'no-git'; $dirty = $false
    $git = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($git) {
        try { Push-Location $Source; $rev = (& $git.Source rev-parse HEAD 2>$null); $dirty = [bool](& $git.Source status --porcelain 2>$null | Select-Object -First 1) } catch { $rev = 'no-git' } finally { Pop-Location }
    }
    $manifest = [ordered]@{
        name = $name; product = 'YOU HEAL Clinical'; version = $version
        target = [ordered]@{ os = $OS; arch = $Arch }
        node = [ordered]@{ version = $NodeVersion; file = "runtime/$nodeName"; sha256 = $nodeSha; source = $NodeMirror }
        winsw = $(if ($OS -eq 'win') { [ordered]@{ file = 'winsw/WinSW.NET461.exe'; sha256 = $winswSha } } else { $null })
        build = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); host = $env:COMPUTERNAME; vcsRevision = "$rev"; vcsDirty = $dirty }
        signature = [ordered]@{ status = 'unsigned'; see = 'SIGNATURES.md' }
    }
    Write-YHTextFile -Path (Join-Path $stage 'BUNDLE.json') -Content ($manifest | ConvertTo-Json -Depth 5)
    $sigDoc = Join-Path $PSScriptRoot 'SIGNATURES.template.md'
    $sigText = if (Test-Path -LiteralPath $sigDoc) { Get-Content -LiteralPath $sigDoc -Raw } else { "# Bundle signatures`n`nThis bundle is UNSIGNED. See deploy/offline/build-bundle.sh for the signing procedure.`n" }
    Write-YHTextFile -Path (Join-Path $stage 'SIGNATURES.md') -Content $sigText
    $ext = if ($OS -eq 'win') { 'zip' } else { 'tar.gz' }
    Write-YHTextFile -Path (Join-Path $stage 'README-OFFLINE.txt') -Content (@(
            "YOU HEAL Clinical $version - offline install bundle for $OS/$Arch", '',
            "1. Verify the archive hash against the value published by your release manager (Get-FileHash -Algorithm SHA256 $name.$ext).",
            '2. (Recommended) Verify the CHECKSUMS.sha256 signature - see SIGNATURES.md.',
            '3. Install:',
            '     Windows:      powershell -ExecutionPolicy Bypass -File .\app\deploy\windows\Install-YouHeal.ps1 -OfflineBundle "$PWD"',
            '     Linux/macOS:  sudo ./app/deploy/linux/install.sh --offline-bundle "$(pwd)"',
            '   The installers verify every file against CHECKSUMS.sha256 before using it.',
            '4. Follow app/docs/OPERATIONS.md (first-run setup, key escrow, backups).') -join "`r`n")

    # ---- checksums ----
    if (-not $DryRun) {
        $lines = Get-ChildItem -LiteralPath $stage -Recurse -File | Where-Object { $_.Name -notlike 'CHECKSUMS.sha256*' } |
            ForEach-Object { $_.FullName.Substring($stage.Length + 1).Replace('\', '/') + '|' + $_.FullName } | Sort-Object { $_.Split('|')[0] } -CaseSensitive |
            ForEach-Object { $rel, $full = $_.Split('|', 2); '{0}  {1}' -f (Get-YHSha256 -Path $full).ToLowerInvariant(), $rel }
        [IO.File]::WriteAllText((Join-Path $stage 'CHECKSUMS.sha256'), (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
        Write-YHLog "$(@($lines).Count) files checksummed" -Level OK
    }

    # ---- archive ----
    $archive = Join-Path $OutDir "$name.$ext"
    if ($DryRun) { Write-YHLog "archive -> $archive" -Level DRY; exit 0 }
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    if ($OS -eq 'win') { Compress-Archive -Path $stage -DestinationPath $archive -CompressionLevel Optimal }
    else { Invoke-YHNative -FilePath "$env:SystemRoot\System32\tar.exe" -ArgumentList @('-C', $OutDir, '-czf', $archive, $name) }
    $sum = (Get-YHSha256 -Path $archive).ToLowerInvariant()
    Set-Content -LiteralPath "$archive.sha256" -Encoding ASCII -Value ('{0}  {1}' -f $sum, (Split-Path -Leaf $archive))
    Remove-Item -LiteralPath $stage -Recurse -Force
    Write-YHLog "bundle: $archive" -Level OK
    Write-YHLog "sha256: $sum (publish out-of-band; sign CHECKSUMS.sha256 per SIGNATURES.md)" -Level OK
    exit 0
} catch {
    Write-YHLog ("FAILED: {0}" -f $_.Exception.Message) -Level ERROR
    exit 1
} finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
}
