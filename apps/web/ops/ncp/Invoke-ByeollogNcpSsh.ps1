[CmdletBinding(PositionalBinding=$false)]
param(
  [string]$StdinScriptPath,
  [switch]$ForwardStandardInput,
  [Parameter(ValueFromRemainingArguments=$true)]
  [string[]]$RemoteCommand
)

$ErrorActionPreference='Stop'
$NcpServerHost='192.0.2.20'
$NcpDeployUser='byeollog-deploy'
$NcpExpectedFingerprint='SHA256:87pnpFujlrMucFEv/HRVOvfiVc8Ln6wXlvY3tU1OSHY'
$NcpKeyPath=Join-Path ([Environment]::GetFolderPath('Desktop')) 'byeollog-ncp.pem'
$NcpKnownHostsPath=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.ssh\known_hosts'

if(-not (Test-Path -LiteralPath $NcpKeyPath -PathType Leaf)){
  throw "NCP deployment key is missing: $NcpKeyPath"
}
$fingerprintLine=& ssh-keygen -lf $NcpKeyPath
if($LASTEXITCODE -ne 0 -or $fingerprintLine -notmatch [regex]::Escape($NcpExpectedFingerprint)){
  throw 'NCP deployment key fingerprint mismatch. Refusing SSH connection.'
}
if(-not (Test-Path -LiteralPath $NcpKnownHostsPath -PathType Leaf)){
  throw "NCP known_hosts file is missing: $NcpKnownHostsPath"
}

$sshArguments=@(
  '-i',$NcpKeyPath,
  '-o','BatchMode=yes',
  '-o','StrictHostKeyChecking=yes',
  '-o',"UserKnownHostsFile=$NcpKnownHostsPath",
  "$NcpDeployUser@$NcpServerHost"
)
if($StdinScriptPath){
  $resolvedScript=[IO.Path]::GetFullPath($StdinScriptPath)
  $allowedRoot=[IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
  if((-not $resolvedScript.StartsWith($allowedRoot,[StringComparison]::OrdinalIgnoreCase)) -or
     ([IO.Path]::GetExtension($resolvedScript) -ne '.sh') -or
     (-not (Test-Path -LiteralPath $resolvedScript -PathType Leaf))){
    throw 'Only repository-owned ops/ncp shell scripts may be streamed to NCP.'
  }
  $remoteScriptCommand="tr -d '\r' | sh -s --"
  if($RemoteCommand.Count -gt 0){$remoteScriptCommand+=' '+($RemoteCommand -join ' ')}
  (Get-Content -LiteralPath $resolvedScript -Raw).Replace("`r`n","`n") | & ssh @sshArguments $remoteScriptCommand
  exit $LASTEXITCODE
}
if($RemoteCommand.Count -gt 0){$sshArguments+=($RemoteCommand -join ' ')}
if($ForwardStandardInput){
  [Console]::In.ReadToEnd() | & ssh @sshArguments
  exit $LASTEXITCODE
}
& ssh @sshArguments
exit $LASTEXITCODE
