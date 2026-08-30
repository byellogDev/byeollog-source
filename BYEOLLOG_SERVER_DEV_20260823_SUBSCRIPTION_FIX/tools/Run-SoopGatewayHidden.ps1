$ErrorActionPreference='Stop'
$mutex=[Threading.Mutex]::new($false,'Local\ByeollogSoopGateway')
$ownsMutex=$false
try{$ownsMutex=$mutex.WaitOne(0)}catch [Threading.AbandonedMutexException]{$ownsMutex=$true}
if(-not $ownsMutex){$mutex.Dispose();exit 0}
$repository=Split-Path -Parent $PSScriptRoot
$gatewaySecret=[Environment]::GetEnvironmentVariable('SOOP_GATEWAY_INGRESS_SECRET','User')
if([string]::IsNullOrWhiteSpace($gatewaySecret)){throw 'SOOP gateway key is not configured for this Windows user.'}
$env:SOOP_GATEWAY_INGRESS_SECRET=$gatewaySecret
$env:BYEOLLOG_SOOP_GATEWAY_URL='https://byeollog.com/api/auth/soop/gateway'
$logDirectory=Join-Path $env:LOCALAPPDATA 'Byeollog\logs'
$stateDirectory=Join-Path $env:LOCALAPPDATA 'Byeollog\soop-gateway'
$env:SOOP_GATEWAY_STATE_DIR=$stateDirectory
$env:SOOP_GATEWAY_HEALTH_HOST='127.0.0.1'
$env:SOOP_GATEWAY_HEALTH_PORT='47631'
$logPath=Join-Path $logDirectory 'soop-gateway.jsonl'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
Set-Location -LiteralPath $repository
$utf8NoBom=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=$utf8NoBom
$OutputEncoding=$utf8NoBom
function Add-GatewayLogLine([string]$line) {
  [IO.File]::AppendAllText($logPath,$line+[Environment]::NewLine,$utf8NoBom)
}
function Rotate-GatewayLog {
  if((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 8MB){
    $previousPath=Join-Path $logDirectory 'soop-gateway.previous.jsonl'
    Move-Item -LiteralPath $logPath -Destination $previousPath -Force
  }
}
function Write-SupervisorEvent([string]$eventName,[hashtable]$data=@{}) {
  $record=@{at=(Get-Date).ToUniversalTime().ToString('o');level='warn';event=$eventName;supervisor=$PID}
  foreach($key in $data.Keys){$record[$key]=$data[$key]}
  Add-GatewayLogLine ($record | ConvertTo-Json -Compress)
}
$nodePath=(Get-Command node -ErrorAction Stop).Source
try{
  Rotate-GatewayLog
  & $nodePath 'services/soop-chat-gateway/supervisor.mjs' 2>&1 | ForEach-Object {Add-GatewayLogLine ([string]$_)}
  $exitCode=$LASTEXITCODE
  Write-SupervisorEvent 'gateway_supervisor_process_exited' @{exitCode=$exitCode}
  if($exitCode -eq 0){exit 1}else{exit $exitCode}
}
finally{if($ownsMutex){try{$mutex.ReleaseMutex()}catch{}};$mutex.Dispose()}
