[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$stateDirectory = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark"
$targetPath = Join-Path $stateDirectory "inworld.credentials.json"

function Convert-SecureTextToPlainText {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureText)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureText)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$secureApiKey = Read-Host "Inworld Basic (Base64) API Key" -AsSecureString
if ($secureApiKey.Length -lt 8) { throw "Inworld API Key is too short." }
$plainApiKey = Convert-SecureTextToPlainText $secureApiKey
try {
    $headers = @{ Authorization = "Basic $plainApiKey" }
    $response = Invoke-RestMethod -Method Get -Uri "https://api.inworld.ai/voices/v1/voices?languages=KO_KR" -Headers $headers
    $voices = @($response.voices)
    if ($voices.Count -eq 0) { throw "No Korean voices are available for this key." }

    Write-Output ""
    Write-Output "Choose a Korean voice by number. Voice IDs are not secrets."
    for ($index = 0; $index -lt $voices.Count; $index++) {
        $voice = $voices[$index]
        $description = ([string]$voice.description).Replace("`r", " ").Replace("`n", " ")
        if ($description.Length -gt 90) { $description = $description.Substring(0, 90) + "..." }
        Write-Output ("[{0}] {1} | {2} | {3}" -f ($index + 1), $voice.displayName, $voice.voiceId, $description)
    }
    $selectionText = (Read-Host "Voice number").Trim()
    $selection = 0
    if (-not [int]::TryParse($selectionText, [ref]$selection) -or $selection -lt 1 -or $selection -gt $voices.Count) {
        throw "The voice number is invalid."
    }
    $selectedVoice = $voices[$selection - 1]

    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $payload = [ordered]@{
        schemaVersion = 1
        savedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        apiKeyDpapi = $secureApiKey | ConvertFrom-SecureString
        voiceId = [string]$selectedVoice.voiceId
        voiceDisplayName = [string]$selectedVoice.displayName
        modelId = "inworld-tts-2-flash"
    }
    $temporaryPath = "$targetPath.$([Guid]::NewGuid().ToString('N')).tmp"
    $payload | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $targetPath -Force
    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $currentUserGrant = "*${currentUserSid}:(OI)(CI)(F)"
    $systemGrant = "*S-1-5-18:(OI)(CI)(F)"
    & icacls.exe $stateDirectory /inheritance:r /grant:r $currentUserGrant $systemGrant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict the credential folder permissions." }
    Write-Output ""
    Write-Output "INWORLD_TTS_BENCHMARK_CREDENTIAL_SAVED"
    Write-Output "voice=$($selectedVoice.displayName)"
    Write-Output "path=$targetPath"
} finally {
    Remove-Variable plainApiKey -ErrorAction SilentlyContinue
}
