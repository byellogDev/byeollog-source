$ErrorActionPreference='Stop'
$taskName='Byeollog SOOP Gateway'
$logDirectory=Join-Path $env:LOCALAPPDATA 'Byeollog\logs'
$logPath=Join-Path $logDirectory 'soop-gateway-watchdog.jsonl'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$utf8=[Text.UTF8Encoding]::new($false)
function Write-Watchdog([string]$event,[hashtable]$data=@{}){
  $record=@{at=(Get-Date).ToUniversalTime().ToString('o');event=$event;watchdogPid=$PID}
  foreach($key in $data.Keys){$record[$key]=$data[$key]}
  [IO.File]::AppendAllText($logPath,($record|ConvertTo-Json -Compress)+[Environment]::NewLine,$utf8)
}
function Health-Ok {
  try{$value=Invoke-RestMethod -Uri 'http://127.0.0.1:47631/healthz' -TimeoutSec 3;return $value.ok -eq $true}catch{return $false}
}
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if(-not $task){Write-Watchdog 'gateway_task_missing';exit 2}
if(Health-Ok){exit 0}
if($task.State -ne 'Running'){
  Start-ScheduledTask -TaskName $taskName;Write-Watchdog 'gateway_task_started' @{previousState=[string]$task.State};exit 0
}
Start-Sleep -Seconds 10
if(Health-Ok){Write-Watchdog 'gateway_health_transient_failure';exit 0}
Write-Watchdog 'gateway_health_restart_requested'
$statePath=Join-Path $env:LOCALAPPDATA 'Byeollog\soop-gateway\supervisor-state.json'
if(Test-Path -LiteralPath $statePath){
  try{
    $state=Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach($candidate in @([int]$state.childPid,[int]$state.supervisorPid)){
      if($candidate -le 0){continue}
      $process=Get-CimInstance Win32_Process -Filter "ProcessId=$candidate" -ErrorAction SilentlyContinue
      if($process -and $process.Name -eq 'node.exe' -and $process.CommandLine -match 'services[\\/]soop-chat-gateway[\\/](index|supervisor)\.mjs'){
        Stop-Process -Id $candidate -Force -ErrorAction SilentlyContinue
      }
    }
  }catch{Write-Watchdog 'gateway_stale_process_cleanup_failed'}
}
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
Start-ScheduledTask -TaskName $taskName
