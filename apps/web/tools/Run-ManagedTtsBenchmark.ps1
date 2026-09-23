[CmdletBinding()]
param(
    [int]$Iterations = 10,
    [int]$Warmups = 2,
    [int]$Concurrency = 1
)

$ErrorActionPreference = "Stop"
$credentialPath = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark\credentials.json"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw "먼저 tools\Save-TtsBenchmarkCredentials.ps1을 실행해 후보 API 키와 한국어 Voice ID를 저장해주세요."
}

function Read-DpapiSecret {
    param([Parameter(Mandatory = $true)][string]$CipherText)
    $secure = ConvertTo-SecureString $CipherText
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$saved = Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json
if ($saved.schemaVersion -ne 1) { throw "지원하지 않는 TTS 벤치마크 자격정보 형식입니다." }
$env:CARTESIA_API_KEY = Read-DpapiSecret ([string]$saved.cartesiaApiKeyDpapi)
$env:CARTESIA_VOICE_ID = [string]$saved.cartesiaVoiceId
$env:ELEVENLABS_API_KEY = Read-DpapiSecret ([string]$saved.elevenLabsApiKeyDpapi)
$env:ELEVENLABS_VOICE_ID = [string]$saved.elevenLabsVoiceId

try {
    Push-Location $projectRoot
    try {
        & node tools/Benchmark-TtsCandidates.mjs `
            --config tools/tts-benchmark/providers.managed.example.json `
            --allow-remote `
            --iterations $Iterations `
            --warmups $Warmups `
            --concurrency $Concurrency `
            --timeout-ms 30000 `
            --json-output output/tts-phase2/managed-candidates-report.json `
            --samples-dir output/tts-phase2/samples-managed
        if ($LASTEXITCODE -ne 0) { throw "관리형 TTS 후보 벤치마크가 실패했습니다." }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:CARTESIA_API_KEY,Env:CARTESIA_VOICE_ID,Env:ELEVENLABS_API_KEY,Env:ELEVENLABS_VOICE_ID -ErrorAction SilentlyContinue
}
