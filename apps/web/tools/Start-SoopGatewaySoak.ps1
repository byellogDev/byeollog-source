param([int]$Hours=24,[string]$OutputDirectory='')
$ErrorActionPreference='Stop'
$repository=Split-Path -Parent $PSScriptRoot
$taskName='Byeollog SOOP Gateway Soak'
$existingTask=Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if($existingTask){
  $existingArguments=[string]$existingTask.Actions.Arguments
  $existingOutput=''
  if($existingArguments -match '-OutputDirectory\s+"([^"]+)"'){
    $existingOutput=[IO.Path]::GetFullPath($Matches[1])
  }elseif($existingArguments -match '--output\s+"?([^"\s]+)"?'){
    $existingOutput=[IO.Path]::GetFullPath($Matches[1])
  }
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
  if(-not [string]::IsNullOrWhiteSpace($existingOutput)){
    Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq 'node.exe' -and
      $_.CommandLine -and
      $_.CommandLine.Contains('tools/Run-SoopGatewaySoak.mjs') -and
      $_.CommandLine.Contains($existingOutput)
    } | ForEach-Object {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
  }
}
$runId=(Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')
$output=if([string]::IsNullOrWhiteSpace($OutputDirectory)){Join-Path $env:LOCALAPPDATA ('Byeollog\soak\'+$runId)}else{[IO.Path]::GetFullPath($OutputDirectory)}
New-Item -ItemType Directory -Path $output -Force | Out-Null
$script=Join-Path $repository 'tools\Run-SoopGatewaySoakHidden.ps1'
$powerShellPath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments='-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$script+'" -Hours '+$Hours+' -OutputDirectory "'+$output+'"'
$action=New-ScheduledTaskAction -Execute $powerShellPath -Argument $arguments -WorkingDirectory $repository
$identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal=New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1)
$settings=New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$task=New-ScheduledTask -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Description 'Records 24-hour SOOP gateway health samples without touching live SDK sessions.'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
[ordered]@{started=$true;taskName=$taskName;hours=$Hours;reportPath=(Join-Path $output 'report.json');samplesPath=(Join-Path $output 'samples.jsonl')} | ConvertTo-Json
