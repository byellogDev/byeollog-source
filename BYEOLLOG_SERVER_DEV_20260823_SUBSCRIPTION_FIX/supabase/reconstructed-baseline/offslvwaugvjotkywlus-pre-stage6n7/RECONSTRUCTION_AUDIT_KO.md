# Stage 6N7 이전 Supabase 스키마 역분석 감사

- 작성일: 2026-08-31 (Asia/Seoul)
- 대상 프로젝트: `offslvwaugvjotkywlus`
- 목표 시점: `20260814121415_p0_withdraw_transaction.sql` 적용 직전
- 운영 DB 변경: 없음
- 결과물 성격: 원본이 아닌 재구성 후보 v1

## 결론

현재 운영 스키마와 원격 79개 migration의 정방향 DDL을 대조해, 첫 원격 migration 직전에 필요했던 17개 public 테이블과 Stage 6N7 필수 RPC를 `reconstructed_pre_stage6n7_bootstrap.sql`에 재구성했다.

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
| ACL | 최소 경계로 재구성 | 중간 | 현재 ACL과 Stage 6N8/후속 grant·revoke 이력; 원래의 전체 ACL 원문은 미회수 |
| 주석과 과거에 삭제된 객체 | 미복원 가능 | 낮음/불명 | 현재 카탈로그와 정방향 migration만으로는 삭제 전 원문을 증명할 수 없음 |

## 재생 경계

후보 bootstrap의 완료 상태는 다음 조건을 만족하도록 설계했다.

- 17개 baseline 테이블이 모두 존재한다.
- 17개 테이블에 RLS가 켜져 있다.
- `get_public_bangsel(text,text)`의 반환형이 `TABLE(fan text, event text, type text, remaining integer, comment text)`다.
- `get_public_workspace(text)`의 반환형이 `TABLE(slug text, display_name text, public_page_enabled boolean)`다.
- `byeollog_approve_signup_application(uuid,uuid)`가 존재한다.
- `byeollog_withdraw_account(uuid,uuid)`는 bootstrap에는 없고 첫 원격 migration이 만든다.
- Stage 6N8가 추가할 9개 열은 bootstrap에 미리 들어 있지 않다.
- 후속 `20260823011107_harden_public_rpc_and_rls.sql`가 생성하는 명시적 deny policy는 bootstrap에 미리 만들지 않는다.

## 현재 검증 상태

통과:

- 운영 카탈로그 읽기 전용 추출
- 기존 17개 테이블에 대한 원격 DDL 변경점 전수 검색
- Stage 6N7/6N8 경계 역산
- bootstrap의 173개 열과 운영 열에서 Stage 6N8 추가분을 뺀 173개 열의 대칭 차집합 0건
- bootstrap 정적 경계 검사
- reference migration 79개 존재와 첫 네 파일 순서 검사

미완료:

- 실제 PostgreSQL parser/engine에서 bootstrap 단독 실행
- 빈 로컬 Supabase에서 bootstrap + 원격 79개 전체 재생
- 재생 결과와 운영 스키마의 구조 diff
- RPC/RLS/권한/트리거/인덱스 동작 및 애플리케이션 smoke test

현재 호스트에서는 Docker 실행 파일을 찾지 못했고, `npx supabase`도 sandbox 밖 npm cache 접근이 막혀 로컬 shadow DB 검증을 실행하지 못했다. 이 제약 때문에 이 파일은 아직 canonical migration이 아니다.

## 다음 안전 절차

1. Docker와 Supabase CLI가 사용 가능한 격리 환경을 준비한다.
2. 새 임시 Supabase workdir의 첫 migration으로 이 bootstrap의 복사본을 둔다.
3. 그 뒤에 reference 79개를 원격 버전 그대로 배치한다.
4. `supabase db reset --local`로 빈 DB 전체 재생을 수행한다.
5. 운영 DB는 계속 읽기 전용으로 유지한 채 schema-only dump를 얻어 최종 구조 diff를 만든다.
6. 차이가 있으면 bootstrap만 수정하고 같은 과정을 반복한다.
7. 무차이와 테스트 통과 후 별도 검토를 거쳐 canonical 체인 승격 여부를 결정한다.

연결된 운영 프로젝트에서 `db reset`, `migration repair`, `db push`를 실행하는 것은 이 검증 절차가 아니다.
