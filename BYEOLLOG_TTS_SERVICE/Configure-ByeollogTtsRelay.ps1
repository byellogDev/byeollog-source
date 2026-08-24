[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$')]
    [string]$RelayUrl,
    [ValidatePattern('^[a-z0-9-]+$')]
    [string]$WorkerName = "byeollog-tts-relay",
    [string]$StateRoot = (Join-Path $env:LOCALAPPDATA "ByeollogTts")
)

$ErrorActionPreference = "Stop"
$secretPath = Join-Path $StateRoot "relay-admin-secret.dpapi"
$configPath = Join-Path $StateRoot "relay-config.json"
New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null

function Protect-CurrentUserText {
    param([Parameter(Mandatory = $true)][string]$PlainText)
    Add-Type -AssemblyName System.Security
    $plainBytes = [Text.Encoding]::UTF8.GetBytes($PlainText)
    try {
        $protected = [Security.Cryptography.ProtectedData]::Protect(
            $plainBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Convert]::ToBase64String($protected)
    } finally {
        [Array]::Clear($plainBytes, 0, $plainBytes.Length)
    }
}

function Set-PrivateFileAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'
    & $icacls $Path /inheritance:r /grant:r "*$($identity.User.Value):(F)" '*S-1-5-18:(F)' | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to restrict relay secret ACL"
    }
}

function Set-WorkerSecret {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Worker,
        [Parameter(Mandatory = $true)][string]$Value
    )
    $npx = (Get-Command 'npx.cmd' -ErrorAction Stop).Source
    $tempPath = Join-Path $StateRoot "relay-secret-upload.$([Guid]::NewGuid().ToString('N')).json"
    try {
        $payload = @{ $Name = $Value } | ConvertTo-Json -Compress
        [IO.File]::WriteAllText($tempPath, $payload, (New-Object Text.UTF8Encoding($false)))
        Set-PrivateFileAcl -Path $tempPath
        & $npx '--yes' 'wrangler@4.125.0' 'secret' 'bulk' $tempPath '--name' $Worker
        if ($LASTEXITCODE -ne 0) { throw 'Cloudflare Worker secret registration failed' }
    } finally {
        if (Test-Path -LiteralPath $tempPath -PathType Leaf) {
            Remove-Item -LiteralPath $tempPath -Force
        }
    }
}

$secretBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($secretBytes) } finally { $rng.Dispose() }
$secret = [BitConverter]::ToString($secretBytes).Replace('-', '').ToLowerInvariant()
try {
    $protectedText = Protect-CurrentUserText -PlainText $secret
    $tempSecretPath = "$secretPath.$([Guid]::NewGuid().ToString('N')).tmp"
    Set-Content -LiteralPath $tempSecretPath -Value $protectedText -Encoding ASCII -NoNewline
    Set-PrivateFileAcl -Path $tempSecretPath
    Move-Item -LiteralPath $tempSecretPath -Destination $secretPath -Force
    Set-PrivateFileAcl -Path $secretPath

    Set-WorkerSecret -Name 'ADMIN_SECRET' -Worker $WorkerName -Value $secret

    $config = [ordered]@{
        schemaVersion = 1
        relayUrl = $RelayUrl.TrimEnd('/')
        secretPath = $secretPath
        workerName = $WorkerName
        configuredAtUtc = [DateTimeOffset]::UtcNow.ToString('o')
    }
    $tempConfigPath = "$configPath.$([Guid]::NewGuid().ToString('N')).tmp"
    $config | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tempConfigPath -Encoding UTF8
    Move-Item -LiteralPath $tempConfigPath -Destination $configPath -Force
} finally {
    [Array]::Clear($secretBytes, 0, $secretBytes.Length)
    $secret = $null
}

[pscustomobject]@{
    Configured = $true
    RelayUrl = $RelayUrl.TrimEnd('/')
    ConfigPath = $configPath
    SecretProtectedWith = 'DPAPI CurrentUser'
} | Format-List
