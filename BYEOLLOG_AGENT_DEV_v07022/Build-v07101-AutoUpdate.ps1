[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = [IO.Path]::GetFullPath($PSScriptRoot)
$dist = Join-Path $root 'DIST'
$baseline = Join-Path $dist 'byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64'
$publishedExe = Join-Path $root 'bin\Release\net8.0-windows\win-x64\publish\byeollog.exe'
$releaseSequence = 7101
$packageName = 'byeollog_agent_v07101_SLOW_WATER_VFX_WIN_X64'
$package = Join-Path $dist $packageName
$zip = $package + '.zip'
$zipHash = $zip + '.sha256.txt'
$staging = Join-Path $dist ('.staging-v07101-' + [Guid]::NewGuid().ToString('N'))
$stagingZip = $staging + '.zip'
$stagingHash = $stagingZip + '.sha256.txt'

foreach ($path in @($package, $zip, $zipHash)) {
    if (Test-Path -LiteralPath $path) { throw "immutable-output-conflict: $path" }
}
if (-not (Test-Path -LiteralPath $baseline -PathType Container)) {
    throw 'The sealed v0.7.0.32 protocol baseline is missing.'
}
if (-not (Test-Path -LiteralPath $publishedExe -PathType Leaf)) {
    throw 'The published v0.7.0.101 executable is missing.'
}

$fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($publishedExe)
if ($fileVersion.FileVersion -ne '0.7.0.101' -or
    -not $fileVersion.ProductVersion.StartsWith('0.7.0.101', [StringComparison]::Ordinal)) {
    throw "Published executable identity is invalid: $($fileVersion.FileVersion) / $($fileVersion.ProductVersion)"
}

try {
    & (Join-Path $baseline 'Install-Byeollog.ps1') -Mode VerifyPackage
    if (-not $?) { throw 'The v0.7.0.32 protocol baseline failed verification.' }

    New-Item -ItemType Directory -Path $staging | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $baseline -File -Force) {
        if ($item.Name -in @('byeollog.exe', 'release-manifest.json', 'SHA256SUMS.txt')) { continue }
        Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $staging $item.Name)
    }
    Copy-Item -LiteralPath $publishedExe -Destination (Join-Path $staging 'byeollog.exe')

    $baselineFiles = @(Get-ChildItem -LiteralPath $baseline -File -Force |
        Where-Object { $_.Name -notin @('byeollog.exe', 'release-manifest.json', 'SHA256SUMS.txt') } |
        Sort-Object Name)
    $stagingFiles = @(Get-ChildItem -LiteralPath $staging -File -Force |
        Where-Object { $_.Name -ne 'byeollog.exe' } |
        Sort-Object Name)
    if ($baselineFiles.Count -ne $stagingFiles.Count) {
        throw "Protocol v1 install-root file count drift: $($baselineFiles.Count) / $($stagingFiles.Count)"
    }
    foreach ($item in $stagingFiles) {
        $baselinePath = Join-Path $baseline $item.Name
        if (-not (Test-Path -LiteralPath $baselinePath -PathType Leaf)) {
            throw "Protocol v1 unexpected install-root file: $($item.Name)"
        }
        $baselineHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $baselinePath).Hash
        $stagingHashValue = (Get-FileHash -Algorithm SHA256 -LiteralPath $item.FullName).Hash
        if ($baselineHash -cne $stagingHashValue) { throw "Protocol v1 baseline drift: $($item.Name)" }
    }

    & (Join-Path $root 'New-ReleaseManifest.ps1') -PackageRoot $staging -Version '0.7.0.101'
    if (-not $?) { throw 'Release manifest generation failed.' }
    & (Join-Path $staging 'Install-Byeollog.ps1') -Mode VerifyPackage
    if (-not $?) { throw 'The v0.7.0.101 package failed verification.' }
    & (Join-Path $root 'Seal-TesterZip.ps1') -PackageRoot $staging -ZipPath $stagingZip -HashPath $stagingHash
    if (-not $?) { throw 'The v0.7.0.101 ZIP round-trip gate failed.' }

    Move-Item -LiteralPath $staging -Destination $package
    Move-Item -LiteralPath $stagingZip -Destination $zip
    Move-Item -LiteralPath $stagingHash -Destination $zipHash

    [PSCustomObject]@{
        Version = '0.7.0.101'
        ReleaseSequence = $releaseSequence
        Package = $package
        Zip = $zip
        ZipBytes = (Get-Item -LiteralPath $zip).Length
        ZipSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $zip).Hash.ToLowerInvariant()
        ExeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $package 'byeollog.exe')).Hash.ToLowerInvariant()
        InnerManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $package 'release-manifest.json')).Hash.ToLowerInvariant()
    } | Format-List
}
finally {
    foreach ($path in @($staging, $stagingZip, $stagingHash)) {
        if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
}
