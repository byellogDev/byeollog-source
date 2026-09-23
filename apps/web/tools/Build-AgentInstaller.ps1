[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$installerScript = Join-Path $projectRoot "installer\ByeollogAgentSetup.iss"
$compilerCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe"),
    (Join-Path $env:ProgramFiles "Inno Setup 6\ISCC.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6\ISCC.exe")
)
$compiler = $compilerCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1

if (-not $compiler) {
    throw "Inno Setup 6 compiler was not found. Install JRSoftware.InnoSetup with winget first."
}
if (-not (Test-Path -LiteralPath $installerScript -PathType Leaf)) {
    throw "Installer definition is missing: $installerScript"
}

$definition=Get-Content -LiteralPath $installerScript -Raw
$version=[regex]::Match($definition,'#define AppVersion "([0-9.]+)"').Groups[1].Value
$packageFile=[regex]::Match($definition,'#define PackageFile "([^"]+)"').Groups[1].Value
if ($version -notmatch '^\d+\.\d+\.\d+\.\d+$' -or $packageFile -notmatch '^byeollog_[A-Za-z0-9_]+\.zip$') { throw 'Invalid installer release identity.' }
$packagePath=Join-Path $projectRoot "agent-updates\releases\$version\$packageFile"
& (Join-Path $projectRoot '..\BYEOLLOG_AGENT_DEV_v07022\Test-AgentPackagePreflight.ps1') -PackagePath $packagePath -Version $version | Out-Null
& $compiler $installerScript
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
}

$output = Join-Path $projectRoot "agent-updates\releases\$version\Byeollog-Wallpaper-Setup-v$version.exe"
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) {
    throw "Installer output is missing: $output"
}

$item = Get-Item -LiteralPath $output
$hash = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
[ordered]@{
    path = $item.FullName
    byteSize = $item.Length
    sha256 = $hash
} | ConvertTo-Json
