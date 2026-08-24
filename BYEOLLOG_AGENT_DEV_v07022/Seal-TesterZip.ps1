[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$ZipPath,
    [Parameter(Mandatory = $true)][string]$HashPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $PackageRoot -PathType Container)) {
    throw "Package root does not exist."
}
foreach ($target in @($ZipPath, $HashPath)) {
    if (Test-Path -LiteralPath $target) {
        throw "immutable-output-conflict: tester ZIP or checksum already exists."
    }
}
Compress-Archive -Path (Join-Path $PackageRoot "*") -DestinationPath $ZipPath -CompressionLevel Optimal
if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
    throw "Tester ZIP was not created."
}

$roundTripRoot = Join-Path ([IO.Path]::GetTempPath()) ("ByeollogZipVerify-" + [Guid]::NewGuid().ToString("N"))
try {
    New-Item -ItemType Directory -Path $roundTripRoot | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $roundTripRoot -Force
    if (@(Get-ChildItem -LiteralPath $roundTripRoot -Directory -Force).Count -ne 0) {
        throw "Tester ZIP round-trip contains an unexpected directory."
    }
    $sourceFiles = @(Get-ChildItem -LiteralPath $PackageRoot -File -Force | Sort-Object Name)
    $expandedFiles = @(Get-ChildItem -LiteralPath $roundTripRoot -File -Force | Sort-Object Name)
    if ($sourceFiles.Count -ne $expandedFiles.Count) {
        throw "Tester ZIP round-trip file count does not match."
    }
    foreach ($source in $sourceFiles) {
        $expanded = Join-Path $roundTripRoot $source.Name
        if (-not (Test-Path -LiteralPath $expanded -PathType Leaf)) {
            throw "Tester ZIP round-trip is missing: $($source.Name)"
        }
        $expandedItem = Get-Item -LiteralPath $expanded
        $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $source.FullName).Hash
        $expandedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $expanded).Hash
        if ($source.Length -ne $expandedItem.Length -or $sourceHash -ne $expandedHash) {
            throw "Tester ZIP round-trip integrity mismatch: $($source.Name)"
        }
    }
}
finally {
    if (Test-Path -LiteralPath $roundTripRoot) {
        Remove-Item -LiteralPath $roundTripRoot -Recurse -Force
    }
}

$hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ZipPath).Hash.ToLowerInvariant()
$hashLine = $hash + "  " + [IO.Path]::GetFileName($ZipPath) + [Environment]::NewLine
$hashBytes = [Text.Encoding]::ASCII.GetBytes($hashLine)
$hashStream = [IO.File]::Open($HashPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try {
    $hashStream.Write($hashBytes, 0, $hashBytes.Length)
    $hashStream.Flush($true)
}
finally {
    $hashStream.Dispose()
}
