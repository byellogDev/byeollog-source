[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$stateDirectory = Join-Path $env:LOCALAPPDATA "ByeollogTtsBenchmark"
$credentialPath = Join-Path $stateDirectory "cartesia.credentials.json"
$catalogPath = Join-Path $stateDirectory "cartesia.korean-voices.json"
$apiVersion = "2026-08-14"

function Convert-SecureTextToPlainText {
    param([Parameter(Mandatory = $true)][Security.SecureString]$SecureText)
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureText)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $encoding = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Content, $encoding)
}

$secureApiKey = Read-Host "Cartesia API Key" -AsSecureString
if ($secureApiKey.Length -lt 8) { throw "Cartesia API Key is too short." }
$plainApiKey = Convert-SecureTextToPlainText $secureApiKey

try {
    $headers = @{
        Authorization = "Bearer $plainApiKey"
        "Cartesia-Version" = $apiVersion
    }
    $uri = "https://api.cartesia.ai/voices?language=ko&limit=100"
    $response = Invoke-RestMethod -Method Get -Uri $uri -Headers $headers
    $voices = @($response.data)
    if ($voices.Count -eq 0) { throw "No Korean Cartesia voices are available for this key." }

    New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
    $credential = [ordered]@{
        schemaVersion = 1
        savedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        apiKeyDpapi = $secureApiKey | ConvertFrom-SecureString
        apiVersion = $apiVersion
    }
    $catalog = [ordered]@{
        schemaVersion = 1
        fetchedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        apiVersion = $apiVersion
        voices = @($voices | ForEach-Object {
            [ordered]@{
                id = [string]$_.id
                name = [string]$_.name
                description = [string]$_.description
                gender = [string]$_.gender
                language = [string]$_.language
                country = [string]$_.country
                isPublic = [bool]$_.is_public
            }
        })
    }

    $credentialTemporaryPath = "$credentialPath.$([Guid]::NewGuid().ToString('N')).tmp"
    $catalogTemporaryPath = "$catalogPath.$([Guid]::NewGuid().ToString('N')).tmp"
    Write-Utf8NoBom -Path $credentialTemporaryPath -Content ($credential | ConvertTo-Json -Depth 4)
    Write-Utf8NoBom -Path $catalogTemporaryPath -Content ($catalog | ConvertTo-Json -Depth 5)
    Move-Item -LiteralPath $credentialTemporaryPath -Destination $credentialPath -Force
    Move-Item -LiteralPath $catalogTemporaryPath -Destination $catalogPath -Force

    $currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $currentUserGrant = "*${currentUserSid}:(OI)(CI)(F)"
    $systemGrant = "*S-1-5-18:(OI)(CI)(F)"
    & icacls.exe $stateDirectory /inheritance:r /grant:r $currentUserGrant $systemGrant | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Could not restrict the credential folder permissions." }

    Write-Output ""
    Write-Output "CARTESIA_TTS_BENCHMARK_CREDENTIAL_SAVED"
    Write-Output "koreanVoiceCount=$($voices.Count)"
    Write-Output "credentialPath=$credentialPath"
    Write-Output "catalogPath=$catalogPath"
} finally {
    Remove-Variable plainApiKey -ErrorAction SilentlyContinue
}
