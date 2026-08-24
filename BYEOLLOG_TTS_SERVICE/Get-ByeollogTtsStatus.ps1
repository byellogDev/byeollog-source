[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$statusPath = Join-Path $env:LOCALAPPDATA "ByeollogTts\startup-status.json"
$task = Get-ScheduledTask -TaskName "Byeollog TTS Local Service" -ErrorAction SilentlyContinue
$containerRunning = $false
$containerRestartPolicy = ""
$health = $null
$relayHealth = $null
$relayMeta = $null
$relayConfigPath = Join-Path $env:LOCALAPPDATA "ByeollogTts\relay-config.json"
$relayUrl = ""
$quickTunnelRunning = $false

try {
    $containerRunning = ((& docker inspect --format '{{.State.Running}}' byeollog-raffle-tts 2>$null | Select-Object -First 1) -eq "true")
    $containerRestartPolicy = [string]((& docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' byeollog-raffle-tts 2>$null | Select-Object -First 1))
} catch { }

try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/healthz" -TimeoutSec 5
} catch { }

$savedStatus = $null
if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
    try { $savedStatus = Get-Content -Raw -LiteralPath $statusPath | ConvertFrom-Json } catch { }
}

if (Test-Path -LiteralPath $relayConfigPath -PathType Leaf) {
    try {
        $relayConfig = Get-Content -Raw -LiteralPath $relayConfigPath | ConvertFrom-Json
        $relayUrl = ([string]$relayConfig.relayUrl).TrimEnd('/')
        $relayHealth = Invoke-RestMethod -Uri "$relayUrl/healthz" -TimeoutSec 10
        $relayMeta = Invoke-RestMethod -Uri "$relayUrl/__byeollog/relay/meta" -TimeoutSec 10
    } catch { }
}

try {
    $quickTunnelRunning = $null -ne (Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'cloudflared.exe' -and
        $_.CommandLine -match 'tunnel\s+--url\s+http://127\.0\.0\.1:8080'
    } | Select-Object -First 1)
} catch { }

$localHealthy = $false
$voiceVersion = ""
if ($null -ne $health) {
    $localHealthy = $health.healthy -eq $true
    $voiceVersion = [string]$health.version
}
$lastCheckedAt = ""
$lastStage = ""
$lastMessage = ""
if ($null -ne $savedStatus) {
    $lastCheckedAt = [string]$savedStatus.checkedAtUtc
    $lastStage = [string]$savedStatus.stage
    $lastMessage = [string]$savedStatus.message
}

[pscustomobject]@{
    ScheduledTaskInstalled = $null -ne $task
    ScheduledTaskState = if ($task) { [string]$task.State } else { "Missing" }
    ContainerRunning = $containerRunning
    ContainerRestartPolicy = $containerRestartPolicy
    LocalHealth = $localHealthy
    VoiceVersion = $voiceVersion
    LastStartupCheckUtc = $lastCheckedAt
    LastStartupStage = $lastStage
    LastStartupMessage = $lastMessage
    QuickTunnelRunning = $quickTunnelRunning
    StableRelayConfigured = -not [string]::IsNullOrWhiteSpace($relayUrl)
    StableRelayUrl = $relayUrl
    StableRelayHealth = $null -ne $relayHealth -and $relayHealth.healthy -eq $true
    StableRelayVersion = if ($relayMeta) { [string]$relayMeta.relayVersion } else { "" }
    StableRelayOriginUpdatedAt = if ($relayMeta) { [string]$relayMeta.updatedAt } else { "" }
} | Format-List
