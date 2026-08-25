# 별록 에이전트 v0.7.0.83 배포 감사

기준: 2026-08-25 KST

## 변경

- 추첨권 지급 문구를 `<시청자>, 추첨권 <수량>장!`으로 줄이고 누적 안내를 제거했다.
- 당첨 화면은 `추첨 <현재>/<전체>`와 `<시청자>님 당첨!`만 표시하도록 정리했다.
- 이미지와 문구 사이 간격을 줄여 OBS 화면 점유 영역을 축소했다.
- 추첨권 중앙 별과 반짝이 애니메이션은 유지하고, 봉투 앞면의 별 봉인만 제거했다.

## 에이전트 봉인본

- version / release sequence: `0.7.0.83 / 7083`
- package: `byeollog_agent_v07083_RAFFLE_OVERLAY_COMPACT_WIN_X64.zip`
- ZIP: `78,606,076 bytes`
- ZIP SHA-256: `3a54543348eb685f387c1b6b8bf50bcd614337556babca02a6f99eece6776a34`
- EXE SHA-256: `a3cfd8ebfdc7d7cadabe003a6243bc33c793bdacc1b430555d374c81dcdce9fe`
- inner manifest SHA-256: `dd2f1c3049f682e0620fe8ab08c896923388ce265791ed38603dc80a5f435490`
- signed feed SHA-256: `441e2d66305f102d03f4eeb78dded9fc4a9756e99ec4b63078e6c5b55207c5e2`
- signer: primary `rsa3072-cc1fb719f3a63774`, RSA-PSS-SHA256

## 검증

- Agent Node contracts: `137/137 PASS`
- AgentStore/integration: `535 PASS`
- server tests: `73/73 PASS`
- Agent update preflight: exit code `0`
- 1920x1080 overlay visual verification: no overflow / browser error
- Preview feed와 전체 ZIP: 로컬 봉인본과 크기·SHA-256 일치
- Production feed와 전체 ZIP: HTTP 200, 로컬 봉인본과 크기·SHA-256 일치
- Production 홈페이지: HTTP 200
- 배포 직후 15분 Production runtime error cluster: `0건`
- 새 Production deployment error/fatal log: `0건`

## Vercel

- verified Preview: `dpl_5KrYjTApLYX4VWrqxyg5FhicSnxP`, `READY`
- Preview URL: `https://observer_abangseladmin-j0qqsjj0a-jminsu123-7345s-projects.vercel.app`
- Production: `dpl_HKEA7wM9ZZQMTyRawbnkhzTcjbYg`, `READY`
- aliases: `byeollog.com`, `www.byeollog.com`

운영 PC는 방송·수집 중 강제 재시작하지 않는다. 관리형 Launcher를 다음에 정상 실행할 때 v0.7.0.83 자동 업데이트를 확인한다.
