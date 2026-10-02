#define AppVersion "1.0.0.46"
#define AppDisplayVersion "1.0.0.46"
#define PackageFile "byeollog_wallpaper_v10046_WIN_X64.zip"
#define PackageUrl "https://byeollog.com/agent-updates/releases/1.0.0.46/byeollog_wallpaper_v10046_WIN_X64.zip"
#define PackageSha256 "d1ba50e7a60f4f91ccf589f0d8513c784d35e1e46356e18c86eb1d82a7ea8f1c"
#define PackageExpandedBytes "73621231"

[Setup]
AppId={{6C58557A-D38B-42A4-9FB7-DF7DD7D22819}
AppName=별록 풍벽지
AppVersion={#AppVersion}
AppVerName=별록 풍벽지 {#AppDisplayVersion}
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
OutputBaseFilename=Byeollog-Wallpaper-Setup-v{#AppDisplayVersion}-online
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

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 별록 풍벽지 바로가기 만들기"; GroupDescription: "설치 후 실행 방법"; Flags: checkedonce

[Messages]
WelcomeLabel2=별록 풍벽지를 설치합니다.%n%n설치 후 바탕화면 또는 Windows 시작 메뉴에서 별록 풍벽지를 실행할 수 있습니다. 기존 설정과 기록은 유지됩니다.
FinishedLabelNoIcons=별록 풍벽지 설치를 마쳤습니다.%n%n아래 실행 항목을 선택하거나 바탕화면 바로가기를 이용하세요.

[Run]
Filename: "{code:GetInstalledExecutable}"; Description: "별록 풍벽지 실행"; Flags: postinstall skipifsilent nowait; Check: InstallSucceeded

[Code]
var
  InstallSucceededValue: Boolean;
  InstalledExecutable: String;

function GetInstalledExecutable(Param: String): String;
begin
  Result := InstalledExecutable;
end;

function InstallSucceeded: Boolean;
begin
  Result := InstallSucceededValue;
end;

function IsManagedExecutable(const FileName: String): Boolean;
var
  Prefix, Suffix, VersionText: String;
  Index, Parts, Digits: Integer;
begin
  Result := False;
  Prefix := ExpandConstant('{localappdata}\Programs\ByeollogCollector\versions\');
  Suffix := '\byeollog.exe';
  if CompareText(Copy(FileName, 1, Length(Prefix)), Prefix) <> 0 then Exit;
  if CompareText(Copy(FileName, Length(FileName)-Length(Suffix)+1, Length(Suffix)), Suffix) <> 0 then Exit;
  VersionText := Copy(FileName, Length(Prefix)+1, Length(FileName)-Length(Prefix)-Length(Suffix));
  Parts := 1;
  Digits := 0;
  for Index := 1 to Length(VersionText) do
  begin
    if VersionText[Index] = '.' then
    begin
      if Digits = 0 then Exit;
      Parts := Parts + 1;
      Digits := 0;
    end
    else if (VersionText[Index] >= '0') and (VersionText[Index] <= '9') then
      Digits := Digits + 1
    else Exit;
  end;
  Result := (Parts = 4) and (Digits > 0);
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
  ExecutableLines: TArrayOfString;
begin
  if CurStep <> ssPostInstall then
    Exit;

  InstallSucceededValue := False;
  PackageRoot := ExpandConstant('{tmp}\byeollog-agent-{#AppVersion}');
  InstallerScript := PackageRoot + '\Install-Byeollog.ps1';
  PowerShellPath := ExpandConstant('{sysnative}\WindowsPowerShell\v1.0\powershell.exe');

  if not FileExists(InstallerScript) then
    RaiseException('다운로드한 패키지에서 설치 스크립트를 찾을 수 없습니다.');

  WizardForm.StatusLabel.Caption := '패키지 무결성을 확인하고 별록 풍벽지를 설치하는 중입니다...';
  Parameters := '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' +
    ExpandConstant('{tmp}\Invoke-AgentInstall.ps1') + '" -PackageRoot "' + PackageRoot + '" -Mode ';
  if IsVerifyOnly then
    Parameters := Parameters + 'VerifyPackage'
  else
    Parameters := Parameters + 'Install';
  Parameters := Parameters + ' -ResultPath "' + ExpandConstant('{tmp}\byeollog-installed-executable.txt') + '"';
  if (not IsVerifyOnly) and WizardIsTaskSelected('desktopicon') then
    Parameters := Parameters + ' -DesktopShortcut';

  if not ExecAndLogOutput(
    PowerShellPath,
    Parameters,
    PackageRoot,
    SW_HIDE,
    ewWaitUntilTerminated,
    ResultCode,
    @OnInstallerOutput) then
    RaiseException('별록 풍벽지 설치 프로세스를 시작하지 못했습니다.');

  if ResultCode <> 0 then
    RaiseException('별록 풍벽지를 설치하지 못했습니다 (오류 코드 ' +
      IntToStr(ResultCode) + '). 설치 로그의 Agent installer 항목에서 원인을 확인해주세요. ' +
      '앱 설치 후 바로가기 생성 단계에서 실패했을 수도 있습니다.');

  if (not IsVerifyOnly) and
    (not FileExists(ExpandConstant('{localappdata}\Programs\ByeollogCollector\LAUNCH_BYEOLLOG.cmd'))) then
    RaiseException('설치는 완료되었지만 실행 파일을 확인하지 못했습니다.');

  InstallSucceededValue := not IsVerifyOnly;
  if InstallSucceededValue then
  begin
    if not LoadStringsFromFile(ExpandConstant('{tmp}\byeollog-installed-executable.txt'), ExecutableLines) then
      RaiseException('설치된 실행 파일을 확인하지 못했습니다.');
    if GetArrayLength(ExecutableLines) <> 1 then
      RaiseException('설치된 실행 파일 경로가 올바르지 않습니다.');
    InstalledExecutable := Trim(ExecutableLines[0]);
    if not IsManagedExecutable(InstalledExecutable) then
      RaiseException('설치된 실행 파일의 위치가 올바르지 않습니다.');
    if not FileExists(InstalledExecutable) then
      RaiseException('설치된 실행 파일을 찾을 수 없습니다.');
  end;
end;

function InitializeSetup: Boolean;
begin
  InstallSucceededValue := False;
  Result := True;
end;
