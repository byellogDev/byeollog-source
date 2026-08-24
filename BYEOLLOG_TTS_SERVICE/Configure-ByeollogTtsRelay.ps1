[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$')]
    [string]$RelayUrl,
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
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        $identity.User,
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
        (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),
        [Security.AccessControl.FileSystemRights]::FullControl,
        [Security.AccessControl.AccessControlType]::Allow
    )))
    Set-Acl -LiteralPath $Path -AclObject $acl
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

    $secret | npx --yes wrangler@4.125.0 secret put ADMIN_SECRET --name $WorkerName
    if ($LASTEXITCODE -ne 0) { throw "Cloudflare Worker secret registration failed" }

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
