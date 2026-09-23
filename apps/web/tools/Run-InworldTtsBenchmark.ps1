[CmdletBinding()]
param(
    [int]$Iterations = 2,
    [int]$Warmups = 1,
    [int]$Concurrency = 1,
    [string]$ConfigPath = "tools/tts-benchmark/providers.inworld.example.json",
    [string]$CorpusPath = "tools/tts-benchmark/corpus.ko.json",
    [string]$ReportPath = "output/tts-phase2/inworld-tts-2-flash-report.json",
    [string]$SamplesPath = "output/tts-phase2/samples-inworld"
)

$ErrorActionPreference = "Stop"
$credentialPath = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark\inworld.credentials.json"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw "먼저 tools\Save-InworldTtsBenchmarkCredential.ps1을 실행해주세요."
}

function Read-DpapiSecret {
    param([Parameter(Mandatory = $true)][string]$CipherText)
    $secure = ConvertTo-SecureString $CipherText
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$saved = Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json
if ($saved.schemaVersion -ne 1) { throw "지원하지 않는 Inworld 벤치마크 자격정보 형식입니다." }
$env:INWORLD_API_KEY = Read-DpapiSecret ([string]$saved.apiKeyDpapi)
$env:INWORLD_VOICE_ID = [string]$saved.voiceId

try {
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
        if ($LASTEXITCODE -ne 0) { throw "Inworld TTS benchmark failed." }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:INWORLD_API_KEY,Env:INWORLD_VOICE_ID -ErrorAction SilentlyContinue
}
