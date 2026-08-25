[CmdletBinding()]
param(
    [string]$CacheRoot = (Join-Path $PSScriptRoot '.build-cache')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$llvmVersion = '20260616'
$llvmArchiveName = "llvm-mingw-$llvmVersion-ucrt-x86_64.zip"
$llvmUri = "https://github.com/mstorsjo/llvm-mingw/releases/download/$llvmVersion/$llvmArchiveName"
$llvmSha256 = 'b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35'
$obsCommit = '144599fbff18e348652ccadfc3ca08794a03d970'
$stretchCommit = '57b93f4e9206a089a45387eaa39bdc9f310d3308'
$linearCommit = 'ec38d3332c7e9ce88a2fd969003d170baa2316b6'

$cache = [IO.Path]::GetFullPath($CacheRoot)
$archive = Join-Path $cache $llvmArchiveName
$llvmRoot = Join-Path $cache 'llvm-mingw'
$obsRoot = Join-Path $cache 'obs-studio'
$vendorRoot = Join-Path $PSScriptRoot 'vendor'
$stretchRoot = Join-Path $vendorRoot 'signalsmith-stretch'
$artifacts = Join-Path $PSScriptRoot 'artifacts'
$importLibrary = Join-Path $artifacts 'libobs.a'
$plugin = Join-Path $artifacts 'byeollog-voice-filter.dll'

New-Item -ItemType Directory -Path $cache -Force | Out-Null
New-Item -ItemType Directory -Path $artifacts -Force | Out-Null

if (-not (Test-Path -LiteralPath $llvmRoot -PathType Container)) {
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) {
        Invoke-WebRequest -Uri $llvmUri -OutFile $archive
    }
    $actualArchiveHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualArchiveHash -cne $llvmSha256) {
        throw "llvm-mingw archive hash mismatch: $actualArchiveHash"
    }
    $extract = Join-Path $cache ('llvm-extract-' + [Guid]::NewGuid().ToString('N'))
    try {
        Expand-Archive -LiteralPath $archive -DestinationPath $extract
        $inner = @(Get-ChildItem -LiteralPath $extract -Directory)
        if ($inner.Count -ne 1) { throw 'Unexpected llvm-mingw archive layout.' }
        Move-Item -LiteralPath $inner[0].FullName -Destination $llvmRoot
    }
    finally {
        if (Test-Path -LiteralPath $extract) {
            Remove-Item -LiteralPath $extract -Recurse -Force
        }
    }
}

function Ensure-PinnedRepository {
    param(
        [Parameter(Mandatory)][string]$Uri,
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Commit
    )
    if (-not (Test-Path -LiteralPath (Join-Path $Path '.git') -PathType Container)) {
        git clone --filter=blob:none --no-checkout $Uri $Path
        if ($LASTEXITCODE -ne 0) { throw "git clone failed: $Uri" }
    }
    git -C $Path fetch --depth 1 origin $Commit
    if ($LASTEXITCODE -ne 0) { throw "git fetch failed: $Uri@$Commit" }
    git -C $Path checkout --detach --force $Commit
    if ($LASTEXITCODE -ne 0) { throw "git checkout failed: $Uri@$Commit" }
    $actual = (git -C $Path rev-parse HEAD).Trim()
    if ($actual -cne $Commit) { throw "repository commit mismatch: $actual / $Commit" }
}

Ensure-PinnedRepository `
    -Uri 'https://github.com/obsproject/obs-studio.git' `
    -Path $obsRoot `
    -Commit $obsCommit

$vendoredFiles = @{
    'signalsmith-stretch\signalsmith-stretch.h' = '45a0b93b1e00257014d48e7ae494ec4e604f56b4ee15189a355cd9794653a37d'
    'signalsmith-stretch\LICENSE.txt' = '16bf62d475af149d96a24853e77c9e0d939259a9d55b23b41da7f9939db85085'
    'signalsmith-linear\stft.h' = '9944ace90a3dc3a28b3c1dad3ca459aa71e189159f4aca9c7eb242d61cd31784'
    'signalsmith-linear\fft.h' = 'af0df3ff84c6f69ec00f09e0e53634b7ccacd3198a4acb2b482cb7d93854d207'
    'signalsmith-linear\LICENSE.txt' = 'a91f5703b0f5fa22e8c14a8bd854559a7c512bbe58656ea8bdcd4964e923ab2f'
}
foreach ($relative in $vendoredFiles.Keys) {
    $vendoredPath = Join-Path $vendorRoot $relative
    if (-not (Test-Path -LiteralPath $vendoredPath -PathType Leaf)) {
        throw "Vendored DSP source is missing: $relative"
    }
    $actual = (Get-FileHash -LiteralPath $vendoredPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne $vendoredFiles[$relative]) {
        throw "Vendored DSP source hash mismatch: $relative / $actual"
    }
}

$dllTool = Join-Path $llvmRoot 'bin\llvm-dlltool.exe'
$clang = Join-Path $llvmRoot 'bin\clang++.exe'
$readObj = Join-Path $llvmRoot 'bin\llvm-readobj.exe'
foreach ($tool in @($dllTool, $clang, $readObj)) {
    if (-not (Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Build tool is missing: $tool" }
}

& $dllTool `
    -m 'i386:x86-64' `
    -d (Join-Path $PSScriptRoot 'obs.def') `
    -l $importLibrary `
    -D 'obs.dll'
if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the OBS import library.' }

$compileArguments = @(
    '--target=x86_64-w64-windows-gnu',
    '-std=c++20',
    '-O3',
    '-DNDEBUG',
    '-DUNICODE',
    '-D_UNICODE',
    '-D_WIN32_WINNT=0x0A00',
    '-Werror',
    '-Wno-dll-attribute-on-redeclaration',
    '-I', (Join-Path $obsRoot 'libobs'),
    '-I', $stretchRoot,
    '-I', $vendorRoot,
    '-shared',
    '-static',
    '-Wl,--no-insert-timestamp',
    '-Wl,--enable-stdcall-fixup',
    (Join-Path $PSScriptRoot 'plugin.cpp'),
    $importLibrary,
    '-o', $plugin
)
& $clang @compileArguments
if ($LASTEXITCODE -ne 0) { throw 'Failed to compile the Byeollog OBS voice filter.' }

$inspection = (& $readObj --coff-exports --needed-libs $plugin) -join "`n"
foreach ($requiredExport in @(
    'obs_module_load', 'obs_module_set_pointer', 'obs_module_ver',
    'obs_module_name', 'obs_module_description', 'obs_module_author'
)) {
    if ($inspection -notmatch "Name: $([Regex]::Escape($requiredExport))") {
        throw "Required OBS export is missing: $requiredExport"
    }
}
foreach ($allowedLibrary in @(
    'KERNEL32.dll', 'obs.dll',
    'api-ms-win-crt-convert-l1-1-0.dll',
    'api-ms-win-crt-environment-l1-1-0.dll',
    'api-ms-win-crt-filesystem-l1-1-0.dll',
    'api-ms-win-crt-heap-l1-1-0.dll',
    'api-ms-win-crt-locale-l1-1-0.dll',
    'api-ms-win-crt-math-l1-1-0.dll',
    'api-ms-win-crt-private-l1-1-0.dll',
    'api-ms-win-crt-runtime-l1-1-0.dll',
    'api-ms-win-crt-stdio-l1-1-0.dll',
    'api-ms-win-crt-string-l1-1-0.dll',
    'api-ms-win-crt-utility-l1-1-0.dll'
)) {
    $inspection = $inspection.Replace("  $allowedLibrary`n", '')
}
if ($inspection -match '(?s)NeededLibraries \[\s+([^\]]+)') {
    throw "Unexpected dynamic library dependency:`n$($Matches[1])"
}

[PSCustomObject]@{
    Plugin = $plugin
    Bytes = (Get-Item -LiteralPath $plugin).Length
    Sha256 = (Get-FileHash -LiteralPath $plugin -Algorithm SHA256).Hash.ToLowerInvariant()
    ObsCommit = $obsCommit
    SignalsmithStretchCommit = $stretchCommit
    SignalsmithLinearCommit = $linearCommit
} | Format-List
