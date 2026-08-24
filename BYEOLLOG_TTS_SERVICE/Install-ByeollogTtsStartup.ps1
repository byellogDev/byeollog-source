[CmdletBinding()]
param(
    [string]$TaskName = "Byeollog TTS Local Service"
)

$ErrorActionPreference = "Stop"

$startupScript = Join-Path $PSScriptRoot "Start-ByeollogTtsLocal.ps1"
if (-not (Test-Path -LiteralPath $startupScript -PathType Leaf)) {
    throw "Startup script is missing: $startupScript"
}

$powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$quotedScript = '"' + $startupScript.Replace('"', '""') + '"'
$action = New-ScheduledTaskAction `
    -Execute $powerShellPath `
    -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File $quotedScript"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([Environment]::UserName)
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::FromMinutes(15)) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval ([TimeSpan]::FromMinutes(2))
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Restores Byeollog CosyVoice, Quick Tunnel, stable Worker relay, and records end-to-end health." `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    Script = $startupScript
    RunLevel = $task.Principal.RunLevel
} | Format-List
