# 별록 에이전트 v0.7.0.61 인계

기준선은 `v0.7.0.61`이다. v0.7.0.60 및 이전 산출물은 불변으로 유지한다.

## 핵심 변경

- 추첨 GIF와 안내 문구는 `raffle-stage` 하나의 좌표·배율을 공유한다.
- 안내 문구 너비를 화면 기준이 아닌 GIF 기준 상대 너비로 고정했다.
- OBS Browser Source가 구버전 HTML을 유지하는 문제를 해결하기 위해 첫 추첨 송출 전 `refreshnocache`를 호출한다.
- 새 HTML이 `/overlay/state` 조회를 시작한 뒤에만 문서 갱신 완료로 기록한다.
- OBS가 실행되지 않거나 해당 브라우저 소스가 없으면 갱신 시도를 건너뛰어 송출 지연을 만들지 않는다.
- 기존 추첨 규칙·데이터·오버레이 키·저장 좌표 계약은 유지한다.

## 검증 기준

- Agent Node 계약 전체 통과
- AgentStore/Local Agent 전체 통과
- .NET 8 Release publish 성공
- protocol v1 설치 루트 비트 보존
- package manifest v2 검증과 ZIP 왕복 검증
- RSA-PSS-SHA256 서명 피드와 공개 ZIP의 바이트 일치

## 운영 범위

- Agent 정적 업데이트 피드와 immutable ZIP만 갱신한다.
- Supabase DB, Auth, Storage, Edge Function은 변경하지 않는다.
