[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $PSScriptRoot
$credentialRoot = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark"
$inworldPath = Join-Path $credentialRoot "inworld.credentials.json"
$cartesiaPath = Join-Path $credentialRoot "cartesia.credentials.json"
if (-not (Test-Path -LiteralPath $inworldPath -PathType Leaf)) { throw "Inworld 벤치마크 인증정보가 없습니다." }
if (-not (Test-Path -LiteralPath $cartesiaPath -PathType Leaf)) { throw "Cartesia 벤치마크 인증정보가 없습니다." }

function Read-DpapiSecret {
    param([Parameter(Mandatory = $true)][string]$CipherText)
    $secure = ConvertTo-SecureString $CipherText
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$inworld = Get-Content -Raw -LiteralPath $inworldPath | ConvertFrom-Json
$cartesia = Get-Content -Raw -LiteralPath $cartesiaPath | ConvertFrom-Json
$env:INWORLD_API_KEY = Read-DpapiSecret ([string]$inworld.apiKeyDpapi)
$env:CARTESIA_API_KEY = Read-DpapiSecret ([string]$cartesia.apiKeyDpapi)

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
if (-not $adcPath) { throw "Google 로컬 인증이 없습니다." }
$hadGoogleOverride = [bool]$env:GOOGLE_APPLICATION_CREDENTIALS
if (-not $hadGoogleOverride) { $env:GOOGLE_APPLICATION_CREDENTIALS = $adcPath }

try {
    Push-Location $projectRoot
    try {
        & node tools/Benchmark-TtsCandidates.mjs `
            --config tools/tts-benchmark/providers.tts-final-wink.json `
            --allow-remote `
            --iterations 1 `
            --warmups 1 `
            --concurrency 1 `
            --timeout-ms 30000 `
            --corpus tools/tts-benchmark/corpus.final-wink.ko.json `
            --json-output output/tts-phase2/tts-final-wink-report.json `
            --samples-dir output/tts-phase2/samples-tts-final-wink
        if ($LASTEXITCODE -ne 0) { throw "최종 TTS 윙크 비교 합성에 실패했습니다." }
        & node tools/Build-TtsWinkFinalBlindPack.mjs
        if ($LASTEXITCODE -ne 0) { throw "최종 TTS 윙크 블라인드 팩 생성에 실패했습니다." }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:INWORLD_API_KEY,Env:CARTESIA_API_KEY -ErrorAction SilentlyContinue
    if (-not $hadGoogleOverride) { Remove-Item Env:GOOGLE_APPLICATION_CREDENTIALS -ErrorAction SilentlyContinue }
}
