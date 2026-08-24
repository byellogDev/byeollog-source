Unicode true
ManifestDPIAware true
RequestExecutionLevel user

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "TextFunc.nsh"
!include "Sections.nsh"
!include "x64.nsh"

!ifndef PRODUCT_NAME
  !define PRODUCT_NAME "별록 에이전트"
!endif
!ifndef PUBLISHER
  !define PUBLISHER "별록"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.7.0.32"
!endif
!ifndef EMBEDDED_VERSION
  !define EMBEDDED_VERSION "0.7.0.32"
!endif
!ifndef WEBSITE
  !define WEBSITE "https://byeollog.com"
!endif
!ifndef ESTIMATED_SIZE_KB
  !define ESTIMATED_SIZE_KB 78000
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE must be supplied by Build-Setup.ps1."
!endif
!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR must be supplied by Build-Setup.ps1."
!endif
!ifndef INSTALL_DRIVER
  !error "INSTALL_DRIVER must be supplied by Build-Setup.ps1."
!endif
!ifndef UNINSTALL_DRIVER
  !error "UNINSTALL_DRIVER must be supplied by Build-Setup.ps1."
!endif
!ifndef APP_ICON
  !error "APP_ICON must be supplied by Build-Setup.ps1."
!endif
!ifdef EXPORT_UNINSTALLER
  !ifndef EXPORTED_UNINSTALLER_PATH
    !error "EXPORTED_UNINSTALLER_PATH is required for the export pass."
  !endif
!endif
!ifdef IMPORT_UNINSTALLER
  !ifndef SIGNED_UNINSTALLER_PATH
    !error "SIGNED_UNINSTALLER_PATH is required for the import pass."
  !endif
!endif

Name "${PRODUCT_NAME}"
Caption "${PRODUCT_NAME} ${PRODUCT_VERSION} 설치"
OutFile "${OUTPUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\ByeollogCollector"
BrandingText "${PUBLISHER}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
SetCompressor /SOLID lzma
SetCompressorDictSize 64

VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1042 "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey /LANG=1042 "FileDescription" "${PRODUCT_NAME} 정식 설치 프로그램"
VIAddVersionKey /LANG=1042 "CompanyName" "${PUBLISHER}"
VIAddVersionKey /LANG=1042 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1042 "ProductVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1042 "LegalCopyright" "Copyright (c) ${PUBLISHER}"

!define MUI_ABORTWARNING
!define MUI_ICON "${APP_ICON}"
!define MUI_UNICON "${APP_ICON}"
!define MUI_WELCOMEPAGE_TITLE "${PRODUCT_NAME} 설치"
!define MUI_WELCOMEPAGE_TEXT "별록 에이전트를 이 Windows 사용자 계정에 안전하게 설치합니다.$\r$\n$\r$\n관리자 권한은 필요하지 않으며, 기존 설정과 수집 데이터는 그대로 유지됩니다."
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_FINISHPAGE_TITLE "설치가 완료되었습니다"
!define MUI_FINISHPAGE_TEXT "시작 메뉴의 '별록 에이전트'에서 프로그램을 실행할 수 있습니다. 다음 공개판부터는 검증된 자동 업데이트가 다음 실행 시 적용됩니다."
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "별록 에이전트 실행"
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchByeollog

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!ifndef IMPORT_UNINSTALLER
  !insertmacro MUI_UNPAGE_CONFIRM
  !insertmacro MUI_UNPAGE_INSTFILES
  !insertmacro MUI_UNPAGE_FINISH
!endif

!insertmacro MUI_LANGUAGE "Korean"

Var InstallExitCode
Var InstallOutput
Var InstalledVersion
Var PowerShellPath

Function .onInit
  SetShellVarContext current
  ${IfNot} ${RunningX64}
    SetErrorLevel 1633
    IfSilent silent_unsupported_x64 unsupported_x64
unsupported_x64:
    MessageBox MB_OK|MB_ICONSTOP "별록 에이전트는 64비트 Windows에서만 설치할 수 있습니다."
silent_unsupported_x64:
    Quit
  ${EndIf}
  # The official NSIS compiler produces a 32-bit bootstrapper. On x64 Windows,
  # use Sysnative so the verified install engine runs in 64-bit Windows
  # PowerShell (the 32-bit legacy host can lack required security cmdlets).
  StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  IfFileExists "$PowerShellPath" +2 0
    StrCpy $PowerShellPath "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
FunctionEnd

!ifndef IMPORT_UNINSTALLER
  Function un.onInit
    SetShellVarContext current
    StrCpy $PowerShellPath "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
    IfFileExists "$PowerShellPath" +2 0
      StrCpy $PowerShellPath "$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  FunctionEnd
!endif

Function AppendInstallLog
  Exch $0
  Push $1
  FileOpen $1 "$TEMP\ByeollogAgent-Setup.log" a
  FileSeek $1 0 END
  FileWrite $1 "$0$\r$\n"
  FileClose $1
  Pop $1
  Exch $0
FunctionEnd

!ifndef IMPORT_UNINSTALLER
  Function un.AppendInstallLog
    Exch $0
    Push $1
    FileOpen $1 "$TEMP\ByeollogAgent-Setup.log" a
    FileSeek $1 0 END
    FileWrite $1 "$0$\r$\n"
    FileClose $1
    Pop $1
    Exch $0
  FunctionEnd
!endif

Function LaunchByeollog
  # 설치 직후 첫 실행도 WinExe를 직접 열어 콘솔 호스트가 한 프레임도 나타나지 않게 합니다.
  Exec '"$INSTDIR\versions\$InstalledVersion\byeollog.exe"'
FunctionEnd

Section "별록 에이전트 (필수)" SEC_CORE
  SectionIn RO
  Push "setup_begin version=${PRODUCT_VERSION} root=$INSTDIR"
  Call AppendInstallLog

  SetOutPath "$PLUGINSDIR"
  File /oname=Invoke-OfficialInstall.ps1 "${INSTALL_DRIVER}"
  SetOutPath "$PLUGINSDIR\payload"
  File /r "${PAYLOAD_DIR}\*"

  nsExec::ExecToStack /TIMEOUT=600000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$PLUGINSDIR\Invoke-OfficialInstall.ps1" -PayloadRoot "$PLUGINSDIR\payload" -EmbeddedVersion "${EMBEDDED_VERSION}" -ResultPath "$PLUGINSDIR\installed-version.txt" -LogPath "$TEMP\ByeollogAgent-Setup.log"'
  Pop $InstallExitCode
  Pop $InstallOutput

  StrCmp $InstallExitCode "0" install_engine_ok
  StrCmp $InstallExitCode "10" install_engine_ok
  StrCmp $InstallExitCode "20" install_running
  StrCmp $InstallExitCode "21" install_locked

  Push "setup_failed engine_exit=$InstallExitCode"
  Call AppendInstallLog
  SetErrorLevel 1603
  IfSilent install_quit install_failed_message
install_failed_message:
  MessageBox MB_OK|MB_ICONSTOP "설치를 완료하지 못했습니다.$\r$\n$\r$\n자세한 내용: $TEMP\ByeollogAgent-Setup.log"
  Goto install_quit

install_running:
  Push "setup_blocked agent_running"
  Call AppendInstallLog
  SetErrorLevel 1618
  IfSilent install_quit install_running_message
install_running_message:
  MessageBox MB_OK|MB_ICONEXCLAMATION "별록 에이전트가 실행 중입니다.$\r$\n트레이에서 별록을 완전히 종료한 뒤 설치를 다시 실행해주세요.$\r$\n$\r$\n설치 프로그램은 실행 중인 앱을 강제로 종료하지 않습니다."
  Goto install_quit

install_locked:
  Push "setup_blocked install_locked"
  Call AppendInstallLog
  SetErrorLevel 1618
  IfSilent install_quit install_locked_message
install_locked_message:
  MessageBox MB_OK|MB_ICONEXCLAMATION "다른 별록 설치 또는 업데이트가 진행 중입니다.$\r$\n잠시 후 다시 실행해주세요."
  Goto install_quit

install_quit:
  Quit

install_engine_ok:
  FileOpen $0 "$PLUGINSDIR\installed-version.txt" r
  IfErrors invalid_install_result
  FileRead $0 $InstalledVersion
  FileClose $0
  ${TrimNewLines} $InstalledVersion $InstalledVersion
  StrCmp $InstalledVersion "" invalid_install_result
  Goto create_install_metadata

invalid_install_result:
  Push "setup_failed missing_installed_version"
  Call AppendInstallLog
  SetErrorLevel 1603
  IfSilent install_quit invalid_result_message
invalid_result_message:
  MessageBox MB_OK|MB_ICONSTOP "설치 결과를 확인하지 못했습니다.$\r$\n자세한 내용: $TEMP\ByeollogAgent-Setup.log"
  Goto install_quit

create_install_metadata:
  # 일반 실행은 WinExe를 직접 열어 PowerShell/CMD 창이 생길 여지를 없앱니다.
  # 앱이 current.json과 manifest 해시를 다시 검증하고 업데이트된 현재 버전으로 넘깁니다.
  SetOutPath "$INSTDIR\versions\$InstalledVersion"
  IfFileExists "$SMPROGRAMS\별록.lnk" start_menu_preferred_exists start_menu_create_preferred
start_menu_preferred_exists:
  IfFileExists "$SMPROGRAMS\별록 최신.lnk" start_menu_shortcut_ready start_menu_create_alternate
start_menu_create_preferred:
  CreateShortCut "$SMPROGRAMS\별록.lnk" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" "" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" 0 SW_SHOWNORMAL
  Goto start_menu_shortcut_ready
start_menu_create_alternate:
  CreateShortCut "$SMPROGRAMS\별록 최신.lnk" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" "" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" 0 SW_SHOWNORMAL
start_menu_shortcut_ready:

  # Exit 10 means an already-installed newer Agent was verified. Keep its
  # uninstaller instead of replacing management code with this older Setup.
  StrCmp $InstallExitCode "10" preserve_newer_uninstaller
    SetOutPath "$INSTDIR"
    File /oname=Invoke-OfficialUninstall.ps1 "${UNINSTALL_DRIVER}"
    !ifdef IMPORT_UNINSTALLER
      SetOutPath "$INSTDIR"
      File /oname=Uninstall.exe "${SIGNED_UNINSTALLER_PATH}"
    !else
      WriteUninstaller "$INSTDIR\Uninstall.exe"
    !endif
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
    Goto uninstaller_metadata_ready
preserve_newer_uninstaller:
  Push "setup_repair preserved_newer_uninstaller"
  Call AppendInstallLog
uninstaller_metadata_ready:
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "DisplayVersion" "$InstalledVersion"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "URLInfoAbout" "${WEBSITE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "DisplayIcon" "$INSTDIR\versions\$InstalledVersion\byeollog.exe,0"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "NoRepair" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent" "EstimatedSize" ${ESTIMATED_SIZE_KB}

  Push "setup_ok installed_version=$InstalledVersion engine_exit=$InstallExitCode"
  Call AppendInstallLog
  SetErrorLevel 0
SectionEnd

Section /o "바탕 화면 바로가기" SEC_DESKTOP
  SetOutPath "$INSTDIR\versions\$InstalledVersion"
  IfFileExists "$DESKTOP\별록.lnk" desktop_preferred_exists desktop_create_preferred
desktop_preferred_exists:
  IfFileExists "$DESKTOP\별록 최신.lnk" desktop_shortcut_ready desktop_create_alternate
desktop_create_preferred:
  CreateShortCut "$DESKTOP\별록.lnk" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" "" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" 0 SW_SHOWNORMAL
  Goto desktop_shortcut_ready
desktop_create_alternate:
  CreateShortCut "$DESKTOP\별록 최신.lnk" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" "" "$INSTDIR\versions\$InstalledVersion\byeollog.exe" 0 SW_SHOWNORMAL
desktop_shortcut_ready:
SectionEnd

LangString DESC_SEC_CORE ${LANG_KOREAN} "검증된 별록 에이전트와 콘솔 창 없는 자동 업데이트 실행 경로를 현재 사용자 계정에 설치합니다."
LangString DESC_SEC_DESKTOP ${LANG_KOREAN} "바탕 화면에 별록 에이전트 바로가기를 만듭니다. 기본값은 선택 안 함입니다."
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} $(DESC_SEC_CORE)
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} $(DESC_SEC_DESKTOP)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

!ifndef IMPORT_UNINSTALLER
Section "Uninstall"
  Push "uninstall_begin root=$INSTDIR"
  Call un.AppendInstallLog

  Delete "$TEMP\ByeollogAgent-Uninstall.result"
  nsExec::ExecToStack /TIMEOUT=120000 '"$PowerShellPath" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$INSTDIR\Invoke-OfficialUninstall.ps1" -InstallRoot "$INSTDIR" -ResultPath "$TEMP\ByeollogAgent-Uninstall.result" -LogPath "$TEMP\ByeollogAgent-Setup.log"'
  Pop $0
  Pop $1
  StrCmp $0 "0" uninstall_safe

  Push "uninstall_blocked check_exit=$0"
  Call un.AppendInstallLog
  StrCmp $0 "20" 0 uninstall_failed
    SetErrorLevel 1618
    IfSilent uninstall_quit uninstall_blocked_message
uninstall_blocked_message:
  MessageBox MB_OK|MB_ICONEXCLAMATION "별록 에이전트가 실행 중이거나 업데이트가 진행 중입니다.$\r$\n트레이에서 별록을 완전히 종료한 뒤 제거를 다시 실행해주세요.$\r$\n$\r$\n제거 프로그램은 앱을 강제로 종료하지 않습니다."
  Goto uninstall_quit
uninstall_failed:
  SetErrorLevel 1603
  IfSilent uninstall_quit uninstall_failed_message
uninstall_failed_message:
  MessageBox MB_OK|MB_ICONSTOP "별록 에이전트 제거를 안전하게 완료하지 못했습니다.$\r$\n$\r$\n자세한 내용: $TEMP\ByeollogAgent-Setup.log"
uninstall_quit:
  Quit

uninstall_safe:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\ByeollogAgent"

  Push "uninstall_ok user_data_preserved"
  Call un.AppendInstallLog
  SetErrorLevel 0
SectionEnd
!endif

!ifdef EXPORT_UNINSTALLER
  # NSIS replaces %1 with the compiler-generated uninstaller.  The first pass
  # only exports it; Build-Setup signs and imports the exact bytes in pass two.
  !uninstfinalize 'cmd.exe /d /c copy /y "%1" "${EXPORTED_UNINSTALLER_PATH}" >nul' = 0
!endif
