# 별록 에이전트 v0.7.0.46 인계

> 대체됨: 공식 로고는 반영됐지만 빠른 시작 환경에서 HTML 전환 전의 구형 네이티브 배치가 계속 노출됐습니다. v0.7.0.48이 큰 창·DPI 대응·넓은 텍스트 배치까지 교정합니다.

## 기준

- Agent: `0.7.0.46`
- v0.7.0.45는 사용자 거부 디자인으로 운영 배포 금지
- v0.7.0.44 이하 사용자는 운영 서명 피드로 자동 업데이트

## 변경

- `Ui/byeollog_logo_dark_safe.png` 공식 로고를 시작 HTML에 data URI로 내장해 네트워크 없이 표시
- 동일 공식 로고를 WebView2 실패 시 네이티브 대체 화면에도 적용
- 레거시 `byeollog_symbol.png` 시작 화면 사용 제거
- 새 화면은 760×450, 불투명 네이티브 선표시, HTML 후전환, X 취소·창 드래그·단계 표시 유지

## 검증

- Node 계약: `122/122 PASS`
- AgentStore: `318 assertions PASS`
- win-x64 self-contained single-file publish 성공
- EXE SHA-256: `b0c96d0b64ac24d13220cf5c7ef300b1eeee626046969d019285cc3cc41e39ee`
- ZIP SHA-256: `0707de87f767ca109cc76636ef6f70a9aedf82db9aced0f3776459a8a150358f`
- ZIP bytes: `72,926,401`
- inner manifest SHA-256: `a2241df867144371188b891fd3950a0f1d784dc8cd98f8e194c7bc98f36e1aba`
- Setup SHA-256: `5ecf7a9328c1348175f117216b1cc8de90eb31b92c2aecb1c48d316c7aa556b6`
- Production feed: `0.7.0.46 / sequence 7046 / primary key`
- 로컬 v0.7.0.44→v0.7.0.46 자동 설치 및 preflight exit 0 확인

## 산출물

- `DIST/byeollog_agent_v07046_OFFICIAL_LOGO_STARTUP_WIN_X64.zip`
- `../RELEASE_v07046/byeollog_agent_setup_v07046_WIN_X64.exe`
- 서버 Production 배포: `dpl_HxrWM2k6dfdd8YZC37Z5E28M9tB5`

다음 릴리스도 새 버전 경로에 봉인하고, 서명 feed→Preview 전체 다운로드 검증→동일 배포 Production promote 순서를 유지한다.
