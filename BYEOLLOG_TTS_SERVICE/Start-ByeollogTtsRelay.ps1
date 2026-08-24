[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA "ByeollogTts\relay-config.json"),
    [int]$TunnelWaitSeconds = 60
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$stateRoot = Split-Path -Parent $ConfigPath
$logRoot = Join-Path $stateRoot "logs"
New-Item -ItemType Directory -Path $logRoot -Force | Out-Null

function Unprotect-CurrentUserText {
    param([Parameter(Mandatory = $true)][string]$ProtectedText)
    Add-Type -AssemblyName System.Security
    $protected = [Convert]::FromBase64String($ProtectedText.Trim())
    try {
        $plainBytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $protected,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        try { return [Text.Encoding]::UTF8.GetString($plainBytes) }
        finally { [Array]::Clear($plainBytes, 0, $plainBytes.Length) }
    } finally {
        [Array]::Clear($protected, 0, $protected.Length)
    }
}

function Get-QuickTunnelProcess {
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'cloudflared.exe' -and
        $_.CommandLine -match 'tunnel\s+--url\s+http://127\.0\.0\.1:8080'
    } | Select-Object -First 1
}

function Get-QuickTunnelUrl {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    $ports = Get-NetTCPConnection -OwningProcess $ProcessId -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalAddress -in @('127.0.0.1', '::1') } |
        Select-Object -ExpandProperty LocalPort -Unique
    foreach ($port in $ports) {
        try {
            $metrics = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/metrics" -TimeoutSec 2).Content
            $match = [regex]::Match($metrics, 'userHostname="(https://[a-z0-9-]+\.trycloudflare\.com)"')
            if ($match.Success) { return $match.Groups[1].Value }
        } catch { }
    }
    return $null
}

function Get-CloudflaredPath {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} 'cloudflared\cloudflared.exe'),
        (Join-Path $env:ProgramFiles 'cloudflared\cloudflared.exe'),
        (Get-Command cloudflared.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -First 1)
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    if ($candidates.Count -eq 0) { throw 'cloudflared.exe was not found' }
    return $candidates[0]
}

function Start-QuickTunnel {
    $cloudflared = Get-CloudflaredPath
    $stdoutPath = Join-Path $logRoot 'quick-tunnel.stdout.log'
    $stderrPath = Join-Path $logRoot 'quick-tunnel.stderr.log'
    foreach ($path in @($stdoutPath, $stderrPath)) {
        if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 2MB) {
            Move-Item -LiteralPath $path -Destination "$path.previous" -Force
        }
    }
    return Start-Process -FilePath $cloudflared `
        -ArgumentList @('tunnel', '--url', 'http://127.0.0.1:8080', '--no-autoupdate') `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -PassThru
}

function New-SignedHeaders {
    param(
        [Parameter(Mandatory = $true)][string]$Secret,
        [Parameter(Mandatory = $true)][string]$Body
    )
    $timestamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString([Globalization.CultureInfo]::InvariantCulture)
    $nonceBytes = New-Object byte[] 24
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($nonceBytes) } finally { $rng.Dispose() }
    $nonce = [Convert]::ToBase64String($nonceBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [Array]::Clear($nonceBytes, 0, $nonceBytes.Length)
    $message = "$timestamp`n$nonce`n$Body"
    $hmacKey = [Text.Encoding]::UTF8.GetBytes($Secret)
    $hmac = New-Object Security.Cryptography.HMACSHA256
    $hmac.Key = $hmacKey
    try {
        $signatureBytes = $hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($message))
        $signature = [BitConverter]::ToString($signatureBytes).Replace('-', '').ToLowerInvariant()
        [Array]::Clear($signatureBytes, 0, $signatureBytes.Length)
    } finally {
        $hmac.Dispose()
        [Array]::Clear($hmacKey, 0, $hmacKey.Length)
    }
    return @{
        'x-byeollog-timestamp' = $timestamp
        'x-byeollog-nonce' = $nonce
        'x-byeollog-signature' = $signature
    }
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Relay configuration is missing: $ConfigPath"
}
$config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
$relayUrl = ([string]$config.relayUrl).TrimEnd('/')
if ($relayUrl -notmatch '^https://[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev$') {
    throw 'Relay URL is invalid'
}
$secretPath = [string]$config.secretPath
if (-not (Test-Path -LiteralPath $secretPath -PathType Leaf)) {
    throw 'Protected relay secret is missing'
}

$process = Get-QuickTunnelProcess
if ($null -eq $process) { $process = Start-QuickTunnel }
$deadline = [DateTimeOffset]::UtcNow.AddSeconds($TunnelWaitSeconds)
$quickUrl = $null
while ([DateTimeOffset]::UtcNow -lt $deadline -and [string]::IsNullOrWhiteSpace($quickUrl)) {
    if ($null -eq (Get-Process -Id ([int]$process.ProcessId) -ErrorAction SilentlyContinue)) {
        throw "Quick Tunnel process stopped before publishing its URL"
    }
    Start-Sleep -Milliseconds 500
    $quickUrl = Get-QuickTunnelUrl -ProcessId ([int]$process.ProcessId)
}
if ([string]::IsNullOrWhiteSpace($quickUrl)) {
    throw "Quick Tunnel URL was not available within $TunnelWaitSeconds seconds"
}

$secret = Unprotect-CurrentUserText -ProtectedText (Get-Content -Raw -LiteralPath $secretPath)
try {
    if ($secret.Length -lt 32) { throw 'Relay secret is invalid' }
    $body = @{ origin = $quickUrl } | ConvertTo-Json -Compress
    $headers = New-SignedHeaders -Secret $secret -Body $body
    $receipt = Invoke-RestMethod `
        -Method Post `
        -Uri "$relayUrl/__byeollog/admin/origin" `
        -ContentType 'application/json' `
        -Headers $headers `
        -Body $body `
        -TimeoutSec 20
    if ($receipt.ok -ne $true) { throw 'Relay rejected the Quick Tunnel origin' }
} finally {
    $secret = $null
}

$relayHealth = $null
$relayDeadline = [DateTimeOffset]::UtcNow.AddSeconds(90)
while ([DateTimeOffset]::UtcNow -lt $relayDeadline -and $null -eq $relayHealth) {
    try {
        $candidate = Invoke-RestMethod -Uri "$relayUrl/healthz" -TimeoutSec 20
        if (
            $candidate.healthy -eq $true -and
            [string]$candidate.version -eq [string]$receipt.voiceVersion
        ) {
            $relayHealth = $candidate
        }
    } catch {
        $relayHealth = $null
    }
    if ($null -eq $relayHealth) { Start-Sleep -Seconds 2 }
}
if ($null -eq $relayHealth) { throw 'Relay health check failed after origin update' }

[pscustomobject]@{
    Healthy = $true
    RelayUrl = $relayUrl
    QuickTunnelUrl = $quickUrl
    QuickTunnelProcessId = [int]$process.ProcessId
    VoiceVersion = [string]$relayHealth.version
    UpdatedAtUtc = [string]$receipt.updatedAt
}
