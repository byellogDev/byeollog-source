# 별록 v0.7.0.2 — offsl vNext 통합 마이그레이션 계획

## 0. 문서 상태와 안전 경계

- 상태: **v0.7.0.2 로컬 production-candidate 설계 문서 / 운영 미배포**
- 대상: 별록 Web 운영 프로젝트(`offsl`)와 별도 vNext 개발 프로젝트(`qfj`)의 인증·워크스페이스·자동화 런타임 통합
- 이 문서는 실행 스크립트가 아니다. v0.7.0.2 소스 준비와 이 문서 작성·검토 과정에서 운영 Supabase, Vercel, Auth 사용자, Storage 또는 qfj 프로젝트를 변경하지 않았다.
- 아래 단계는 운영 책임자의 명시적 승인, 복구 가능한 백업, 별도 clone 검증을 모두 통과한 뒤에만 실행할 수 있다.

### 즉시 금지 사항

1. qfj의 migration 파일을 offsl 운영 DB에 그대로 `db push`하거나 SQL Editor에서 일괄 실행하지 않는다.
2. qfj 또는 offsl의 `auth.users`를 생성·삭제·덮어쓰기·UUID 변경하지 않는다.
3. 비밀번호, 비밀번호 해시, access token, refresh token, service-role key, Collector token을 프로젝트 사이에 복사하지 않는다.
4. 이메일·slug·표시 이름만으로 사용자 또는 workspace를 자동 결합하지 않는다.
5. 운영 DB의 기존 테이블·함수·정책·Storage 객체를 drop, truncate, rename 또는 overwrite하지 않는다.
6. qfj의 규칙·실행·기기·이미지 데이터를 이관 완료 즉시 삭제하지 않는다.
7. workspace가 둘 이상인 계정에서 첫 번째 행을 임의 선택하지 않는다.

## 1. 결론

권장 구조는 **offsl 단일 인증·데이터 경계**다.

- offsl의 Supabase Auth와 `public.byeollog_workspaces` / `public.byeollog_workspace_members`를 계정·workspace의 유일한 정본으로 유지한다.
- vNext가 요구하는 `public.workspaces` / `public.workspace_members`는 offsl 정본과 **동일 UUID**를 사용하는 제한형 mirror로 둔다.
- vNext Edge Functions, PostgREST, Storage, 토큰 갱신은 모두 offsl 프로젝트 안에서 처리한다.
- qfj는 migration 설계와 기존 개발 데이터의 출처이며, cutover 이후에도 승인된 보존 기간 동안 읽기 전용 rollback 근거로 남긴다.

서로 다른 Supabase 프로젝트의 사용자 JWT는 상호 호환되지 않는다. offsl에서 발급한 `automation_session`을 qfj URL로 보내는 방식은 허용하지 않는다.

## 2. 절대 보존 계약

### 2.1 기존 별록·Collector 계약

다음 항목은 통합 때문에 바뀌면 안 된다.

- 실행 파일 이름 `byeollog.exe`
- .NET namespace `HurogiCollector`
- 사용자 상태 루트 `%LocalAppData%\ByeollogAgent` (기존 `HurogiCollector`는 첫 실행 때 검증 복사)
- 기존 설치 루트와 바로가기·mutex·activate event 호환
- `device_token`, `collector_version`, `local_agent` wire 값
- `/api/collector`, `/api/collector-pair`, `/api/collector-log` 계약
- v0.5.1.8의 PascalCase/camelCase 업로드 envelope 호환
- 기존 Collector 기기 토큰과 선택적으로 유지 중인 `COLLECTOR_TOKEN`
- `bangsel_*`, `byeollog_collector_*`, 세션·규칙·업로드 완료 데이터

### 2.2 계정·workspace 계약

- offsl `auth.users.id`가 사용자 식별자의 정본이다.
- offsl `byeollog_workspaces.id`가 workspace 식별자의 정본이다.
- offsl 계정 이메일·비밀번호·세션·identity를 qfj 값으로 교체하지 않는다.
- 기존 workspace slug, 표시 이름, 상태, owner 및 membership을 보존한다.
- qfj의 개발자 role을 근거로 offsl 권한을 올리지 않는다.

### 2.3 vNext 데이터 계약

이관 대상으로 승인된 데이터는 다음 식별자를 유지한다.

- 규칙 ID, `version_series_id`, `version_number`, `supersedes_rule_id`, `superseded_at`
- 이벤트 ID와 `(workspace_id, source, external_event_id)` 중복 방지 계약
- rule match, execution ID, action snapshot, attempt 번호와 감사 이력
- Agent `device_id`, secret hash, secret revision과 회전 이력
- overlay asset ID, key/version, SHA-256, MIME, 크기, object path와 실제 바이트
- builtin `mic_off` ID `27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc`
- builtin `mic_off` SHA-256 `e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b`
- builtin 표시 시간 3/5/10/30/60초

충돌이나 불명확한 매핑이 있으면 merge·overwrite하지 않고 해당 이관을 중단한다.

## 3. 정본과 exact-ID mirror

### 3.1 workspace mirror

vNext의 `public.workspaces`는 독립된 workspace 생성 시스템으로 사용하지 않는다.

- `public.workspaces.id`는 대응하는 `public.byeollog_workspaces.id`와 정확히 같아야 한다.
- 통합 migration은 `public.workspaces.id`에서 `public.byeollog_workspaces.id`로 `ON DELETE CASCADE` FK를 추가한다.
- slug/name은 각각 `byeollog_workspaces.slug` / `display_name`에서 동기화한다.
- 기존 offsl 값이 vNext 길이·문자 제약에 맞지 않으면 원본을 고치지 말고 migration을 중단해 별도 승인을 받는다.
- inactive workspace의 자동화 접근은 제거하되 자동화 데이터 자체를 삭제하지 않는다.

### 3.2 membership mirror와 role mapping

허용 mapping은 다음과 같다.

| offsl role | vNext role | 자동화 관리 |
|---|---|---|
| `owner` | `owner` | 허용 |
| `manager` | `admin` | 허용 |
| `viewer` | `viewer` | 읽기 전용 |

- 알 수 없는 role은 자동 승격하지 않는다. 사전 검증 단계에서는 오류로 처리한다.
- mirror의 `user_id`는 동일 offsl `auth.users.id`를 사용한다.
- 가입 승인, role 변경, workspace 비활성화·재활성화, membership 삭제가 같은 트랜잭션 안에서 mirror에 반영되도록 제한형 trigger를 사용한다.
- trigger 함수는 고정 `search_path`, 최소 권한, 원문 값 검증을 사용하며 일반 사용자에게 직접 실행 권한을 주지 않는다.

### 3.3 다중 workspace fail-closed

- 클라이언트가 workspace UUID 또는 승인된 slug를 명시하면 그 계정의 active membership인지 서버에서 재검증한다.
- 명시값이 없고 active workspace가 정확히 하나이면 그 workspace를 선택할 수 있다.
- active workspace가 0개이면 `workspace_not_found`, 2개 이상이면 `workspace_selection_required`로 실패한다.
- 정렬 없는 `rows[0]`, 마지막 로그인 workspace 추정, 이메일/slug 유사도 선택을 금지한다.
- 선택된 workspace UUID 하나가 Collector device 등록, `automation_session`, RLS, Agent 등록과 이벤트 전송 전체에 동일하게 사용돼야 한다.

## 4. qfj migration 사용 원칙

qfj 소스에는 202608150001부터 20260817083000까지 **23개** canonical migration이 있다. 이 파일들은 qfj 개발 스키마의 진화 과정과 최종 객체 정의를 재현하는 **clone schema reference**일 뿐, offsl 운영 배포물이 아니다.

### 4.1 raw production push 금지 사유

- 여러 파일이 DEV candidate 또는 DEV-only로 표시되어 있다.
- `20260815010832_agent_device_registration_secret.sql`에는 단일 DEV binding에 사용할 고정 token hash를 90일 enrollment로 삽입하는 shared enrollment seed가 있다.
- 일부 중간 migration은 당시 qfj 데이터 모양을 추론하여 backfill한다.
- offsl에는 별도의 계정 탈퇴, workspace, Collector, 업보 스키마가 이미 존재한다.
- 최종 privacy boundary와 초기 grant가 한 파일에 모여 있지 않아 부분 적용 시 과도한 권한이 남을 수 있다.

### 4.2 production migration 생성 규칙

1. 비운영 Supabase clone에서 23개 파일을 순서대로 replay해 qfj 최종 스키마를 재현한다.
2. qfj read-only verifier와 schema diff를 실행한다.
3. 최종 객체 정의를 기준으로 offsl 전용 production migration을 새로 만든다.
4. DEV shared enrollment seed와 qfj 단일 workspace 추론 backfill을 제거한다.
5. 사용자 세션 기반 Agent 등록을 기본으로 하고 shared enrollment token은 배포하지 않는다.
6. offsl 정본 mirror, role mapping, 탈퇴 연동, privacy revoke를 별도 명시 migration으로 둔다.
7. 모든 migration은 clone에서 빈 DB 적용과 offsl snapshot 기반 적용을 각각 검증한다.

## 5. 최소 스키마 범위

### 5.1 public 테이블

- `workspaces`
- `workspace_members`
- `events`
- `rules`
- `rule_conditions`
- `rule_actions`
- `rule_matches`
- `executions`
- `execution_attempts`
- `overlay_assets`
- `overlay_asset_durations`

### 5.2 private 테이블

현재 Agent 런타임 최소 범위:

- `private.agent_devices`
- `private.agent_device_enrollments` — 과거 1회용 token 호환용이며 신규 shared token 배포는 금지
- `private.agent_device_session_enrollments`
- `private.agent_overlay_asset_readiness`
- `private.overlay_asset_objects`

전체 운영 기능까지 포함할 경우:

- `private.overlay_asset_publish_jobs`
- `private.account_deletion_requests`

### 5.3 Storage

- private bucket `byeollog-overlay-assets`
- 최대 객체 크기 10 MiB
- 허용 MIME: SVG, PNG, WebP, GIF
- catalog SHA-256과 결정적 object path가 일치하는 객체만 허용
- client에 service key를 제공하지 않는다.

## 6. RLS·RPC·Edge·Storage 검증 계약

### 6.1 RLS와 table privilege

- 모든 public 자동화 테이블에 RLS가 활성화되어야 한다.
- 사용자는 자신의 active workspace membership 범위만 읽을 수 있어야 한다.
- `workspace_members` 조회는 현재 사용자 자신의 membership 한 행만 반환해야 한다.
- 규칙 변경은 `owner/admin`만 가능하며 viewer는 모든 mutation이 거절되어야 한다.
- `events`, `rule_matches`, `executions`, `execution_attempts`의 원문 직접 SELECT를 authenticated에서 제거하고 표시용 `list_automation_activity_v1`만 허용한다.
- `private.*` 테이블은 anon/authenticated에 deny-all이고 service role만 필요한 작업을 수행한다.
- 다른 workspace UUID를 요청한 모든 GET/RPC/Edge 호출은 0행 또는 403으로 끝나야 한다.

### 6.2 client-facing RPC

다음 계약의 정확한 signature, grant, 결과 필드를 확인한다.

- `save_guided_rule_v4`
- `set_guided_rule_enabled_v1`
- `list_agent_devices_v1`
- `rename_agent_device_v1`
- `revoke_agent_device_v1`
- `list_agent_overlay_asset_readiness_v1`
- `list_automation_activity_v1`

### 6.3 service-only RPC

- active Auth session 확인
- 최근 사용자 세션 기반 Agent 등록
- 과거 enrollment token 방식의 제한형 호환
- Agent device 검증과 secret rotation
- device status, overlay manifest와 execution asset 조회
- queue claim, lease renew, ACK/finish와 attempt fencing

모든 service-only RPC는 public/anon/authenticated 실행 권한을 회수하고 service role만 허용한다.

### 6.4 Edge Functions

최소 배포:

- `event-runtime`
- `agent-runtime`

완전한 queue/관리 운영:

- `execution-worker`
- `overlay-asset-admin`

검증 항목:

- `verify_jwt = true`
- runtime의 `SUPABASE_URL`과 secret이 모두 offsl 프로젝트 소속
- JWT `/auth/v1/user`와 `auth.sessions` 재검증
- body 크기, UUID, action type, workspace membership 검증
- 로그에 JWT, refresh token, device secret, 사용자 payload 원문 미출력
- qfj 개발 probe는 offsl에서 비활성

### 6.5 업보 adapter 관문

`event-runtime`의 `upbo.apply` / `upbo.invalidate`는 다음 service-only RPC에 의존한다.

- `byeollog_apply_upbo_ws`
- `byeollog_void_upbo_ws`

현재 qfj의 `upbo_action_adapter_candidate.sql`은 canonical production migration이 아니다. offsl의 `bangsel_fans`, `bangsel_tasks`, `bangsel_task_import_items`, `bangsel_collector_staging`, `bangsel_roulette_invalidations` 실제 제약과 대조하고 transaction rollback 테스트를 통과한 뒤에만 승격한다. 승격 전에는 업보 action rule을 활성화하지 않는다.

## 7. qfj 데이터 이관과 UUID mapping

### 7.1 mapping manifest

운영 책임자가 검토·승인한 명시적 manifest를 만든다.

필수 필드:

- qfj workspace UUID
- offsl `byeollog_workspaces` UUID
- offsl workspace slug와 상태 — 사람이 확인하기 위한 참고값이며 자동 매핑 키가 아님
- 승인자, 승인 시각, mapping revision
- qfj user UUID와 대응 offsl user UUID — 필요한 감사·기기 created_by 변환용
- 매핑 가능/불가 상태와 사유

workspace UUID는 one-to-one unique여야 한다. 이메일과 slug가 같다는 이유만으로 manifest를 자동 생성하지 않는다.

### 7.2 사용자·인증 데이터

- qfj `auth.users` 행과 비밀번호 해시는 이관하지 않는다.
- qfj refresh/access token과 `auth.sessions`를 이관하지 않는다.
- qfj-only 사용자를 offsl에 자동 생성하지 않는다.
- qfj Auth session UUID는 이력값일 뿐 offsl active session으로 인정하지 않는다.
- mapping할 수 없는 사용자의 데이터는 qfj 보존본에 남기고 offsl에서 활성 권한을 부여하지 않는다.

### 7.3 데이터 copy 순서

승인된 workspace만 다음 순서로 복사한다.

1. overlay catalog와 durations — builtin 충돌은 전체 필드 exact match일 때만 허용
2. workspace/membership mirror — offsl 정본에서 생성
3. Agent device와 승인된 created_by mapping
4. rules와 version chain
5. rule conditions/actions
6. events와 rule matches
7. executions와 execution attempts
8. device readiness와 overlay object metadata
9. Storage 객체 bytes

모든 primary key와 관계 ID를 유지하고 workspace UUID만 승인된 manifest로 변환한다. insert 전에 목적지 ID·unique key 충돌을 전수 검사하며 충돌 시 작업을 중단한다.

### 7.4 queue 정합성

- 최종 delta 전에 qfj의 `running`, `pending`, `retry_scheduled` execution을 확인한다.
- lease가 살아 있는 작업을 두 프로젝트에 동시에 복사·실행하지 않는다.
- 실행을 강제 성공·삭제·재시도하지 않는다.
- queue가 0이 되지 않으면 운영자가 각 execution의 처리·보류 방식을 승인할 때까지 cutover를 중단한다.

## 8. 계정 탈퇴·상태 변경 통합

기존 offsl `byeollog_withdraw_account`는 vNext private device와 rule을 알지 못한다. 통합 전 다음을 보강하고 transaction 테스트해야 한다.

- owner workspace 삭제 시 `byeollog_workspaces` 삭제가 exact-ID mirror와 모든 vNext child를 cascade한다.
- non-owner 사용자 삭제 시 그 사용자가 생성한 active Agent device를 먼저 revoke한다.
- 해당 device에 연결된 current local-agent rule을 먼저 disable한다.
- 그 뒤 Auth user 삭제로 `created_by`를 null 처리하되 active orphan device가 남지 않게 한다.
- 일부 단계가 실패하면 계정·workspace·자동화 상태 전체가 rollback돼야 한다.
- membership role/status trigger와 account withdrawal이 교착·부분 적용되지 않는지 검증한다.

## 9. server·client 변경 경계

### 9.1 server

- `/api/collector-pair`는 offsl에서 발급한 `automation_session`만 반환한다.
- 응답에 `automation_project_ref` 또는 동등한 명시적 프로젝트 식별값을 포함한다.
- refresh token을 로그·APM·감사 metadata에 기록하지 않는다.
- 구 v0.5.1.8은 추가 필드를 무시하고 기존 `device_token`을 계속 사용한다.
- 다중 workspace는 3.3의 fail-closed 규칙을 따른다.

### 9.2 client

- automation URL과 publishable key를 같은 offsl 프로젝트로 변경한다.
- pair 응답의 프로젝트 ref와 JWT issuer가 compile-time offsl 값과 정확히 일치하는지 확인한다.
- `/auth/v1/user`와 workspace membership을 확인한 뒤에만 세션을 publish한다.
- 검증 실패 시 기존 수집 로그인은 유지하고 자동화만 비활성화한다.
- 다른 프로젝트로 동일 비밀번호를 다시 보내는 fallback은 제거한다.
- automation refresh token은 현재 실행 메모리에만 유지하고 자동연결용으로 저장하지 않는다.

## 10. 실행 전 승인·백업 관문

아래 항목 중 하나라도 완료되지 않으면 작업을 시작하지 않는다.

### G0 — 책임자 승인

- [ ] migration SQL diff 승인
- [ ] UUID mapping manifest 승인
- [ ] 개인정보·보존 범위 승인
- [ ] 점검 시간과 rollback 책임자 승인

### G1 — 복구 자료

- [ ] offsl DB 논리 백업과 복구 시험
- [ ] qfj DB 읽기 전용 snapshot
- [ ] qfj Storage object manifest, 크기·SHA-256 및 bytes 백업
- [ ] 현재 Vercel production deployment ID/alias와 환경변수 목록
- [ ] 현재 client 설치본과 SHA-256
- [ ] migration 전 테이블별 row count·FK orphan·RLS/grant 보고서

백업은 존재 여부만 확인하지 말고 별도 clone에서 실제 restore와 핵심 조회를 성공시켜야 한다.

### G2 — clone 검증

- [ ] qfj 23 migration 순차 replay
- [ ] DEV seed 제거 확인
- [ ] offsl snapshot + production migration 적용
- [ ] migration 재실행 안전성 또는 migration history 단일 적용 보장
- [ ] rollback SQL이 사용자 데이터를 drop하지 않음

### G3 — 보안·호환 검증

- [ ] owner/admin/viewer positive·negative RLS 테스트
- [ ] 다른 workspace 접근 0행/403
- [ ] service-only RPC의 public/anon/authenticated 실행 거부
- [ ] Edge JWT issuer/session/membership 검증
- [ ] Storage 비공개·MIME·크기·SHA·경로 검증
- [ ] v0.5.1.8 pair/upload/log/dashboard handoff 회귀
- [ ] legacy global token 사용 환경이면 `COLLECTOR_TOKEN` 회귀
- [ ] offsl endpoint/key로 새로 봉인한 v0.7.0.2 client의 single login, token refresh, exact workspace, rule/device/event/ACK E2E

## 11. 배포 순서

### Phase 1 — 무트래픽 준비

1. offsl clone에 production migration을 적용한다.
2. verifier, schema diff, RLS negative tests를 통과시킨다.
3. 운영 offsl에 적용할 SQL과 예상 row 변화량을 승인받는다.
4. 운영 백업과 rollback 지점을 다시 확인한다.

### Phase 2 — additive DB·Edge 준비

1. 승인된 additive migration을 offsl에 적용한다.
2. workspace/membership mirror row 수와 exact UUID를 확인한다.
3. Edge Functions를 배포하되 client traffic은 보내지 않는다.
4. disposable workspace·계정으로 rule, Agent, event, queue, overlay를 검증한다.
5. 기존 Web/Collector API의 오류율과 DB lock을 확인한다.

### Phase 3 — qfj data와 최종 delta

1. 승인된 qfj snapshot을 staging schema 또는 검증 도구에 적재한다.
2. mapping·충돌·FK·hash를 검증한다.
3. qfj queue를 quiesce하고 살아 있는 lease가 없는지 확인한다.
4. final delta를 exact-ID로 복사한다.
5. source/destination row count와 결정적 hash를 비교한다.

### Phase 4 — server-first canary

1. offsl 세션을 반환하는 서버를 preview에 배포한다.
2. disposable 기기명으로 v0.5.1.8과 v0.6.3.2를 검증한다. 기존 운영 PC 이름으로 pair하면 기존 device token이 revoke될 수 있으므로 금지한다.
3. 서버를 운영에 먼저 승격한다.
4. 구버전 pair/upload/log와 서버 401/403/429/5xx를 감시한다.
5. automation response body가 로그·분석 도구에 저장되지 않는지 확인한다.

### Phase 5 — client-second canary

1. offsl endpoint/key가 들어간 새 승인 버전(v0.7.0.2)을 소수 tester에게 배포한다. 이미 봉인한 v0.6.3.2 바이트를 같은 버전으로 바꿔 재게시하지 않는다.
2. single login, workspace, refresh, rule CRUD, Agent 등록·회전·status, event→claim→ACK, 재시작을 확인한다.
3. 401/403, cross-workspace, execution 중복, queue 적체, Storage 실패를 감시한다.
4. 관찰 기간을 통과한 뒤에만 배포 범위를 확대한다.

## 12. rollback

### 12.1 client rollback

- 신규 client 배포를 중단하고 이전 승인 EXE로 되돌린다.
- `%LocalAppData%\ByeollogAgent`를 삭제하거나 초기화하지 않는다. 기존 `HurogiCollector` 보존본도 롤백 완료 전에는 삭제하지 않는다.
- `vnext_agent_credentials.json`, `vnext_agent.sqlite`, overlay cache를 보존한다.

### 12.2 server rollback

- Vercel alias를 직전 production deployment로 되돌린다.
- 구버전 Collector API와 device token은 계속 유효해야 한다.
- server rollback 후 신규 client가 잘못된 프로젝트 세션을 채택하지 않게 project-ref 검증을 유지한다.

### 12.3 DB rollback

- 적용된 additive 테이블·컬럼·함수·정책을 즉시 drop하지 않는다.
- 신규 traffic만 feature flag 또는 서버/client rollback으로 차단한다.
- qfj snapshot과 offsl 이관 데이터를 비교해 원인을 확인한다.
- 데이터 제거가 필요하면 별도 파괴 작업 계획과 운영 책임자 승인을 새로 받는다.

### 12.4 qfj 보존

- qfj는 최소 승인된 rollback 기간 동안 변경 없이 유지한다.
- old vNext client traffic이 0이고 offsl 데이터·기능·백업이 검증되기 전에는 qfj를 정지·삭제하지 않는다.
- 보존 기간 종료 후에도 사용자·DB·Storage 삭제는 이 문서 범위 밖의 별도 승인 작업이다.

## 13. 완료 판정

다음 조건을 모두 만족해야 migration 완료로 판정한다.

- offsl Auth 사용자와 `byeollog_workspaces.id`가 automation 정본으로 동작한다.
- mirror workspace/membership이 exact-ID와 role mapping을 지킨다.
- v0.5.1.8 Collector 계약이 그대로 통과한다.
- 새 승인 client(v0.7.0.2)가 한 번의 일반 별록 로그인으로 offsl automation session을 사용한다.
- 다른 workspace 접근과 viewer mutation이 차단된다.
- Agent device와 queue가 중복 실행 없이 event→claim→ACK를 완료한다.
- overlay bytes가 catalog SHA-256과 일치한다.
- qfj source와 offsl destination의 승인된 데이터 count/hash가 일치한다.
- rollback 절차를 실제 canary 환경에서 수행해 상태 파일과 계정이 보존된다.
- 운영 로그와 배포 산출물에 password, access/refresh token, device secret, service key가 없다.

## 14. 최종 권고

offsl 이관을 완료하기 전에는 현재 서버의 offsl `automation_session`을 qfj 전용 클라이언트가 채택하도록 운영 배포하지 않는다. 스키마·Auth·workspace·Edge·Storage가 모두 offsl에 준비되고 project-ref 검증을 포함한 새 승인 client(v0.7.0.2) canary가 통과한 뒤에만 자동화 기능을 활성화한다.
