[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ExecutablePath,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
if ($Version -notmatch '^\d+\.\d+\.\d+\.\d+$') { throw 'Invalid release version.' }
$releaseExe=[IO.Path]::GetFullPath($ExecutablePath)
$item=Get-Item -LiteralPath $releaseExe
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe release executable.' }
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($releaseExe).FileVersion -ne $Version) { throw 'Release file version mismatch.' }
$process=Start-Process -FilePath $releaseExe -ArgumentList @('--update-preflight',$Version) -WindowStyle Hidden -PassThru
try {
    if (-not $process.WaitForExit(30000)) { $process.Kill(); $process.WaitForExit(); throw 'Release executable preflight timeout.' }
    if ($process.ExitCode -ne 0) { throw "Release executable preflight failed: expected=$Version exit=$($process.ExitCode)" }
    [pscustomobject]@{version=$Version;preflightVerified=$true}
} finally { $process.Dispose() }
