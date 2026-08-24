[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ReferenceAudioPath,

    [string]$Image = "byeollog-raffle-tts:cosyvoice3-v1",
    [string]$ActiveName = "byeollog-raffle-tts",
    [string]$RollbackName = "byeollog-raffle-tts-melo-backup-20260825"
)

$ErrorActionPreference = "Stop"

function Invoke-Docker {
    $arguments = @($args)
    & docker @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "docker command failed: $($arguments[0])"
    }
}

function Test-ContainerExists([string]$Name) {
    $value = & docker ps -a --filter "name=^$Name`$" --format "{{.Names}}"
    return $value -eq $Name
}

$reference = (Resolve-Path -LiteralPath $ReferenceAudioPath).Path
if (Test-ContainerExists $RollbackName) {
    throw "rollback container already exists: $RollbackName"
}

$activeInspect = (& docker inspect $ActiveName | ConvertFrom-Json)[0]
$secretLine = $activeInspect.Config.Env |
    Where-Object { $_ -like "BYEOLLOG_TTS_SHARED_SECRET=*" } |
    Select-Object -First 1
if ([string]::IsNullOrWhiteSpace($secretLine)) {
    throw "active gateway secret is missing"
}
$secret = $secretLine.Substring("BYEOLLOG_TTS_SHARED_SECRET=".Length)
$previousSharedSecret = $env:BYEOLLOG_TTS_SHARED_SECRET
$env:BYEOLLOG_TTS_SHARED_SECRET = $secret

# The disposable canary may remain stopped for later diagnostics. No container
# or image is deleted by this switch procedure.
if (Test-ContainerExists "byeollog-raffle-tts-cosy-canary") {
    & docker stop --time 20 byeollog-raffle-tts-cosy-canary | Out-Null
}

Invoke-Docker stop --time 20 $ActiveName | Out-Null
Invoke-Docker rename $ActiveName $RollbackName

try {
    Invoke-Docker run -d `
        --name $ActiveName `
        --restart unless-stopped `
        --gpus all `
        --shm-size 2g `
        -p 127.0.0.1:8080:8080 `
        --mount "type=bind,source=$reference,target=/run/byeollog-voice/reference.mp3,readonly" `
        --env BYEOLLOG_TTS_SHARED_SECRET `
        $Image | Out-Null

    $deadline = (Get-Date).AddMinutes(4)
    $health = $null
    do {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:8080/healthz" -TimeoutSec 3
            if ($health.healthy -and $health.version -eq "raffle-winner-cosyvoice3-v1") {
                break
            }
        }
        catch {
            $health = $null
        }
        $running = & docker inspect -f "{{.State.Running}}" $ActiveName 2>$null
        if ($running -ne "true") {
            break
        }
        Start-Sleep -Seconds 5
    } while ((Get-Date) -lt $deadline)

    if ($null -eq $health -or -not $health.healthy) {
        throw "CosyVoice health verification failed"
    }

    [pscustomobject]@{
        healthy = $true
        activeContainer = $ActiveName
        activeVersion = $health.version
        rollbackContainer = $RollbackName
        rollbackPreserved = $true
    } | ConvertTo-Json -Compress
}
catch {
    if (Test-ContainerExists $ActiveName) {
        & docker stop --time 20 $ActiveName | Out-Null
        Invoke-Docker rename $ActiveName "$ActiveName-cosy-failed-20260825"
    }
    Invoke-Docker rename $RollbackName $ActiveName
    Invoke-Docker start $ActiveName | Out-Null
    throw "CosyVoice activation failed; Melo was restored: $($_.Exception.Message)"
}
finally {
    if ($null -eq $previousSharedSecret) {
        Remove-Item Env:BYEOLLOG_TTS_SHARED_SECRET -ErrorAction SilentlyContinue
    }
    else {
        $env:BYEOLLOG_TTS_SHARED_SECRET = $previousSharedSecret
    }
    $secret = $null
}
