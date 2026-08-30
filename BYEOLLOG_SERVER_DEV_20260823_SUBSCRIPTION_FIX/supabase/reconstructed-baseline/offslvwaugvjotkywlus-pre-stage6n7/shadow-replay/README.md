# PGlite shadow replay

이 도구는 합성 bootstrap, 보존된 원격 migration 79개, 운영 이력에서 빠진 것으로 확인된 전환 SQL을 **메모리 안의 격리된 PGlite DB**에 재생한다. 운영 Supabase에 연결하거나 쓰지 않는다.

## 실행

Node.js 24 기준:

```powershell
npm ci
npm run replay
```

성공 기준은 `PASS 80/80`과 마지막 JSON의 `status: "PASS"`다. `--strict-reference-only`를 붙이면 누락 전환을 넣지 않은 원격 79개 체인의 첫 실제 실패를 재현할 수 있다.

```powershell
npm run replay -- --strict-reference-only
```

## resolved 모드가 보충하는 이력

- exact G3A canary workspace/operator — 검증 SQL이 고정 UUID를 요구하므로 shadow 전용 fixture를 삽입
- G3A public release 직전 dormant seal 2개 제거 — 운영에는 없지만 보존된 원격 파일에는 제거 이력이 없음
- `20260825110000_native_roulette_sdk_skeleton.sql` — dormant 보존본
- `20260828160441_add_soop_oauth_connections.sql` — dormant 보존본
- `20260828173951_soop_gateway_readiness_observability.sql` — local-only 활성 migration
- `20260829030000_add_ephemeral_soop_roulette_overlay_experiment.sql` — promotion migration보다 뒤 번호라 필요한 시점에 선적용 후 원래 위치에서 멱등 재적용
- `20260829193604_add_live_roulette_followup_card.sql`
- `20260829200648_keep_followup_chat_open_during_series.sql`

PGlite가 `pg_cron`과 `pg_net` 확장을 제공하지 않으므로 이 두 확장의 생성문만 제거하고, migration 파싱·DDL 재생에 필요한 최소 객체를 prelude에서 제공한다. 따라서 이 결과는 전체 Supabase 로컬 스택의 확장 동작, Auth, Realtime, Storage, Edge Functions, 애플리케이션 smoke test를 대신하지 않는다.

PGlite의 `information_schema.table_constraints`가 동일 제약을 중복 노출하는 현상이 있어 제약조건 전체 fingerprint는 비교 대상에서 제외했다. 그 밖의 테이블·열·함수·인덱스·RLS policy·trigger fingerprint는 운영 읽기 전용 카탈로그와 비교한다.
