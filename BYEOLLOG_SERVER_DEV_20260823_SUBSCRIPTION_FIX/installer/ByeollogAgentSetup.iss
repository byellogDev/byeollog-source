#define AppVersion "0.7.0.141"
#define PackageFile "byeollog_agent_v07141_WALLPAPER_LAYER_ORDER_WIN_X64.zip"
#define PackageUrl "https://byeollog.com/agent-updates/releases/0.7.0.141/byeollog_agent_v07141_WALLPAPER_LAYER_ORDER_WIN_X64.zip"
#define PackageSha256 "3b6fdd1c92cafcc8111a1b81f47bd5eccb388f2d2b16d01223709c616d60a581"
#define PackageExpandedBytes "107895902"

[Setup]
AppId={{6C58557A-D38B-42A4-9FB7-DF7DD7D22819}
AppName=별록 에이전트
AppVersion={#AppVersion}
AppVerName=별록 에이전트 {#AppVersion}
AppPublisher=별록
AppPublisherURL=https://byeollog.com
AppSupportURL=https://byeollog.com
AppUpdatesURL=https://byeollog.com
CreateAppDir=no
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=no
DisableWelcomePage=no
OutputDir=..\agent-updates\releases\{#AppVersion}
OutputBaseFilename=Byeollog-Agent-Setup-v{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupLogging=yes
Uninstallable=no
CloseApplications=no
RestartApplications=no
ArchiveExtraction=full

[Languages]
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"

[Files]
Source: "Invoke-AgentInstall.ps1"; DestDir: "{tmp}"; Flags: ignoreversion
Source: "{#PackageUrl}"; DestDir: "{tmp}\byeollog-agent-{#AppVersion}"; DestName: "{#PackageFile}"; ExternalSize: {#PackageExpandedBytes}; Hash: "{#PackageSha256}"; Flags: external download extractarchive ignoreversion recursesubdirs createallsubdirs

[Run]
Filename: "{localappdata}\Programs\ByeollogCollector\LAUNCH_BYEOLLOG.cmd"; Description: "별록 에이전트 실행"; Flags: postinstall skipifsilent nowait shellexec; Check: InstallSucceeded

[Code]
var
  InstallSucceededValue: Boolean;

function InstallSucceeded: Boolean;
begin
  Result := InstallSucceededValue;
end;

function IsVerifyOnly: Boolean;
var
  Index: Integer;
begin
  Result := False;
  for Index := 1 to ParamCount do
    if CompareText(ParamStr(Index), '/VERIFYONLY') = 0 then
    begin
      Result := True;
      Exit;
    end;
end;

procedure OnInstallerOutput(const S: String; const Error, FirstLine: Boolean);
begin
  if Error then
    Log('Agent installer error output: ' + S)
  else
    Log('Agent installer output: ' + S);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PowerShellPath: String;
  PackageRoot: String;
  InstallerScript: String;
  Parameters: String;
  ResultCode: Integer;
begin
  if CurStep <> ssPostInstall then
    Exit;

  InstallSucceededValue := False;
  PackageRoot := ExpandConstant('{tmp}\byeollog-agent-{#AppVersion}');
  InstallerScript := PackageRoot + '\Install-Byeollog.ps1';
  PowerShellPath := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');

  if not FileExists(InstallerScript) then
    RaiseException('다운로드한 패키지에서 설치 스크립트를 찾을 수 없습니다.');

  WizardForm.StatusLabel.Caption := '패키지 무결성을 확인하고 별록 에이전트를 설치하는 중입니다...';
  Parameters := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Invoke-AgentInstall.ps1') + '" -PackageRoot "' + PackageRoot + '" -Mode ';
  if IsVerifyOnly then
    Parameters := Parameters + 'VerifyPackage'
  else
    Parameters := Parameters + 'Install';

  if not ExecAndLogOutput(
    PowerShellPath,
    Parameters,
    PackageRoot,
    SW_SHOWNORMAL,
    ewWaitUntilTerminated,
    ResultCode,
    @OnInstallerOutput) then
    RaiseException('별록 에이전트 설치 프로세스를 시작하지 못했습니다.');

  if ResultCode <> 0 then
    RaiseException('별록 에이전트를 설치하지 못했습니다 (오류 코드 ' +
      IntToStr(ResultCode) + '). 실행 중인 별록 에이전트를 종료한 뒤 다시 시도해주세요.');

  if (not IsVerifyOnly) and
    (not FileExists(ExpandConstant('{localappdata}\Programs\ByeollogCollector\LAUNCH_BYEOLLOG.cmd'))) then
    RaiseException('설치는 완료되었지만 실행 파일을 확인하지 못했습니다.');

  InstallSucceededValue := not IsVerifyOnly;
end;

function InitializeSetup: Boolean;
begin
  InstallSucceededValue := False;
  Result := True;
end;
