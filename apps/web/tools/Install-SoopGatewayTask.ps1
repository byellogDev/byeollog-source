$ErrorActionPreference='Stop'
$taskName='Byeollog SOOP Gateway'
$watchdogTaskName='Byeollog SOOP Gateway Watchdog'
$repository=Split-Path -Parent $PSScriptRoot
$runner=Join-Path $PSScriptRoot 'Run-SoopGatewayHidden.ps1'
$hiddenLauncher=Join-Path $PSScriptRoot 'Run-PowerShellHidden.vbs'
$gateway=Join-Path $repository 'services\soop-chat-gateway\index.mjs'
$watchdog=Join-Path $PSScriptRoot 'Ensure-SoopGatewayRunning.ps1'
if(-not (Test-Path -LiteralPath $runner)){throw "Gateway runner is missing: $runner"}
if(-not (Test-Path -LiteralPath $hiddenLauncher)){throw "Hidden launcher is missing: $hiddenLauncher"}
if(-not (Test-Path -LiteralPath $gateway)){throw "Gateway service is missing: $gateway"}
if(-not (Test-Path -LiteralPath $watchdog)){throw "Gateway watchdog is missing: $watchdog"}
$gatewaySecret=[Environment]::GetEnvironmentVariable('SOOP_GATEWAY_INGRESS_SECRET','User')
if([string]::IsNullOrWhiteSpace($gatewaySecret)){throw 'SOOP gateway key is not configured for this Windows user.'}
$wscriptPath=Join-Path $env:SystemRoot 'System32\wscript.exe'
if(-not (Test-Path -LiteralPath $wscriptPath)){throw 'Windows Script Host was not found.'}
$quotedLauncher='"'+$hiddenLauncher.Replace('"','""')+'"'
$quotedRunner='"'+$runner.Replace('"','""')+'"'
$action=New-ScheduledTaskAction -Execute $wscriptPath -Argument "//B //Nologo $quotedLauncher $quotedRunner" -WorkingDirectory $repository
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -AtLogOn -User $identity
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$task=New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Keeps the SOOP SDK gateway available; per-stream collection follows the broadcast lifecycle.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
$quotedWatchdog='"'+$watchdog.Replace('"','""')+'"'
$watchdogAction=New-ScheduledTaskAction -Execute $wscriptPath -Argument "//B //Nologo $quotedLauncher $quotedWatchdog" -WorkingDirectory $repository
$watchdogTrigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$watchdogSettings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$watchdogTask=New-ScheduledTask -Action $watchdogAction -Principal $principal -Trigger $watchdogTrigger -Settings $watchdogSettings -Description 'Restarts the SOOP gateway task when its local health check remains unavailable.'
Register-ScheduledTask -TaskName $watchdogTaskName -InputObject $watchdogTask -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
$registered=Get-ScheduledTask -TaskName $taskName
$info=Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
  TaskName=$registered.TaskName
  State=$registered.State
  LastRunTime=$info.LastRunTime
  LastTaskResult=$info.LastTaskResult
  RestartCount=$registered.Settings.RestartCount
  StopIfGoingOnBatteries=$registered.Settings.StopIfGoingOnBatteries
  WatchdogTaskName=$watchdogTaskName
  WatchdogState=(Get-ScheduledTask -TaskName $watchdogTaskName).State
}
