[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$stateDirectory = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark"
$targetPath = Join-Path $stateDirectory "credentials.json"

function Read-RequiredSecret {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    $secure = Read-Host $Prompt -AsSecureString
    if ($secure.Length -lt 8) { throw "$Prompt 값이 너무 짧습니다." }
    return $secure | ConvertFrom-SecureString
}

function Read-RequiredText {
    param([Parameter(Mandatory = $true)][string]$Prompt)
    $value = (Read-Host $Prompt).Trim()
    if ([string]::IsNullOrWhiteSpace($value) -or $value.Length -gt 200) {
        throw "$Prompt 값을 확인해주세요."
    }
    return $value
}

New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
$payload = [ordered]@{
    schemaVersion = 1
    savedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
    cartesiaApiKeyDpapi = Read-RequiredSecret "Cartesia API Key"
    cartesiaVoiceId = Read-RequiredText "Cartesia 한국어 Voice ID"
    elevenLabsApiKeyDpapi = Read-RequiredSecret "ElevenLabs API Key"
    elevenLabsVoiceId = Read-RequiredText "ElevenLabs 한국어 Voice ID"
}
$temporaryPath = "$targetPath.$([Guid]::NewGuid().ToString('N')).tmp"
$payload | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
Move-Item -LiteralPath $temporaryPath -Destination $targetPath -Force
& icacls.exe $stateDirectory /inheritance:r /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().User.Value):(OI)(CI)(F)" "S-1-5-18:(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "TTS 벤치마크 자격정보 폴더 권한을 제한하지 못했습니다." }
Write-Output "TTS_BENCHMARK_CREDENTIALS_SAVED"
Write-Output "path=$targetPath"
