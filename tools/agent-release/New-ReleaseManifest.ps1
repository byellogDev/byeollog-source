[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$ExpectedSignerThumbprint = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw "Release version is invalid." }
$package = [IO.Path]::GetFullPath($PackageRoot)
if (-not (Test-Path -LiteralPath $package -PathType Container)) { throw "Package root is missing." }
$packageItem = Get-Item -LiteralPath $package
if (($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Package root cannot be a reparse point." }

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
& (Join-Path $PSScriptRoot 'Test-ReleaseExecutable.ps1') -ExecutablePath (Join-Path $package 'byeollog.exe') -Version $Version | Out-Null
$manifestName = "release-manifest.json"
$checksumsName = "SHA256SUMS.txt"
$manifestPath = Join-Path $package $manifestName
$checksumsPath = Join-Path $package $checksumsName

# The tester package is intentionally flat. Every distributable file must appear
# here so a stale or accidentally added file cannot silently ship.
$expectedFiles = @(
    [ordered]@{ path = "byeollog.exe"; role = "app"; required = $true; maxBytes = 536870912 },
    [ordered]@{ path = "WebView2Loader.dll"; role = "app"; required = $false; maxBytes = 33554432 },
    [ordered]@{ path = "LAUNCH_BYEOLLOG.cmd"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "Byeollog-Launcher.ps1"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "Install-Byeollog.ps1"; role = "install_root"; required = $true; maxBytes = 4194304 },
    [ordered]@{ path = "ROLLBACK_LAST_VERSION.cmd"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "VERIFY_INSTALL.cmd"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "RESTORE_PREUPDATE_STATE.cmd"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "CREATE_SUPPORT_BUNDLE.cmd"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "RUN_REPLAY_CANDIDATE_CHECK.cmd"; role = "install_root"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "Collect-SupportBundle.ps1"; role = "install_root"; required = $true; maxBytes = 4194304 },
    [ordered]@{ path = "INSTALL_OR_UPDATE.cmd"; role = "package_tool"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "INSTALL_AND_CHECK.cmd"; role = "package_tool"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "RUN_G4_CANARY_PREP.cmd"; role = "package_tool"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "RUN_TESTER_READINESS.cmd"; role = "package_tool"; required = $true; maxBytes = 1048576 },
    [ordered]@{ path = "Test-TesterEnvironment.ps1"; role = "package_tool"; required = $true; maxBytes = 4194304 },
    [ordered]@{ path = "README_TESTER_v070_RC2_KO.txt"; role = "documentation"; required = $true; maxBytes = 4194304 },
    [ordered]@{ path = "G4_CANARY_v070_RC2_KO.md"; role = "documentation"; required = $true; maxBytes = 4194304 },
    [ordered]@{ path = "RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt"; role = "documentation"; required = $true; maxBytes = 4194304 }
)

foreach ($generated in @($manifestPath, $checksumsPath)) {
    if (Test-Path -LiteralPath $generated) {
        throw "immutable-output-conflict: generated package metadata already exists."
    }
}

$allowedNames = @{}
foreach ($definition in $expectedFiles) { $allowedNames[[string]$definition.path] = $true }

$actualItems = @(Get-ChildItem -LiteralPath $package -Force)
foreach ($item in $actualItems) {
    if ($item.PSIsContainer) { throw "Tester package cannot contain directories: $($item.Name)" }
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Tester package cannot contain reparse points: $($item.Name)" }
    if (-not $allowedNames.ContainsKey($item.Name)) { throw "Tester package contains an unapproved file: $($item.Name)" }
}

$entries = @()
$totalBytes = [int64]0
foreach ($definition in $expectedFiles) {
    $name = [string]$definition.path
    $path = Join-Path $package $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        if ([bool]$definition.required) { throw "Required tester package file is missing: $name" }
        continue
    }

    $item = Get-Item -LiteralPath $path
    if ($item.Length -le 0 -or $item.Length -gt [int64]$definition.maxBytes) {
        throw "Tester package file size is invalid: $name"
    }
    $totalBytes += [int64]$item.Length
    if ($totalBytes -gt 805306368) { throw "Tester package payload exceeds the 768 MiB safety limit." }

    $entries += [ordered]@{
        path = $name
        role = [string]$definition.role
        byteSize = [int64]$item.Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash.ToLowerInvariant()
    }
}

$thumbprint = ($ExpectedSignerThumbprint -replace '\s', '').ToUpperInvariant()
$authenticity = [ordered]@{
    mode = "trusted_channel_internal"
    scope = "package_integrity_only"
    signerThumbprint = $null
}
if (-not [string]::IsNullOrWhiteSpace($thumbprint)) {
    if ($thumbprint -notmatch '^[0-9A-F]{40}$') { throw "Expected signer thumbprint must be a 40-character SHA-1 certificate thumbprint." }
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $package "byeollog.exe")
    if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid -or $null -eq $signature.SignerCertificate) {
        throw "byeollog.exe does not have a valid Authenticode signature."
    }
    $actualThumbprint = ([string]$signature.SignerCertificate.Thumbprint -replace '\s', '').ToUpperInvariant()
    if ($actualThumbprint -ne $thumbprint) { throw "byeollog.exe signer thumbprint does not match the expected publisher." }
    $authenticity.mode = "authenticode_pinned"
    $authenticity.scope = "executable_publisher_and_package_integrity"
    $authenticity.signerThumbprint = $thumbprint
}

$manifest = [ordered]@{
    schemaVersion = 2
    product = "byeollog-collector"
    version = $Version
    platform = "win-x64"
    packageLayout = "flat_v1"
    generatedAtUtc = [DateTimeOffset]::UtcNow.ToString("O")
    fileCount = $entries.Count
    totalByteSize = $totalBytes
    authenticity = $authenticity
    files = $entries
}
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 10), $utf8NoBom)

$hashLines = Get-ChildItem -LiteralPath $package -File -Force |
    Where-Object { $_.Name -ne $checksumsName } |
    Sort-Object Name |
    ForEach-Object {
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    }
[IO.File]::WriteAllLines($checksumsPath, $hashLines, [Text.Encoding]::ASCII)

Write-Host "Release manifest v2 created: $($entries.Count) files, $totalBytes bytes"
Write-Host "Authenticity mode: $($authenticity.mode)"
