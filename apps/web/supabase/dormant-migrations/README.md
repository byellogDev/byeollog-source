# Dormant Supabase migrations

이 디렉터리는 설계와 격리 검증이 끝났지만 운영 적용 승인을 받지 않은 SQL을 보존한다.

- `supabase db push`의 migration history 입력으로 사용하지 않는다.
- 이 디렉터리의 SQL을 운영 DB에 직접 실행하지 않는다.
- 기능 승인을 받은 뒤에는 최신 운영 스키마를 다시 검토하고, 충돌하지 않는 새 timestamp로 `supabase/migrations`에 복원한다.
- 복원한 migration은 격리 PostgreSQL 행동 검증과 운영 migration history 확인을 다시 통과해야 한다.

현재 `20260825110000_native_roulette_sdk_skeleton.sql`은 SOOP Chat SDK 승인과 Agent/WebP/TTS 배포 게이트를 기다리는 별록 네이티브 룰렛 뼈대다. 뒤의 활성 migration을 일반 배포해도 이 SQL은 자동 적용되지 않는다.

`20260828160441_add_soop_oauth_connections.sql`은 애플리케이션 계층에서 암호화된 SOOP 토큰만 저장한다. `SOOP_OAUTH_ENABLED=false`인 동안 적용하지 않으며, OAuth 실연결 승인 시 새 운영 timestamp로 복원한다.
