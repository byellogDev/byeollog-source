[CmdletBinding()]
param(
    [string]$ContainerName = "byeollog-raffle-tts",
    [int]$DockerWaitSeconds = 240,
    [int]$HealthWaitSeconds = 180,
    [string]$RelayConfigPath = (Join-Path $env:LOCALAPPDATA "ByeollogTts\relay-config.json")
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$stateRoot = Join-Path $env:LOCALAPPDATA "ByeollogTts"
$logRoot = Join-Path $stateRoot "logs"
$statusPath = Join-Path $stateRoot "startup-status.json"
$logPath = Join-Path $logRoot "startup.log"
$mutex = [Threading.Mutex]::new($false, "Local\ByeollogTtsStartup-$([Environment]::UserName)")
$ownsMutex = $false

function Write-StartupLog {
    param([string]$Message)
    $line = "{0} {1}" -f ([DateTimeOffset]::Now.ToString("o")), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Write-StartupStatus {
    param(
        [bool]$Healthy,
        [string]$Stage,
        [string]$Message,
        [string]$VoiceVersion = "",
        [bool]$RelayHealthy = $false,
        [string]$RelayUrl = "",
        [string]$QuickTunnelUrl = ""
    )
    $payload = [ordered]@{
        schemaVersion = 1
        checkedAtUtc = [DateTimeOffset]::UtcNow.ToString("o")
        healthy = $Healthy
        stage = $Stage
        message = $Message
        containerName = $ContainerName
        voiceVersion = $VoiceVersion
        relayHealthy = $RelayHealthy
        relayUrl = $RelayUrl
        quickTunnelUrl = $QuickTunnelUrl
    }
    $tempPath = "$statusPath.$([Guid]::NewGuid().ToString('N')).tmp"
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $tempPath -Encoding UTF8
    Move-Item -LiteralPath $tempPath -Destination $statusPath -Force
}

function Test-DockerReady {
    & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
}

function Start-DockerDesktopIfNeeded {
    if (Test-DockerReady) { return }

    $candidates = @(
        (Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "Docker\Docker\Docker Desktop.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\Docker\Docker\Docker Desktop.exe")
    ) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

    if ($candidates.Count -eq 0) {
        throw "Docker Desktop executable was not found"
    }

    Write-StartupLog "Starting Docker Desktop."
    Start-Process -FilePath $candidates[0] -WindowStyle Hidden | Out-Null
}

try {
    New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 2MB) {
        Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
    }

    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) { exit 0 }

    Write-StartupStatus -Healthy $false -Stage "starting" -Message "Local TTS startup is in progress."
    Start-DockerDesktopIfNeeded

    $dockerDeadline = [DateTimeOffset]::UtcNow.AddSeconds($DockerWaitSeconds)
    while (-not (Test-DockerReady)) {
        if ([DateTimeOffset]::UtcNow -ge $dockerDeadline) {
            throw "Docker engine did not become ready within $DockerWaitSeconds seconds"
        }
        Start-Sleep -Seconds 3
    }
    Write-StartupLog "Docker engine is ready."

    $containerId = (& docker container ls -a --filter "name=^/$ContainerName$" --format '{{.ID}}' 2>$null | Select-Object -First 1)
    if ([string]::IsNullOrWhiteSpace($containerId)) {
        throw "TTS container '$ContainerName' is not installed"
    }

    $running = (& docker inspect --format '{{.State.Running}}' $ContainerName 2>$null | Select-Object -First 1)
    if ($running -notin @("true", "false")) { throw "TTS container state could not be read" }
    if ($running -ne "true") {
        Write-StartupLog "Starting TTS container."
        & docker start $ContainerName | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "TTS container failed to start" }
    }

    $healthDeadline = [DateTimeOffset]::UtcNow.AddSeconds($HealthWaitSeconds)
    $health = $null
    while ($null -eq $health) {
        try {
            $candidate = Invoke-RestMethod -Uri "http://127.0.0.1:8080/healthz" -TimeoutSec 5
            if ($candidate.healthy -eq $true) { $health = $candidate }
        } catch {
            $health = $null
        }
        if ($null -eq $health) {
            if ([DateTimeOffset]::UtcNow -ge $healthDeadline) {
                throw "TTS health check did not pass within $HealthWaitSeconds seconds"
            }
            Start-Sleep -Seconds 3
        }
    }

    $voiceVersion = [string]$health.version
    $relayHealthy = $false
    $relayUrl = ""
    $quickTunnelUrl = ""
    $message = "Local CosyVoice service is ready."
    $stage = "ready_local"
    if (Test-Path -LiteralPath $RelayConfigPath -PathType Leaf) {
        $relayScript = Join-Path $PSScriptRoot "Start-ByeollogTtsRelay.ps1"
        if (-not (Test-Path -LiteralPath $relayScript -PathType Leaf)) {
            throw "Relay startup script is missing: $relayScript"
        }
        Write-StartupLog "Starting or refreshing the stable TTS relay."
        $relay = & $relayScript -ConfigPath $RelayConfigPath
        if ($null -eq $relay -or $relay.Healthy -ne $true) {
            throw "Stable TTS relay did not become healthy"
        }
        $relayHealthy = $true
        $relayUrl = [string]$relay.RelayUrl
        $quickTunnelUrl = [string]$relay.QuickTunnelUrl
        $message = "Local CosyVoice service and stable relay are ready."
        $stage = "ready"
        Write-StartupLog "Stable TTS relay is healthy."
    }

    Write-StartupStatus -Healthy $true -Stage $stage -Message $message -VoiceVersion $voiceVersion `
        -RelayHealthy $relayHealthy -RelayUrl $relayUrl -QuickTunnelUrl $quickTunnelUrl
    Write-StartupLog "Local TTS service is healthy ($voiceVersion)."
    exit 0
} catch {
    try {
        Write-StartupStatus -Healthy $false -Stage "failed" -Message $_.Exception.Message
        Write-StartupLog "FAILED: $($_.Exception.Message)"
    } catch { }
    exit 1
} finally {
    if ($ownsMutex) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
