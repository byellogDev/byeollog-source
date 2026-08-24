# 별록 에이전트 v0.7.0.43 인계

> 배포 금지: 최초 봉인 뒤 반복 폴백과 늦은 성공 신호 경쟁 조건을 추가로 보강하면서 이 산출물은 내부 폐기 대상이 됐다. 같은 버전 바이트를 덮어쓰지 않고 v0.7.0.44로 승격했다.

## 기준

- 제품 버전: `0.7.0.43`
- 작업 목적: 위플랩 세션 만료 시 앱 전체를 종료하지 않고 수집 WebView2만 자동 복구
- 기준 안정판 `v0.7.0.42`의 기존 패키지와 설치기는 수정하지 않았다.
- 이 문서를 작성한 시점에는 v0.7.0.43 자동업데이트 카탈로그를 서명하거나 운영 피드에 배포하지 않았다.

## 구현

1. 연결돼 있던 위플랩에서 `nologin` 신호가 연속 두 번 확인될 때만 만료로 판정한다.
2. 1차 복구는 기존 `WebView2Data` 프로필로 위플랩 루트 페이지를 다시 탐색하고 최대 5초 기다린다.
3. 1차가 실패하면 별록 전체가 아니라 수집 전용 WebView2만 폐기하고 동일 프로필로 새로 만든 뒤 최대 7초 기다린다.
4. 복구는 single-flight로 실행해 반복 신호가 WebView를 중복 생성하지 못하게 한다.
5. 수집 WebView 재초기화 중에도 `_collecting`과 활성 세션·방송 시작 시각을 유지한다.
6. 연결이 복구되면 기존 수집 스크립트를 자동으로 다시 삽입한다.
7. 두 시도가 모두 실패했을 때만 기존 위플랩 로그인 화면과 안내를 표시한다.
8. 자동 복구 중에는 메인 화면에 `자동 복구 중` 상태를 표시한다.
9. 창 종료 시 대기 중인 복구 작업을 취소하고 수명 토큰을 정리한다.

비밀번호를 저장하거나 로그인 입력을 자동화하지 않는다. 저장된 WebView2 쿠키·세션·갱신 토큰이 유효할 때 앱 재실행과 같은 복구 경로를 내부에서 재현한다.

## 변경 파일

- `MainForm.cs`
- `Ui/byeollog_ui.html`
- `BuildInfo.cs`
- `HurogiCollector.csproj`
- `UiAssetStore.cs`
- `Build-ClickOnceBeta.ps1`
- `Properties/PublishProfiles/ByeollogBetaClickOnce.pubxml`
- 버전 계약 테스트 4개
- `ContractTests/weflab-auto-session-recovery.test.mjs`
- `RELEASE_v07043_WEFLAB_SILENT_RECOVERY_KO.txt`
- `Build-v07043-AutoUpdate.ps1`

## 자동 검증

- Node 계약: `122/122 PASS`
- AgentStore/local action 회귀: `318 assertions PASS`
- .NET Release build: 성공
- self-contained win-x64 single-file publish: 성공
- `--update-preflight 0.7.0.43`: exit `0`
- v0.7.0.32 protocol-v1 install-root 바이트 보존: 성공
- v0.7.0.43 package manifest/ZIP round-trip 검증: 성공
- 정식 NSIS Setup 생성 및 sidecar 해시 일치: 성공
- 기존 WebView2 패키지에서 관찰된 `WindowsBase` MSB3277 경고 1개는 유지되며 빌드 오류는 없다.

## 산출물

- 자동업데이트 ZIP:
  - `DIST/byeollog_agent_v07043_WEFLAB_SILENT_RECOVERY_WIN_X64.zip`
  - bytes: `72,920,105`
  - SHA-256: `A550142B894C4C2180DCFCFC34379690A1098AFCA4A983F7709D38D30A0DB502`
- EXE SHA-256:
  - `026ED973D1FD97D3C416D9AA20FF493B2DCDD53A8BDD560453FBC70C33F617BF`
- 정식 설치기:
  - `../RELEASE_v07043/byeollog_agent_setup_v07043_WIN_X64.exe`
  - bytes: `71,702,923`
  - SHA-256: `7273BC578BAD5E4E85082E6ED39BA40C1163F0271DFAD858060BA0EF743EFD91`
  - Authenticode: `NotSigned`

## 공개 전 남은 실제 검증

1. 실제 수집 중 위플랩 세션을 만료시킨다.
2. 사용자 로그인 화면 없이 1차 또는 2차 복구가 완료되는지 확인한다.
3. 복구 전후 같은 수집 세션과 방송 시작 시각이 유지되는지 확인한다.
4. 만료 구간의 후원·룰렛이 누락 또는 중복되지 않았는지 확인한다.
5. 서버에서 진짜 재인증이 필요한 경우 제한된 자동 시도 뒤 수동 로그인 화면으로 전환되는지 확인한다.
6. 합격 후에만 v0.7.0.43 카탈로그를 주 업데이트키로 서명하고 Preview에서 v0.7.0.42→v0.7.0.43 자동업데이트를 검증한다.
7. Preview 합격 후 운영 stable 피드로 승격한다.

실제 만료 세션 canary와 서명된 업데이트 피드 검증 전에는 공개 stable로 승격하지 않는다.
