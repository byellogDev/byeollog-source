# 별록 에이전트 v0.7.0.59 인계

기준선은 `v0.7.0.59`이다. v0.7.0.58 및 이전 산출물은 불변으로 유지한다.

## 핵심 변경

- `raffle.ticket_granted` 내장 GIF를 투명 배경의 공식 추첨권 지급 애니메이션으로 교체했다.
- `raffle.draw` 내장 GIF는 별 장식 없는 추첨함과 지급 이미지와 동일한 비율·도안의 추첨권을 사용한다.
- 추첨권은 추첨함 슬롯 뒤에서 위로 올라오고 전면 립이 추첨권 앞을 가린다.
- 완전히 나온 뒤 역재생하지 않으며 첫 프레임으로 즉시 돌아가 반복한다.
- 기존 오버레이 키와 사용자 위치·크기 설정은 유지한다.

## 검증 기준

- Agent Node 계약 전체 통과
- AgentStore/Local Agent 전체 통과
- .NET 8 Release publish 성공
- GIF 투명 배경·24프레임·무한 반복·정확한 SHA-256 계약 통과
- protocol v1 설치 루트 비트 보존
- package manifest v2 검증과 ZIP 왕복 검증
- RSA-PSS-SHA256 서명 피드와 공개 ZIP의 바이트 일치

## 운영 범위

- Agent 정적 업데이트 피드와 immutable ZIP만 갱신한다.
- Supabase DB, Auth, Storage, Edge Function은 변경하지 않는다.
- 관리형 설치의 자동 업데이트·단일 실행 인계 동작은 v0.7.0.58 계약을 그대로 사용한다.
