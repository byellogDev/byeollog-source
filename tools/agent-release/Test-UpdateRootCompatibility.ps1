[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BaselineRoot,[Parameter(Mandatory=$true)][string]$CandidateRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$old=Get-Content -LiteralPath (Join-Path $BaselineRoot 'release-manifest.json') -Raw | ConvertFrom-Json
$candidate=Get-Content -LiteralPath (Join-Path $CandidateRoot 'release-manifest.json') -Raw | ConvertFrom-Json
$roots=@($old.files | Where-Object role -eq 'install_root')
$next=@($candidate.files | Where-Object role -eq 'install_root')
if ($roots.Count -ne 9 -or $next.Count -ne 9) { throw 'Protocol v1 root file set changed.' }
foreach ($file in $roots) {
    $match=@($next | Where-Object path -eq $file.path)
    if ($match.Count -ne 1 -or $match[0].sha256 -cne $file.sha256 -or $match[0].byteSize -ne $file.byteSize) { throw "update_install_root_changed: $($file.path)" }
    foreach ($dir in @($BaselineRoot,$CandidateRoot)) {
        $actual=Join-Path $dir $file.path
        if ((Get-Item -LiteralPath $actual).Length -ne $file.byteSize -or (Get-FileHash -LiteralPath $actual -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw "Root bytes differ: $($file.path)" }
    }
}
Write-Output 'Protocol v1: all 9 installed root files preserved.'
