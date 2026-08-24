# 별록 에이전트 v0.7.0.44 인계

## 목적과 상태

- 위플랩 세션 만료 시 앱 전체를 끄지 않고 수집 WebView2만 자동 복구한다.
- v0.7.0.43 최초 봉인 뒤 발견한 반복 폴백·늦은 성공 신호 경쟁 조건을 보강해 v0.7.0.44로 승격했다.
- v0.7.0.43은 내부 폐기 대상이며 배포하지 않는다.
- v0.7.0.44의 운영 업데이트 카탈로그는 아직 서명·배포하지 않았다.

## 복구 계약

1. `nologin` 신호를 연속 두 번 확인한 뒤에만 자동 복구를 시작한다.
2. 같은 복구는 single-flight로 합친다.
3. 1차는 기존 `WebView2Data` 프로필로 위플랩 루트를 다시 탐색하고 5초 기다린다.
4. 2차는 수집 WebView2만 같은 프로필로 새로 만들고 7초 기다린다.
5. 2차 초기화 중에도 활성 수집 세션·방송 시작 시각·`_collecting`을 유지한다.
6. 성공하면 수집 스크립트를 자동 재삽입한다.
7. 시간 경계에 늦게 도착한 연결 성공도 복구 성공으로 인정한다.
8. 두 시도 실패 후에만 재로그인 화면을 한 번 표시하고 자동 복구 반복을 멈춘다.
9. 비밀번호 입력 자동화나 인증정보 별도 저장은 하지 않는다.

## 검증

- Node 계약: `122/122 PASS`
- AgentStore/local action: `318 assertions PASS`
- .NET Release build 및 self-contained win-x64 publish: PASS
- `--update-preflight 0.7.0.44`: exit `0`
- protocol-v1 install-root byte preservation: PASS
- package manifest, VerifyPackage, ZIP round-trip: PASS
- NSIS 정식 설치기 2-pass build와 외부 SHA sidecar: PASS
- 기존 WebView2 참조의 `WindowsBase` MSB3277 경고 1개 외 오류 없음

## 산출물

- ZIP: `DIST/byeollog_agent_v07044_WEFLAB_SILENT_RECOVERY_WIN_X64.zip`
  - bytes: `72,920,107`
  - SHA-256: `1D9B2E578770021164B548116A1BC3F2865D5865C5115C69F9DA9771E385187D`
- EXE SHA-256: `FA4647B9E36D5BCFF3B913181E01433167E2756944417463F8F941B3E0635ABC`
- Setup: `../RELEASE_v07044/byeollog_agent_setup_v07044_WIN_X64.exe`
  - bytes: `71,707,631`
  - SHA-256: `597E62BA22AFC72CD5F1B04324A832017E09AA994B19B37D50E90AE0E775D8BA`
  - Authenticode: `NotSigned`

## 공개 stable 전 필수

1. 실제 수집 중 위플랩 세션 만료 canary
2. 자동 복구 전후 수집 세션·시작 시각 유지 확인
3. 만료 구간 후원·룰렛 누락 및 중복 0건 확인
4. 서버 재인증이 필요한 상태에서 수동 로그인 화면 1회 폴백 확인
5. v0.7.0.44 카탈로그를 주 업데이트키로 서명
6. Preview에서 설치된 v0.7.0.42가 v0.7.0.44로 자동 갱신되는지 확인
7. 통과 후 운영 stable 피드 승격

로컬에 설치된 사용 버전은 이 작업에서 변경하지 않았다.
