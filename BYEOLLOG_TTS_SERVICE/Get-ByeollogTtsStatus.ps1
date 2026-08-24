[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$statusPath = Join-Path $env:LOCALAPPDATA "ByeollogTts\startup-status.json"
$task = Get-ScheduledTask -TaskName "Byeollog TTS Local Service" -ErrorAction SilentlyContinue
$containerRunning = $false
$containerRestartPolicy = ""
$health = $null

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
    StableTunnelConfigured = $false
} | Format-List
