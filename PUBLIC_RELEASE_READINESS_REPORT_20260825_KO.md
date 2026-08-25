# 별록 공개배포 준비 및 운영 반영 보고서 — 2026-08-25

## 결론

이번 범위의 비파괴적 개선은 운영 반영을 완료했습니다. Windows Agent `0.7.0.71`, Vercel Production, Supabase 마이그레이션과 Edge Function이 동일 계약으로 정렬됐습니다. 코드·DB·자동 업데이트 산출물에서 공개배포를 막는 새 P0/P1은 확인되지 않았습니다.

## 수정한 사항

- Automation Agent heartbeat와 실제 Weflab 수집 상태를 분리했습니다.
  - 방송을 수집하지 않는 정상 상태는 `idle`입니다.
  - 수집 중인데 2분 넘게 새 관측이 없을 때만 `stalled`입니다.
  - 구형 Agent는 거짓 정상 대신 `unknown`으로 표시합니다.
- 늦게 수신되어 마이크/오버레이 실행을 억제한 이벤트를 안전 결정 기록으로 남깁니다.
- 배포 현황 화면에서 과거 액션 시각과 현재 Agent 상태가 섞이지 않게 문구와 시간을 분리했습니다.
- 일괄 분류의 `&` 결과 수와 실제 룰렛 회전 수를 분리해 한 번의 룰렛 결과가 두 작업으로 저장되어도 `over`로 오판하지 않게 했습니다.
- 사용자가 누르는 일괄 처리만 행 버전과 승인 내용을 묶어 처리하며, 처리 중 내용이 바뀌면 재검토하도록 fail-closed 처리했습니다.
- 일반 사용자 화면에서 TEST 데이터 전체 삭제 버튼을 제거했습니다.
- Superseded Agent RPC(v8/v9/v10, raffle state v1)의 직접 실행 권한을 회수했습니다. 현재 v11/v2는 유지했습니다.
- Agent Release 빌드의 `WindowsBase` 충돌 경고를 제거해 경고 0, 오류 0으로 정리했습니다.
- 루트 Git 추적 경계, 비밀/산출물 제외, PostgreSQL 17·Node 22·.NET 8 CI 게이트를 추가했습니다.

## 운영 반영

### Vercel

- Project: `observer_abangseladmin`
- 검증 Preview: `dpl_AmpfLTGGsoca8yHSZdpWrs5owTJn`
- Production: `dpl_4itAANkC16WveGtQviErqJxNRU6J`
- Aliases: `byeollog.com`, `www.byeollog.com`
- Node runtime: `22.x`
- Region: `hnd1`

### Supabase

- Project: `offslvwaugvjotkywlus`
- Applied migrations:
  - `add_collection_health_and_event_decisions`
  - `revoke_superseded_agent_rpcs`
- Edge Functions:
  - `agent-runtime-g3a v8` — ACTIVE, `verify_jwt=true`
  - `event-runtime-g3a v5` — ACTIVE, `verify_jwt=true`
  - `execution-worker-g3a v2` — ACTIVE, unchanged
- 새 테이블은 RLS가 활성화됐고 anon/authenticated 직접 접근은 차단했습니다.
- 배포 직후 Agent runtime v8 실제 요청 HTTP 200을 확인했습니다.

### Agent 자동 업데이트

- Version: `0.7.0.71`
- Release sequence: `7071`
- Package: `byeollog_agent_v07071_COLLECTION_HEALTH_VISIBILITY_WIN_X64.zip`
- ZIP bytes: `75,241,743`
- ZIP SHA-256: `24bcd58baa2c738a2426a8aa576a1e4a65dab9ab5fc1594492de788e18c5820a`
- EXE SHA-256: `2b78a6112f7452e9f7729673ce418bd9af6c86789ee19f769c4bc2723372f187`
- Signed feed SHA-256: `ed84c2edf61a2fcf67b5804445d7b17c82690af0f70fac2711d5e1a572d9dfc1`
- Preview와 `byeollog.com`에서 feed/ZIP 전체 바이트·길이·SHA-256 일치를 확인했습니다.

## 검증 결과

- Server Node tests: `71/71` PASS
- Agent Node contract tests: `132/132` PASS
- AgentStore integration: `464 assertions` PASS
- Agent self-contained win-x64 publish/preflight: PASS, warnings `0`, errors `0`
- PostgreSQL 17 collection-health migration harness: PASS
- Deno Edge checks: PASS
- Repository boundary/security gate: PASS, SECURITY DEFINER `43`개 정적 감사
- Vercel Preview route smoke test: PASS
- Production update feed and 75MB ZIP: exact byte/hash PASS
- Vercel 배포 후 15분 runtime error: `0`
- 현재 운영 pending execution: `0`

## 남은 사항

- Authenticode 공개 서명은 유료 외부 신원/서명 서비스가 필요해 보류했습니다. 업데이트 피드는 별도 RSA 서명으로 보호됩니다.
- 상시 TTS 호스팅은 비용 문제로 보류했습니다.
- Supabase leaked-password protection은 현재 요금/외부 설정 범위로 보류했습니다.
- SECURITY DEFINER 경고 6건은 로그인한 owner/manager가 사용해야 하는 현재 API facade이며 내부에서 세션·멤버십·workspace를 검증합니다. [Supabase 안내](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
- unused index는 아직 사용 통계가 부족하므로 삭제하지 않았습니다. [Supabase 안내](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index)
- 실제 수집 방송이 없는 현재 상태에서 collection health 행이 0건인 것은 정상입니다. v0.7.0.71 Agent가 실행되면 `idle` 또는 실제 수집 상태가 기록됩니다.

## SOOP Developers 재신청용 외부 API 수신 준비

- 운영 Redirect URL `https://byeollog.com/api/auth/soop/callback`을 Vercel Production에 개설했습니다.
- 공개 URL은 기존 인증 함수의 `soop-callback` 작업으로 연결되며 GET·HEAD만 허용합니다.
- 신청·심사 단계에서는 `authCode` 수신 여부만 안전한 화면으로 처리하고, 코드·`state`·오류 상세를 저장하거나 외부에 노출하지 않습니다.
- 이 작업은 **공식 SOOP API 연동 완료가 아니라 승인 전 수신 경로 확보**입니다. 승인 후 Client ID/Secret과 규격을 받은 다음 `state` 검증, 토큰 교환·암호화 저장·갱신·연결 해제를 별도 구현해야 합니다.
- 재신청 이후에도 URL, Vercel rewrite와 회귀 테스트를 유지해야 하며, 상세 내용은 `BYEOLLOG_SOOP_OAUTH_CALLBACK_DEPLOYMENT_REPORT_20260824_KO.md`를 권위 기록으로 사용합니다.

## 명시적으로 제외한 작업

- 백그라운드 업데이트 알림 및 구버전 자동 정리
- 여러 구버전이 함께 설치된 환경의 회귀 테스트

현재 실제 구버전 사용자가 없다는 운영 판단에 따라 두 항목은 구현·삭제 작업 없이 범위에서 제외했습니다.

## 데이터 안전성

- DROP/TRUNCATE, 사용자 데이터 삭제, Auth·Storage 조작, 비밀키 회전, DNS·결제 변경을 하지 않았습니다.
- DB 변경은 새 테이블/RPC 추가와 구형 RPC 실행 권한 회수뿐입니다.
