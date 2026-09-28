[CmdletBinding()]
param(
 [Parameter(Mandatory=$true)][string]$CompilerPath,
 [Parameter(Mandatory=$true)][string]$OutputDirectory,
 [switch]$ExpectEncodingFailure
)
$ErrorActionPreference='Stop'
$root=Split-Path (Split-Path $PSScriptRoot)
$out=[IO.Path]::GetFullPath($OutputDirectory)
[IO.Directory]::CreateDirectory($out)|Out-Null
$source=[IO.File]::ReadAllText((Join-Path $root 'apps/web/installer/Invoke-AgentInstall.ps1'))
$write=[regex]::Match($source,'\[IO\.File\]::WriteAllText\(\$ResultPath,\$installedExe,[^\r\n]+\)(?= \})').Value
if(!$write){throw 'Receipt writer not found'}
$iss=[IO.File]::ReadAllText((Join-Path $root 'apps/web/installer/ByeollogAgentSetup.iss'))
$validator=[regex]::Match($iss,'(?s)function IsManagedExecutable\(.*?(?=function IsVerifyOnly)').Value
if(!$validator){throw 'Production path validator not found'}
$prefix=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs\ByeollogCollector\versions\'
$unicode=-join (@(54620,44544,32,44221,47196)|ForEach-Object{[char]$_})
$paths=@(($prefix+'1.0.0.43\byeollog.exe'), ($prefix+'1.0.0.44\byeollog.exe'), ('C:\'+$unicode+'\byeollog.exe'))
$code=''
for($i=0;$i -lt $paths.Count;$i++){
 $installedExe=$paths[$i];$ResultPath=Join-Path $out ('receipt'+$i+'.txt')
 Invoke-Expression $write
 $file=$ResultPath.Replace("'","''");$expected=$installedExe.Replace("'","''")
 $code+="  Valid := LoadStringsFromFile('$file', Lines);`n  if Valid then Valid := GetArrayLength(Lines) = 1;`n  if Valid then Valid := Lines[0] = '$expected';`n"
 if($i -lt 2){$code+="  if Valid then Valid := IsManagedExecutable(Lines[0]);`n"}
 $code+="  if Valid then Report := Report + 'receipt$i=pass' + #13#10 else Report := Report + 'receipt$i=fail' + #13#10;`n"
}
foreach($invalid in @(($prefix+'..\byeollog.exe'),($prefix+'1.0.0.43\..\byeollog.exe'),($prefix+'1.0.0.43x\byeollog.exe'),'C:\outside\1.0.0.43\byeollog.exe')){
 $code+="  if IsManagedExecutable('"+$invalid.Replace("'","''")+"') then Report := Report + 'boundary=fail' + #13#10 else Report := Report + 'boundary=pass' + #13#10;`n"
}
$reportPath=(Join-Path $out 'result.txt').Replace("'","''")
$script=@"
[Setup]
AppName=Byeollog receipt verification
AppVersion=1.0
CreateAppDir=no
Uninstallable=no
PrivilegesRequired=lowest
OutputDir=$out
OutputBaseFilename=receipt-probe
[Code]
$validator
function InitializeSetup: Boolean;
var Lines: TArrayOfString; Report: String; Valid: Boolean;
begin
  Report := '';
$code
  SaveStringToFile('$reportPath', Report, False);
  Result := False;
end;
"@
$scriptPath=Join-Path $out 'receipt-probe.iss'
[IO.File]::WriteAllText($scriptPath,$script,(New-Object Text.UTF8Encoding($true)))
& $CompilerPath /Qp $scriptPath | Out-Null
if($LASTEXITCODE){throw 'Probe compilation failed'}
$run=Start-Process -FilePath (Join-Path $out 'receipt-probe.exe') -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES' -WindowStyle Hidden -PassThru
if(!$run.WaitForExit(30000)){throw 'Probe timed out'}
$report=[IO.File]::ReadAllText((Join-Path $out 'result.txt'))
if($report -match 'boundary=fail'){throw 'Path boundary accepted an invalid path'}
if($ExpectEncodingFailure){if($report -notmatch 'receipt0=fail'){throw 'Expected old receipt encoding failure was not reproduced'}}
elseif($report -match '=fail'){throw ('Receipt round trip failed: '+$report)}
Write-Output $report
