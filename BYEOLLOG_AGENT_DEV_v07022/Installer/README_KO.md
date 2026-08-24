# 별록 에이전트 정식 설치 프로그램

이 폴더는 NSIS 3 Modern UI 기반의 사용자별 `Setup.exe` 소스입니다. 설치 위치는 항상
`%LOCALAPPDATA%\Programs\ByeollogCollector`이며 UAC나 관리자 권한을 요구하지 않습니다.

## 빌드

```powershell
.\Installer\Build-Setup.ps1 `
  -PayloadPath .\DIST\byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64 `
  -MakeNsisPath 'C:\Program Files (x86)\NSIS\makensis.exe' `
  -OutputPath .\Installer\dist\ByeollogAgentSetup-v0.7.0.32.exe
```

`PayloadPath`는 `Install-Byeollog.ps1 -Mode VerifyPackage`를 통과하는 v0.7.0.32의 정확한
flat package여야 합니다. 빌드 과정에서 패키지 전체 무결성과 버전을 다시 확인합니다.

코드 서명은 저장소 밖의 서명 명령을 연결합니다. NSIS 첫 pass가 내보낸
`Uninstall.exe`를 먼저 서명하고, 두 번째 pass가 그 바이트를 포함한 뒤 완성된 외부
`Setup.exe`를 서명합니다. 각 명령은 대상 경로를 마지막 인수로 받습니다. 공개판은 두
명령을 모두 전달해야 하며 하나만 전달하면 빌드가 중단됩니다. 두 결과 모두 Windows
Authenticode `Valid`가 아니면 성공으로 표시하지 않습니다. 인증서나 개인키는 이 폴더에
넣지 않습니다.

```powershell
.\Installer\Build-Setup.ps1 `
  -PayloadPath .\DIST\byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64 `
  -UninstallerSignCommandPath 'D:\offline-signing\Sign-Byeollog.ps1' `
  -UninstallerSignCommandArguments @('-AuditName', 'uninstaller', '-TargetPath') `
  -SignCommandPath 'D:\offline-signing\Sign-Byeollog.ps1' `
  -SignCommandArguments @('-AuditName', 'setup', '-TargetPath')
```

## 동작 계약

- CMD 창을 사용자에게 노출하지 않고 기존 PowerShell 검증 설치 엔진을 숨김 실행합니다.
- 이미 설치된 버전이 내장 버전보다 높으면 절대 다운그레이드하지 않고 현재 버전을 검증한 뒤
  바로가기와 표시 정보만 복구합니다. 더 최신 제거 프로그램도 덮어쓰지 않습니다.
- 설치 도중 자동 업데이트가 먼저 더 높은 버전을 확정한 경우 그 버전을 즉시 복원하고 내장
  구버전을 선택하지 않습니다.
- 실행 중인 별록이나 설치 잠금을 강제로 종료하거나 탈취하지 않습니다.
- 시작 메뉴는 숨김 PowerShell 런처를 사용하며 바탕 화면 바로가기는 기본적으로 꺼져 있습니다.
- 제거 시 설치 잠금을 잡은 채 관리형 프로그램 폴더를 고유 격리 경로로 옮긴 후 그 경로와
  설치 프로그램이 만든 바로가기만 지웁니다.
  `%LOCALAPPDATA%\ByeollogAgent`와 `%LOCALAPPDATA%\HurogiCollector`의 사용자 데이터는 보존합니다.
- 무인 설치는 `/S`, 무인 제거는 `/S`를 사용합니다. 성공은 `0`, 실행/잠금 충돌은 `1618`,
  기타 설치 실패는 `1603`, 지원하지 않는 OS는 `1633`이며 로그는
  `%TEMP%\ByeollogAgent-Setup.log`에 기록됩니다.
