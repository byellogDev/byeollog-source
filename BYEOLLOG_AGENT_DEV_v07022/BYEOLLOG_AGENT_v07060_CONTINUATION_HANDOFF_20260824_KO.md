# 별록 에이전트 v0.7.0.60 인계

기준선은 `v0.7.0.60`이다. v0.7.0.59 및 이전 산출물은 불변으로 유지한다.

## 핵심 변경

- 추첨 GIF와 안내 문구를 `raffle-stage` 하나로 묶었다.
- 저장된 위치는 GIF 중심점에 적용하고 안내 문구는 GIF 바로 아래에 배치한다.
- 저장된 배율은 스테이지 전체를 확대·축소하여 GIF와 문구의 비율을 유지한다.
- 일반 마이크 오버레이 렌더링 경로는 변경하지 않았다.
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
