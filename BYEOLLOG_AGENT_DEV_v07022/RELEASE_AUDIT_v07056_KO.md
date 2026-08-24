# 별록 에이전트 v0.7.0.56 공개 배포 감사

감사 일시: 2026-08-24 KST

## 구현 결과

- 추첨 시작 전 사용자가 당첨 개수를 1~100개로 지정한다.
- `추첨 시작 · 추첨함 봉인`을 누르면 당시 티켓 풀, 당첨 개수, 중복 허용 설정을 서버 트랜잭션으로 고정한다.
- 봉인 후 새로 지급된 티켓은 별도 open 회차에 쌓여 현재 추첨 결과에 영향을 주지 않는다.
- `다음 1장 추첨`은 한 번에 당첨자 한 명과 OBS 실행 한 건만 확정한다.
- 예상 추첨 순서를 서버에 보내 중복 클릭, 오래된 화면, 동시 요청을 차단한다.
- 마지막 한 명이 확정될 때만 회차가 완료된다.

## 검증

- Agent Node 계약: 125/125 PASS
- AgentStore/Local Agent: 345 assertions PASS
- Server Node 계약: 32/32 PASS
- .NET 8 Release build: PASS (기존 WebView2 WPF 참조의 WindowsBase 경고 1건, 오류 0건)
- 패키지 자체 검증 및 ZIP 왕복: PASS
- EXE SHA-256: `fd78d14330f892cab28962633b2c6bb85c07ee192787e6795d48e03c63c93356`
- ZIP SHA-256: `479702b154e055045f53f1dff3163662de558e4eb38528471cb0c5bc53b3b06e`
- ZIP 크기: 76,402,017 bytes
- signed feed SHA-256: `cac5ccfec980945f7acc310546811d0bb795433b5dbb43c74b99431f6d4b668d`
- feed release sequence: 7056

## 운영 반영

- Supabase project: `offslvwaugvjotkywlus`
- migration: `add_manual_raffle_draw_control`
- 운영 적용 전 추첨 라운드/실행 데이터: 0건
- 운영 적용 후 상태 제약, 봉인 회차 고유 인덱스, 보호 트리거, 관리자 RPC 3개 확인 완료
- 익명 및 service_role 실행권 없음, authenticated만 호출 가능하며 각 RPC 내부에서 워크스페이스 관리자 권한을 재검증한다.
- Vercel production deployment: `dpl_GBRmTdUDewGZsapeWdwvXP7pyjyy` / READY
- 공개 `byeollog.com` feed와 ZIP: HTTP 200, 로컬 원본과 SHA-256 일치
- 배포 직후 Vercel error log: 0건

## 보안·성능 어드바이저

- 신규 RPC는 의도된 authenticated SECURITY DEFINER 경고가 발생한다. 모든 함수는 빈 search_path, 짧은 statement timeout, 관리자 검증, 최소 EXECUTE grant를 적용했다.
- 기존 `Leaked Password Protection Disabled` 경고는 이번 추첨 변경과 무관하며 외부 Auth 설정 항목으로 남아 있다.
- unused index는 통계 초기 상태의 정보성 항목이라 공개 배포 직전에 삭제하지 않았다.

## 남은 실제 환경 확인

- 운영 DB에는 아직 실제 추첨 티켓 데이터가 없어서, 실제 계정에서 `티켓 지급 → 봉인 → 1장씩 추첨 → OBS 개별 송출` 전 과정을 실행하는 첫 방송 canary는 남아 있다.
- v0.7.0.55 이하 설치 사용자는 다음 실행 시 서명된 안정 채널에서 v0.7.0.56을 자동으로 받는다. 적용에는 앱 재시작이 필요할 수 있다.
