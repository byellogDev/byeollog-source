[CmdletBinding()]
param(
    [int]$Iterations = 2,
    [int]$Warmups = 1,
    [int]$Concurrency = 1,
    [string]$ConfigPath = "tools/tts-benchmark/providers.google-chirp3.korean-female.json",
    [string]$CorpusPath = "tools/tts-benchmark/corpus.voice-quality.ko.json",
    [string]$ReportPath = "output/tts-phase2/google-chirp3-korean-report.json",
    [string]$SamplesPath = "output/tts-phase2/samples-google-chirp3-korean"
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$gcloudCommand = Get-Command gcloud -ErrorAction SilentlyContinue
$installedGcloud = Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
if (-not $gcloudCommand -and -not (Test-Path -LiteralPath $installedGcloud -PathType Leaf)) {
    throw "Google Cloud CLI가 없습니다. https://cloud.google.com/sdk/docs/install 에서 설치한 뒤 다시 실행해주세요."
}

$adcCandidates = [Collections.Generic.List[string]]::new()
if ($env:GOOGLE_APPLICATION_CREDENTIALS) { $adcCandidates.Add($env:GOOGLE_APPLICATION_CREDENTIALS) }
$adcCandidates.Add((Join-Path $env:APPDATA "gcloud\application_default_credentials.json"))
$adcCandidates.Add((Join-Path $env:USERPROFILE "AppData\Roaming\gcloud\application_default_credentials.json"))
$packagesRoot = Join-Path $env:LOCALAPPDATA "Packages"
if (Test-Path -LiteralPath $packagesRoot -PathType Container) {
    Get-ChildItem -LiteralPath $packagesRoot -Directory -Filter "OpenAI.Codex_*" -ErrorAction SilentlyContinue | ForEach-Object {
        $adcCandidates.Add((Join-Path $_.FullName "LocalCache\Roaming\gcloud\application_default_credentials.json"))
    }
}
$adcPath = $adcCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $adcPath) {
    throw "Google 로컬 인증이 없습니다. gcloud auth application-default login 을 한 번 실행해주세요."
}
$hadCredentialOverride = [bool]$env:GOOGLE_APPLICATION_CREDENTIALS
if (-not $hadCredentialOverride) { $env:GOOGLE_APPLICATION_CREDENTIALS = $adcPath }

Push-Location $projectRoot
try {
    & node tools/Benchmark-TtsCandidates.mjs `
        --config $ConfigPath `
        --allow-remote `
        --iterations $Iterations `
        --warmups $Warmups `
        --concurrency $Concurrency `
        --timeout-ms 30000 `
        --corpus $CorpusPath `
        --json-output $ReportPath `
        --samples-dir $SamplesPath
    if ($LASTEXITCODE -ne 0) { throw "Google Chirp 3 HD benchmark failed." }

    & node tools/Build-GoogleChirpVoiceBlindPack.mjs
    if ($LASTEXITCODE -ne 0) { throw "Google Chirp 3 HD blind pack build failed." }
} finally {
    if (-not $hadCredentialOverride) { Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue }
    Pop-Location
}
