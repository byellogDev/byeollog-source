param(
  [switch]$IncludeLiveProcessKill,
  [int]$TimeoutSeconds=30
)
$ErrorActionPreference='Stop'
$taskName='Byeollog SOOP Gateway'
$statePath=Join-Path $env:LOCALAPPDATA 'Byeollog\soop-gateway\supervisor-state.json'
function Read-State {
  if(-not (Test-Path -LiteralPath $statePath)){return $null}
  return Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
}
function Process-Exists([int]$id){return $null -ne (Get-Process -Id $id -ErrorAction SilentlyContinue)}
$task=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
$state=Read-State
$health=$null
try{$health=Invoke-RestMethod -Uri 'http://127.0.0.1:47631/healthz' -TimeoutSec 3}catch{}
$report=[ordered]@{
  checkedAt=(Get-Date).ToUniversalTime().ToString('o')
  scheduledTaskExists=($null -ne $task)
  scheduledTaskState=if($task){[string]$task.State}else{$null}
  supervisorPid=if($state){[int]$state.supervisorPid}else{$null}
  supervisorAlive=if($state){Process-Exists ([int]$state.supervisorPid)}else{$false}
  childPid=if($state){[int]$state.childPid}else{$null}
  childAlive=if($state -and $state.childPid){Process-Exists ([int]$state.childPid)}else{$false}
  heartbeatAgeSeconds=if($state){[math]::Max(0,[math]::Round(([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse([string]$state.heartbeatAt)).TotalSeconds,1))}else{$null}
  healthEndpointOk=($null -ne $health -and $health.ok -eq $true)
  destructiveRecoveryTestRun=$false
  childRestartRecovered=$null
}
if($IncludeLiveProcessKill){
  if(-not $report.childAlive){throw '복구 시험을 시작할 실행 중인 게이트웨이 자식 프로세스가 없습니다.'}
  $oldPid=$report.childPid;$report.destructiveRecoveryTestRun=$true
  Stop-Process -Id $oldPid -Force
  $deadline=(Get-Date).AddSeconds($TimeoutSeconds)
  do{Start-Sleep -Milliseconds 250;$state=Read-State}while((Get-Date)-lt $deadline -and (-not $state.childPid -or [int]$state.childPid -eq $oldPid -or -not (Process-Exists ([int]$state.childPid))))
  $report.childRestartRecovered=($state.childPid -and [int]$state.childPid -ne $oldPid -and (Process-Exists ([int]$state.childPid)))
  $report.recoveredChildPid=if($state){[int]$state.childPid}else{$null}
}
$report | ConvertTo-Json -Depth 5
if(-not $report.scheduledTaskExists -or -not $report.supervisorAlive -or -not $report.childAlive -or $report.heartbeatAgeSeconds -gt 45 -or ($IncludeLiveProcessKill -and -not $report.childRestartRecovered)){exit 1}
