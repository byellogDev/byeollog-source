# 별록 에이전트 v0.7.0.45 인계

> 배포 금지: 사용자가 시작 화면의 레거시 로고와 디자인을 거부했습니다. 이 봉인본은 운영 피드에 올리지 않으며 v0.7.0.46이 대체합니다.

## 목적과 상태

- 기존 560×330 네이티브 시작 창을 더 큰 760×450 HTML 기반 제품 화면으로 개편했다.
- 이미 봉인된 v0.7.0.44의 바이트는 덮어쓰지 않고 v0.7.0.45로 승격했다.
- v0.7.0.44의 위플랩 세션 무인 복구 기능과 사용자 설정·수집 데이터 계약을 그대로 보존한다.
- v0.7.0.45의 운영 업데이트 카탈로그는 아직 서명·배포하지 않았다.
- 로컬에 설치된 사용 버전은 이 작업에서 변경하지 않았다.

## 시작 화면 계약

1. 폼이 표시되면 불투명한 네이티브 폴백을 즉시 그린다.
2. 같은 폼 안에서 프로그램에 내장된 `Ui/startup_loading.html`을 비동기로 준비한다.
3. HTML 준비는 Program의 저장소·로그인·메인·위플랩 화면 예열과 병렬로 진행하고 앱 시작을 막지 않는다.
4. HTML 준비가 끝나면 같은 760×450 영역에서 원자적으로 전환한다.
5. 외부 URL, 외부 폰트, 네트워크 이미지, 팝업, 다른 페이지 이동, 개발자 도구와 기본 문맥 메뉴를 사용하지 않는다.
6. X 버튼은 우상단 22px 여백의 44×44 버튼이며 시작 취소를 요청한다.
7. 상단 드래그 영역으로 창을 이동할 수 있다.
8. WebView2 초기화 실패·제한 시간 초과 시 네이티브 폴백을 유지하고 로그인 준비를 계속한다.
9. 시작 WebView 캐시는 `%LOCALAPPDATA%\ByeollogStartupUi`에 분리한다. 데이터 마이그레이션 전에 `%LOCALAPPDATA%\ByeollogAgent`를 선점하지 않기 위함이다.

## 검증

- HTML 실제 렌더: `760×450`, 문서 스크롤 `760×450`, overflow `hidden`
- X 버튼 렌더: `44×44`, 우상단 22px 여백
- Node 계약: `122/122 PASS`
- AgentStore/local action: `318 assertions PASS`
- .NET Release build 및 self-contained win-x64 publish: PASS
- `--update-preflight 0.7.0.45`: exit `0`
- protocol-v1 install-root byte preservation: PASS
- package manifest, VerifyPackage, ZIP round-trip: PASS
- NSIS 정식 설치기 2-pass build와 외부 SHA sidecar: PASS
- 기존 WebView2 참조의 `WindowsBase` MSB3277 경고 1개 외 오류 없음

## 산출물

- ZIP: `DIST/byeollog_agent_v07045_HTML_STARTUP_WIN_X64.zip`
  - bytes: `72,926,474`
  - SHA-256: `4DB125167CF0625FA6010B7088DBBD9CA2B49939941A528D7E8C9FFEF4E44CAC`
- EXE SHA-256: `A1ED000A28A39CD7093BC9B8D0F7C57C5B591F1BEFA46BC8A7F8C6F805BA581A`
- Setup: `../RELEASE_v07045/byeollog_agent_setup_v07045_WIN_X64.exe`
  - bytes: `71,713,520`
  - SHA-256: `3DE5EFCD02F351EA8248090FDAA66DC0598BA02FF481B66CA173CC7952C6B52F`
  - Authenticode: `NotSigned`
- 디자인 렌더: `artifacts/startup_loading_preview.png`

## 공개 stable 전 확인

1. 일반 Windows PC에서 시작 즉시 불투명 폴백이 보이고 HTML 화면으로 자연스럽게 전환되는지 확인
2. X 버튼 취소와 상단 창 드래그 확인
3. WebView2 Runtime 손상·누락 환경에서도 네이티브 폴백으로 로그인 안내까지 진행되는지 확인
4. 기존 v0.7.0.44 위플랩 만료 세션 canary와 후원·룰렛 누락·중복 0건 확인
5. v0.7.0.45 카탈로그를 주 업데이트키로 서명하고 Preview 자동업데이트 확인
6. 통과 후 운영 stable 피드 승격
