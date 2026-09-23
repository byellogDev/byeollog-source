[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$credentialPath = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark\cartesia.credentials.json"
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $credentialPath -PathType Leaf)) {
    throw "Run tools\Save-CartesiaTtsBenchmarkCredential.ps1 first."
}

function Read-DpapiSecret {
    param([Parameter(Mandatory = $true)][string]$CipherText)
    $secure = ConvertTo-SecureString $CipherText
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$saved = Get-Content -Raw -LiteralPath $credentialPath | ConvertFrom-Json
if ($saved.schemaVersion -ne 1) { throw "Unsupported Cartesia benchmark credential format." }
$env:CARTESIA_API_KEY = Read-DpapiSecret ([string]$saved.apiKeyDpapi)

try {
    Push-Location $projectRoot
    try {
        & node tools/Prepare-CartesiaVoiceBenchmark.mjs
        if ($LASTEXITCODE -ne 0) { throw "Could not prepare Cartesia voice candidates." }
        & node tools/Benchmark-TtsCandidates.mjs `
            --config output/tts-phase2/providers.cartesia.korean-voices.generated.json `
            --allow-remote `
            --iterations 1 `
            --warmups 0 `
            --concurrency 1 `
            --timeout-ms 30000 `
            --corpus tools/tts-benchmark/corpus.voice-quality.ko.json `
            --json-output output/tts-phase2/cartesia-korean-voices-report.json `
            --samples-dir output/tts-phase2/samples-cartesia-korean-voices
        if ($LASTEXITCODE -ne 0) { throw "Cartesia Korean voice benchmark failed." }
        & node tools/Build-CartesiaVoiceBlindPack.mjs
        if ($LASTEXITCODE -ne 0) { throw "Could not build the Cartesia blind voice pack." }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:CARTESIA_API_KEY -ErrorAction SilentlyContinue
}
