[CmdletBinding()]
param(
    [string]$TaskName = "Byeollog TTS Local Service",
    [ValidateRange(1, 60)][int]$RepairIntervalMinutes = 5,
    [ValidateRange(30, 3650)][int]$RepairDurationDays = 3650
)

$ErrorActionPreference = "Stop"

$startupScript = Join-Path $PSScriptRoot "Start-ByeollogTtsLocal.ps1"
if (-not (Test-Path -LiteralPath $startupScript -PathType Leaf)) {
    throw "Startup script is missing: $startupScript"
}

$hiddenLauncher = Join-Path $PSScriptRoot "Start-ByeollogTtsLocalHidden.vbs"
if (-not (Test-Path -LiteralPath $hiddenLauncher -PathType Leaf)) {
    throw "Hidden startup launcher is missing: $hiddenLauncher"
}

$wscriptPath = Join-Path $env:SystemRoot "System32\wscript.exe"
if (-not (Test-Path -LiteralPath $wscriptPath -PathType Leaf)) {
    throw "Windows Script Host is missing: $wscriptPath"
}
$quotedLauncher = '"' + $hiddenLauncher.Replace('"', '""') + '"'
$action = New-ScheduledTaskAction `
    -Execute $wscriptPath `
    -Argument "//B //Nologo $quotedLauncher"
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User ([Environment]::UserName)
$repairTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval ([TimeSpan]::FromMinutes($RepairIntervalMinutes)) `
    -RepetitionDuration ([TimeSpan]::FromDays($RepairDurationDays))
$triggers = @($logonTrigger, $repairTrigger)
$settings = New-ScheduledTaskSettingsSet `
    -Hidden `
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
    -Trigger $triggers `
    -Settings $settings `
    -Principal $principal `
    -Description "Restores Byeollog CosyVoice, Quick Tunnel, and stable Worker relay at logon and on a periodic health-repair interval." `
    -Force | Out-Null

$task = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
    TaskName = $task.TaskName
    State = $task.State
    Script = $startupScript
    Launcher = $hiddenLauncher
    Hidden = [bool]$task.Settings.Hidden
    RunLevel = $task.Principal.RunLevel
    RepairIntervalMinutes = $RepairIntervalMinutes
    TriggerCount = @($task.Triggers).Count
} | Format-List
