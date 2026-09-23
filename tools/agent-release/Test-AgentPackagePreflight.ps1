[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$PackagePath,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
# A Windows PowerShell child may inherit PowerShell 7's PSModulePath.
# Load the inbox utility module by its own host path, never skip hashing.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive=[IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($PackagePath))
$scratch=Join-Path ([IO.Path]::GetTempPath()) ('byeollog-release-preflight-'+[Guid]::NewGuid().ToString('N'))
try {
    $entries=@($archive.Entries | Where-Object FullName -eq 'byeollog.exe')
    $manifests=@($archive.Entries | Where-Object FullName -eq 'release-manifest.json')
    if ($entries.Count -ne 1 -or $entries[0].Length -gt 536870912 -or $manifests.Count -ne 1 -or $manifests[0].Length -gt 4194304) { throw 'Invalid release archive.' }
    $reader=New-Object IO.StreamReader($manifests[0].Open())
    try { $manifest=$reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
    if ($manifest.version -ne $Version -or $manifest.product -ne 'byeollog-collector') { throw 'Manifest version/product mismatch.' }
    $appEntries=@($manifest.files | Where-Object path -eq 'byeollog.exe')
    if ($appEntries.Count -ne 1) { throw 'Invalid executable manifest entry.' }
    New-Item -ItemType Directory -Path $scratch | Out-Null
    $exe=Join-Path $scratch 'byeollog.exe'
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0],$exe)
    if ((Get-Item -LiteralPath $exe).Length -ne $appEntries[0].byteSize -or (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $appEntries[0].sha256) { throw 'Executable hash/size mismatch.' }
    & (Join-Path $PSScriptRoot 'Test-ReleaseExecutable.ps1') -ExecutablePath $exe -Version $Version
} finally {
    $archive.Dispose()
    $expectedParent=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
    $resolved=[IO.Path]::GetFullPath($scratch)
    if (-not $resolved.StartsWith($expectedParent,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^byeollog-release-preflight-[0-9a-f]{32}$') { throw 'Unsafe preflight cleanup path.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
