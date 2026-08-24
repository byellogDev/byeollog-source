# 별록 에이전트 v0.7.0.24 Codex/Grok 인계

## 기준선

- 제품 버전: `0.7.0.24`
- Informational/UI 캐시: `0.7.0-public.22`
- 공개 표시: `0.7.0 공개판 22`
- 운영 Supabase: `offslvwaugvjotkywlus`
- 운영 Vercel: `observer_abangseladmin` (이번 변경 없음)
- 기준 소스: `BYEOLLOG_AGENT_DEV_v07022`에 누적된 v0.7.0.24 소스

## 장애 1: 규칙 저장 HTTP 400 / PostgreSQL 42702

- 운영 Postgres 로그에서 `column reference "rule_id" is ambiguous`를 확인했다.
- `byeollog_automation.save_guided_rule_compat_v1`은 `rule_id`를 OUT 반환 열로 선언하면서 기존 규칙 교체 분기의 네 조건에서 `where rule_id = v_rule_id`를 사용했다.
- 소스 migration: `supabase/migrations/20260820052623_fix_save_guided_rule_v7_ambiguous_rule_id.sql`
- 운영 적용: `20260820052931 fix_save_guided_rule_v7_ambiguous_rule_id`
- 네 조건을 각각 실제 테이블 alias로 한정했다: `public_condition`, `public_action`, `runtime_condition`, `runtime_action`.
- 함수의 owner `postgres`, ACL, `SECURITY DEFINER`, 빈 `search_path`, 10초 timeout을 보존하고 검증했다.
- 실제 활성 manager 세션과 장치로 규칙 생성 후 같은 규칙 수정을 실행해 version `1 → 2`를 확인했으며, 전체 canary 트랜잭션은 롤백했다.
- 데이터 삭제, Auth/Storage/키/RLS/Edge Function/Vercel 변경은 없다.

## 장애 2: 테스트 송출과 실제 액션의 lease 만료

- 기존 두 테스트 실행은 서버에서 claim됐지만 약 45.8초 뒤 `execution lease expired after final attempt`로 실패했다.
- 에이전트 로컬 로그에는 작업 수신이나 액션 시작 기록이 없었다.
- 운영 `agent-runtime-g3a`는 `executionId`에 UUID, `idempotencyKey`에 64자리 SHA-256을 반환한다. 운영 DB 제약과 claim RPC도 이 계약을 따른다.
- 클라이언트 `VNextDevelopmentClient.ClaimAgentExecutionAsync`가 두 값을 같아야 한다고 잘못 검사해 모든 작업을 실행 전에 거절하고 있었다.
- `executionId`와 `eventId`는 canonical UUID로, `idempotencyKey`는 소문자 64자리 SHA-256으로 독립 검증하도록 수정했다.
- 서버 계약과 DB 멱등키 값은 변경하지 않았다.
- 이전 실패/재시도 이력은 감사 기록이므로 삭제하지 않는다. v0.7.0.24 설치 후 새 테스트 송출 성공 여부로 확인한다.

## 코드 서명 결정

- 사용자는 현재 사용자 배포를 우선하고 인증서 작업을 후속으로 연기했다.
- v0.7.0.24 공개 EXE/Tester ZIP은 기존 `trusted_channel_internal` 방식으로 생성한다.
- EXE Authenticode 상태 `NotSigned`는 현재 예상값이며 SmartScreen/AV/기업 정책 경고 가능성은 남는다.

## 검증 결과

- Node UI/계약: `91/91`
- Local Agent/timed mute/overlay: `279 assertions`
- .NET 8 Release build 및 self-contained single-file publish: 성공
- 기존 WebView2 `WindowsBase` 참조 경고 1종 외 빌드 오류 없음
- 운영 규칙 생성→수정 rollback canary: PASS
- 실기기 테스트 송출은 기존 앱을 트레이까지 종료하고 v0.7.0.24를 실행한 뒤, 방송 중이 아닐 때 사용자가 확인한다.

## 최종 사용자 배포물

- EXE: `byeollog_agent_v07024_CLAIM_CONTRACT_FIX_WIN_X64.exe`
  - 크기: `79,471,305 bytes`
  - SHA-256: `C4C0317EEC9BA27B325D84C1BC69812591F317535E8FF50314BE5FFA26E16F71`
  - FileVersion: `0.7.0.24`
  - ProductVersion: `0.7.0-public.22`
  - Authenticode: `NotSigned`
- Tester ZIP: `byeollog_agent_v07024_CLAIM_CONTRACT_FIX_WIN_X64.zip`
  - 크기: `72,873,511 bytes`
  - SHA-256: `94C542B4C7836AB2CEB21141D6E9B8D7A730E00984477E915F39B5BD260E179C`
  - manifest v2: 18 files, `trusted_channel_internal`
- 단독 EXE보다 설치·검증 도구와 manifest를 포함한 Tester ZIP을 우선 배포한다.

## 비회귀 원칙

- `%LOCALAPPDATA%\ByeollogAgent` 설정·수집 데이터 보존
- 로그인, 수집, 룰렛, 업보, 장치 등록, OBS/Windows 마이크, 기존 규칙/실행 이력 보존
- 멱등키 SHA-256 계약, Queue/ACK/heartbeat 경계 보존
- 데이터 삭제, DROP/TRUNCATE, Auth·Storage 조작, 비밀키 회전, DNS·도메인·결제 변경 금지
