[CmdletBinding()]
param(
    [int]$Iterations = 10,
    [int]$Warmups = 2
)

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
        & node tools/Prepare-CartesiaFallbackBenchmark.mjs
        if ($LASTEXITCODE -ne 0) { throw "Could not prepare the Cartesia fallback benchmark." }
        & node tools/Benchmark-TtsCandidates.mjs `
            --config output/tts-phase2/providers.cartesia.soojin.websocket.generated.json `
            --allow-remote `
            --iterations $Iterations `
            --warmups $Warmups `
            --concurrency 1 `
            --timeout-ms 30000 `
            --corpus tools/tts-benchmark/corpus.max-chat.ko.json `
            --json-output output/tts-phase2/cartesia-soojin-websocket-max-chat-120-report.json `
            --samples-dir output/tts-phase2/samples-cartesia-soojin-websocket-max-chat-120
        if ($LASTEXITCODE -ne 0) { throw "Cartesia Soojin WebSocket benchmark failed." }
    } finally { Pop-Location }
} finally {
    Remove-Item Env:CARTESIA_API_KEY -ErrorAction SilentlyContinue
}
