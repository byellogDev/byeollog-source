# 별록 에이전트 v0.7.0.58 인계

기준선은 `v0.7.0.58`이다. v0.7.0.57 및 이전 산출물은 불변으로 유지한다.

## 핵심 변경

- 상단 별록 액션 메뉴의 독립 `추첨 관리` 탭을 제거했다.
- `raffle.ticket_grant` 액션 카드에만 `추첨 관리` 버튼을 표시한다.
- 카드 버튼 순서는 `추첨 관리 → 테스트 송출 → 수정 → 삭제`다.
- 추첨 관리 화면에는 `← 액션 목록` 버튼을 제공한다.
- 기존 추첨 관리 뷰, 수동 봉인, 한 장씩 추첨, 이력 및 RPC 계약은 변경하지 않았다.

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
- 관리형 설치의 자동 업데이트·단일 실행 인계 동작은 v0.7.0.57 계약을 그대로 사용한다.
