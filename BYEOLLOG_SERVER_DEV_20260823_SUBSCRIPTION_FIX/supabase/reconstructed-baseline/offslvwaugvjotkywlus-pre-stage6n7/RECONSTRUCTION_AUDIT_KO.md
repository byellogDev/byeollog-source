# Stage 6N7 이전 Supabase 스키마 역분석 감사

- 작성일: 2026-08-31 (Asia/Seoul)
- 대상 프로젝트: `offslvwaugvjotkywlus`
- 목표 시점: `20260814121415_p0_withdraw_transaction.sql` 적용 직전
- 운영 DB 변경: 없음
- 역사적 전제: 필요한 SQL을 작업 시점마다 증분 적용했으며, 목표 상태 전체를 담은 단일 원본은 없었음
- 결과물 성격: 누적 운영 상태를 고정한 합성·통합 bootstrap v2 + PGlite 및 실제 Supabase shadow replay

## 결론

현재 운영 스키마와 원격 79개 migration의 정방향 DDL을 대조해, 첫 원격 migration 직전에 필요했던 17개 public 테이블과 Stage 6N7 필수 RPC를 `reconstructed_pre_stage6n7_bootstrap.sql`에 통합했다. 운영에 존재하지만 후속 원격 이력에는 생성문이 없는 초기 수동 RPC 2개도 운영 본문과 ACL을 읽기 전용으로 확인해 추가했다. 이는 과거의 단일 원본 파일을 복원한 것이 아니라, 여러 차례 수동 적용으로 형성된 시점 상태를 재생 가능한 하나의 bootstrap으로 합성한 것이다.

핵심 역산은 비교적 명확하다. 원격 체인에서 이 17개 기존 테이블의 컬럼을 변경하는 파일은 `20260814130058_p1_p2_account_security.sql`뿐이다. 따라서 현재 운영 정의에서 그 파일이 추가한 다음 항목을 제거하면 첫 migration 직전의 테이블 열 경계가 나온다.

- `byeollog_signup_applications`: `provisioning_state`, `setup_email_sent_at`, `setup_email_last_attempt_at`, `setup_email_last_error`, `setup_email_attempts`, `status_token_issued_at`
- `bangsel_collector_logs`: `workspace_id`, `device_id`, `retained_until`
- 같은 migration이 새로 만든 FK, check, 인덱스와 collector log의 `workspace_id NOT NULL`

첫 원격 migration은 `byeollog_withdraw_account(uuid,uuid)`를 생성한다. 그래서 재구성 bootstrap에는 이 함수를 넣지 않았다. 그 다음 Stage 6N7 baseline이 요구하는 나머지 세 함수와 17개 테이블·RLS는 bootstrap에 포함했다.

## 증거와 신뢰도

| 항목 | 판정 | 신뢰도 | 근거 |
|---|---|---:|---|
| 17개 테이블 존재와 RLS | 재구성 반영 | 높음 | Stage 6N7 baseline의 명시적 검증 목록과 운영 `pg_class` |
| 테이블 열·타입·null·default | 재구성 반영 | 높음 | 운영 `pg_attribute`/`pg_attrdef`에서 추출 후 Stage 6N8 추가 열을 역제거 |
| PK, check, FK | 재구성 반영 | 높음 | 운영 `pg_constraint`; Stage 6N8가 교체한 항목은 별도 역산 |
| `auth_user_id`의 이전 delete 동작 | `ON DELETE CASCADE`로 추정 | 중간 | Stage 6N8 주석이 “신청서가 함께 사라지지 않도록 SET NULL로 바꾼다”고 명시 |
| 인덱스 | 재구성 반영 | 중간 | 운영 `pg_indexes`; Stage 6N8와 후속 이력에서 명시적으로 만드는 인덱스는 역제거 |
| updated-at 트리거 4개 | 재구성 반영 | 중간~높음 | 운영 trigger/function 정의와 원격 체인의 기존 테이블 비변경 확인 |
| 공개 RPC 본문 | 현재 본문을 반영 | 중간~높음 | 운영 `pg_get_functiondef`; 원격 체인에는 본문 교체가 없고 보안 속성만 후속 변경 |
| 공개 RPC `SECURITY DEFINER` | 역산 반영 | 높음 | Stage 6N8 설명과 `20260823011107`이 명시적으로 `SECURITY INVOKER`로 변경 |
| ACL | 최소 경계로 재구성 | 중간 | 현재 ACL과 Stage 6N8/후속 grant·revoke 이력; 당시 누적 ACL을 만든 개별 SQL 원문은 모두 보존되지 않음 |
| 주석과 과거에 삭제된 객체 | 미복원 가능 | 낮음/불명 | 현재 카탈로그와 정방향 migration만으로는 삭제 전 원문을 증명할 수 없음 |

## 재생 경계

합성 bootstrap의 완료 상태는 다음 조건을 만족하도록 설계했다.

- 17개 baseline 테이블이 모두 존재한다.
- 17개 테이블에 RLS가 켜져 있다.
- `get_public_bangsel(text,text)`의 반환형이 `TABLE(fan text, event text, type text, remaining integer, comment text)`다.
- `get_public_workspace(text)`의 반환형이 `TABLE(slug text, display_name text, public_page_enabled boolean)`다.
- `byeollog_approve_signup_application(uuid,uuid)`가 존재한다.
- `byeollog_withdraw_account(uuid,uuid)`는 bootstrap에는 없고 첫 원격 migration이 만든다.
- Stage 6N8가 추가할 9개 열은 bootstrap에 미리 들어 있지 않다.
- 후속 `20260823011107_harden_public_rpc_and_rls.sql`가 생성하는 명시적 deny policy는 bootstrap에 미리 만들지 않는다.

## shadow replay 결과

PGlite 0.5.8의 인메모리 PostgreSQL 엔진에 Supabase 역할·Auth·Vault 최소 prelude를 만들고 다음을 순차 적용했다.

1. 합성 bootstrap
2. 보존된 원격 migration 79개
3. exact G3A canary shadow fixture
4. 원격 이력에서 누락된 dormant seal 제거 전환
5. 시간상 선행했지만 dormant/local에만 보존된 migration 5개
6. promotion이 후속 번호의 컬럼을 먼저 참조하는 순서 역전 1건의 선적용

결과는 `PASS 80/80`이다. 원격 79개만 재생하는 strict 모드는 7번째 단계 `20260819165539_offsl_g3a_rc2_compat_surface.sql`에서 `G3A_COMPAT03: exact canary membership is unavailable`로 실패한다. 즉, 원격 보존본만으로는 깨끗한 DB 재생 체인이 아니다.

PGlite 재생 결과와 운영 읽기 전용 카탈로그의 비교 가능한 객체 지문은 정확히 일치했다.

| 객체 | 개수 | MD5 fingerprint |
|---|---:|---|
| tables | 68 | `291d87736bd45d8c2ecabedc9d05553d` |
| columns | 735 | `8435cd9107ca6b22c1c2eb5e5a82e8dc` |
| functions | 158 | `ca4e373d303bf4e56c9a1713014b7211` |
| indexes | 216 | `6223079b579adca12865c0f9ce143627` |
| policies | 67 | `8cc25d0d4b673c33724dc9602f7699ee` |
| triggers | 17 | `af58b15b1ee49f7a9340b1665e1d19db` |

함수 비교에서는 Supabase 플랫폼 event trigger용 `public.rls_auto_enable()`만 양쪽 비교에서 제외했다. PGlite가 `information_schema.table_constraints`를 중복 노출해 제약조건 전체 fingerprint는 신뢰 가능한 비교 대상에서 제외했다. 다만 모든 후속 DDL과 검증 migration이 끝까지 통과했으므로 참조되는 제약·열·타입의 실행 가능성은 확인됐다.

## 실제 Supabase 로컬 재생 결과

2026-08-31에 Podman Engine 6.0.2와 Supabase CLI 2.116.0을 사용해 운영과 같은 PostgreSQL 17.6 기반의 빈 로컬 스택을 구성했다. 합성 bootstrap, 원격 79개, canary fixture, 누락된 dormant/local 전환, 최종 shadow ACL 정렬을 89개 migration으로 배치하고 `supabase db reset --local`을 수행한 결과 전부 통과했다.

실제 PostgreSQL 카탈로그에서 relations, columns, constraints, function metadata/ACL, indexes, policies, relation ACL, triggers, types의 개수와 정렬 fingerprint가 운영 읽기 전용 조회와 정확히 일치했다. `pg_cron`, `pg_net`, `pgcrypto`, `supabase_vault` 버전과 heartbeat cron job도 일치했다. 함수 원문 158개 중 bootstrap 9개는 공백·대소문자·말미 세미콜론·명시적 `ASC` 같은 저장 텍스트 차이만 남았고, 함수 metadata와 ACL 및 후속 함수 149개의 원문은 일치했다.

Auth signup/session/user, Storage bucket/object 왕복, service-role DB 트랜잭션, 주요 HTTP health, Supabase security/performance advisor, 서버 298개 테스트, 에이전트 634개 assertion과 Release build까지 통과했다. Vector 로그 수집기만 Podman의 named-pipe API와 컨테이너의 Docker TCP API 기대가 맞지 않아 unhealthy이며, 안전하지 않은 무인증 `0.0.0.0:2375` 노출은 하지 않았다. 자세한 수치와 제한은 `FULL_SUPABASE_REPLAY_AUDIT_20260831_KO.md`에 고정했다.

## 현재 검증 상태

통과:

- 운영 카탈로그 읽기 전용 추출
- 기존 17개 테이블에 대한 원격 DDL 변경점 전수 검색
- Stage 6N7/6N8 경계 역산
- bootstrap의 173개 열과 운영 열에서 Stage 6N8 추가분을 뺀 173개 열의 대칭 차집합 0건
- bootstrap 정적 경계 검사
- reference migration 79개 존재와 첫 네 파일 순서 검사
- PGlite 0.5.8에서 보충 이력 포함 80단계 전체 재생
- 운영과 tables, columns, functions, indexes, policies, triggers의 개수 및 fingerprint 일치
- 원격 reference-only 체인의 최초 실패 재현
- PostgreSQL 17.6/Supabase 로컬에서 89개 migration 전체 재생
- 제약조건과 객체·함수·관계 ACL을 포함한 운영 카탈로그 fingerprint 일치
- 실제 `pg_cron`/`pg_net` 확장 버전과 heartbeat cron job 일치
- Auth·Storage·주요 HTTP health와 service-role DB smoke test
- 서버 `298/298`, 에이전트 `634 assertions`, 에이전트 Release build 경고·오류 0
- Supabase security/performance advisor 이슈 0

확인된 제한/후속 검토:

- Vector analytics 로그 수집기는 Podman named pipe와 Docker TCP endpoint 불일치로 unhealthy다. DB/Auth/Storage/REST/Edge/Studio 검증에는 영향을 주지 않았지만 로그 ingestion은 미검증이다.
- DB lint의 오류 2건은 이미 후속 버전으로 대체되고 공개 ACL이 회수된 내부 함수 `save_guided_rule_v5_impl`, `save_guided_rule_v6_impl`의 모호한 `rule_id` 참조다. 역분석 범위를 넘어 임의 수정하지 않았다.
- 합성 기준선의 canonical migration 승격은 별도 검토와 승인 사항이다.

## 다음 안전 절차

1. 운영 DB는 계속 읽기 전용으로 유지한다.
2. 재검증이 필요하면 `shadow-replay/replay.mjs`와 `FULL_SUPABASE_REPLAY_AUDIT_20260831_KO.md`의 resolved-history 순서를 새 임시 Supabase workdir에 옮긴다.
3. `supabase db reset --local`과 카탈로그 비교를 다시 수행한다.
4. Vector 로그 ingestion이 필수인 경우에만 인증·접근 제한이 있는 Podman API 연결 방식을 별도로 설계한다.
5. 무차이와 테스트 통과 후 별도 검토를 거쳐 canonical 체인 승격 여부를 결정한다.

연결된 운영 프로젝트에서 `db reset`, `migration repair`, `db push`를 실행하는 것은 이 검증 절차가 아니다.
