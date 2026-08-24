# 별록 에이전트 v0.7.0.23 Codex/Grok 인계

## 기준선

- 제품 버전: `0.7.0.23`
- Informational/UI 캐시: `0.7.0-public.21`
- 공개 표시: `0.7.0 공개판 21`
- 운영 Supabase: `offslvwaugvjotkywlus`
- 운영 Vercel: `observer_abangseladmin` (이번 변경 없음)
- v0.7.0.22 소스 체크포인트는 공개 봉인 경로를 막은 중간본이다. 사용자가 배포 가능 상태를 요청해 v0.7.0.23에서 인증서 강제 차단만 원복했다.

## 완료한 세 가지 치명적 수정

### 1. 5번째 이상 겹침 아봉 지연

- `VNextLocalAgent.ExecutionSlotLease`를 추가했다.
- 시간제 OBS/Windows 마이크 실행은 `TimedMuteCoordinator`가 공유 세션에 수락한 직후 실행 슬롯을 반환한다.
- 비시간제 액션은 기존처럼 완료까지 슬롯을 보유한다.
- `Interlocked.Exchange`로 callback/continuation 경합 중 semaphore 과다 반환을 막는다.

### 2. 참가자 heartbeat 실패의 공유 세션 조기 종료

- 시간제 액션 heartbeat가 먼저 실패해도 `actionStop.Cancel()`을 호출하지 않는다.
- 마이크/오버레이 물리 세션과 원상 복구를 끝까지 기다린 뒤 해당 실행만 `uncertain`으로 기록한다.
- 공유 `session.Stop`에는 leader 토큰만 등록한다. 이미 수락된 follower 취소는 다른 참여자를 종료하지 않는다.
- 회귀 시험에서 follower 취소 후 mute 1회, 중간 unmute 0회, 최종 unmute 1회를 확인했다.

### 3. 로그아웃된 Supabase 세션의 남은 JWT 허용

- 소스 migration: `supabase/migrations/20260820044525_enforce_active_manager_session.sql`
- 운영 적용: `20260820045418 enforce_active_manager_session`
- `byeollog_automation.assert_canary_manager_v1(uuid)`가 `g3a_assert_active_auth_session_v1(...)` 반환값을 `if ... or not ...`으로 검사한다.
- 기존 `STABLE`, `SECURITY DEFINER`, 빈 `search_path`, 5초 timeout, owner/ACL을 보존했다.
- rollback canary에서 활성 manager 세션은 허용되고 임의 session UUID는 SQLSTATE `42501`로 거부됐다.
- 행 데이터, Auth, Storage, 키, RLS, Edge Function, Vercel은 변경하지 않았다.

## 코드 서명 결정

- 이 PC에는 신뢰된 코드 서명 인증서/개인 키가 없다.
- 사용자가 지금 배포해야 한다고 명시해 인증서 필수 하드 게이트는 원복했다.
- v0.7.0.23 공개 EXE/Tester ZIP은 기존 `trusted_channel_internal` 방식으로 생성 가능하다.
- EXE Authenticode 상태는 `NotSigned`가 정상이며 SmartScreen/AV/기업 정책 경고 가능성은 잔존한다.
- `Sign-PublicRelease.ps1`은 후속 서명 작업 참고용으로만 보존되며 현재 `02_PUBLISH.cmd`에서 호출하지 않는다.

## 검증 결과

- Node UI/계약: `91/91`
- Local Agent/timed mute/overlay: `279 assertions`
- .NET SDK: `8.0.424`
- Release build/publish: 성공, 오류 0개 (기존 WebView2 WindowsBase 참조 경고 1개)
- 운영 함수 본문/속성/ACL: PASS
- 운영 활성/종료 세션 rollback canary: PASS
- 이번 함수 교체로 생긴 신규 Supabase advisor 경고 없음

## 최종 사용자 배포물

- EXE: `byeollog_agent_v07023_SAFETY_GATES_WIN_X64.exe`
  - 크기: `79,471,305 bytes`
  - SHA-256: `2CA9D16133AB62004C2A57D65983C22D51F08F01CE01FDC3898F54C2B1B8656B`
  - Authenticode: `NotSigned` (사용자 요청에 따라 인증서 작업은 후속으로 연기)
- Tester ZIP: `byeollog_agent_v07023_SAFETY_GATES_WIN_X64.zip`
  - 크기: `72,873,387 bytes`
  - SHA-256: `8DB2567E9CA4E4B38582CDEAA17F25C0B45614167BE4D4CF0384AFB1D53EA8E6`
  - 배포 채널: `trusted_channel_internal`
- 사용자에게는 단독 EXE보다 manifest와 설치 스크립트를 포함한 Tester ZIP을 우선 전달한다.

## 실기기 필수 확인

1. 기존 별록을 트레이까지 종료하고 v0.7.0.23 Tester ZIP으로 설치한다.
2. 10초 아봉을 시작하고 약 5초 뒤 같은 아봉을 5회 이상 추가한다.
3. 중간 마이크 ON, 오버레이 비활성/깜빡임 없이 합계 시간 뒤 한 번만 원복되는지 본다.
4. 실행 중 네트워크를 잠시 끊어 heartbeat가 실패해도 물리 세션이 조기 종료되지 않는지 본다.
5. Windows 다운로드/실행 경고가 발생하면 ZIP·EXE SHA-256을 먼저 확인하고 후속 코드 서명 작업으로 전환한다.

## 비회귀 원칙

- `%LOCALAPPDATA%\ByeollogAgent` 설정·수집 데이터 보존
- 로그인, 수집, 룰렛, 업보, 장치 등록, OBS/Windows 마이크, 기존 규칙/실행 이력 보존
- 데이터 삭제, DROP/TRUNCATE, Auth·Storage 조작, 비밀키 회전, DNS·도메인·결제 변경 금지
