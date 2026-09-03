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

& $compiler $installerScript
if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compilation failed with exit code $LASTEXITCODE."
}

$output = Join-Path $projectRoot "agent-updates\releases\0.7.0.140\Byeollog-Agent-Setup-v0.7.0.140.exe"
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
