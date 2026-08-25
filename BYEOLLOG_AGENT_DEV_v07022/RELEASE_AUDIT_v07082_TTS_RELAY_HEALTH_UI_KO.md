# 별록 에이전트 v0.7.0.82 배포 감사

기준: 2026-08-25 KST

## 변경

- 메인 연결 상태 카드를 3칸에서 4칸으로 확장했다.
- 고정 TTS relay `/healthz`를 시작 직후와 1분마다 확인한다.
- 기대 음성 버전이 정상일 때 `연결됨 · 정상 연결`, 실패 시 `연결 안 됨 · 예비 음성 사용`을 표시한다.
- TTS 로컬 시작 작업은 로그인 시작과 5분 주기 자가 복구를 함께 사용한다.

## 에이전트 봉인본

- version / release sequence: `0.7.0.82 / 7082`
- package: `byeollog_agent_v07082_TTS_RELAY_HEALTH_UI_WIN_X64.zip`
- ZIP: `78,756,662 bytes`
- ZIP SHA-256: `192c85b53c38d255092110412ce9120d4f57a13b3c02ac43d804962cdcb1ea5a`
- EXE SHA-256: `7cc652d29041854b92ad93cff8590576f79250e72f49bcc0f8433a6d325b168d`
- inner manifest SHA-256: `9680320b908811bd87433e434817e2fba847738611b0d9c6aa2fa84fde523fd3`
- signed feed SHA-256: `1ab22cdf0f8e22f8cbdd74c7e207509c8f01f71eac58f7f5065958ca98c434e4`
- signer: primary `rsa3072-cc1fb719f3a63774`, RSA-PSS-SHA256

## 검증

- Agent Node contracts: `137/137 PASS`
- AgentStore/integration: `534 PASS`
- server tests: `73/73 PASS`
- Agent update preflight: exit code `0`
- Preview feed와 전체 ZIP: 로컬 봉인본과 크기·SHA-256 일치
- Production feed와 전체 ZIP: HTTP 200, 로컬 봉인본과 크기·SHA-256 일치
- Production 홈페이지: HTTP 200
- 고정 TTS relay: `healthy=true`, `raffle-winner-cosyvoice3-v1`
- 배포 직후 Production error log: `0건`

## Vercel

- verified Preview: `dpl_8uLY9dEPkg3QydXfKfT2h349HKnA`
- Production: `dpl_HqkfPZDeMpPkoS2jhDZVG4xy6si3`, `READY`
- aliases: `byeollog.com`, `www.byeollog.com`

운영 PC는 방송·수집 중 강제 재시작하지 않는다. 관리형 Launcher를 다음에 정상 실행할 때 v0.7.0.82 자동 업데이트를 확인한다.
