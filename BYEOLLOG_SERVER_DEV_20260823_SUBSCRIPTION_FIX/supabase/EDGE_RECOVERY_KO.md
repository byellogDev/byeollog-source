# 운영 Edge Function 복구 기준

이 폴더의 `functions/`는 2026-08-23에 운영 프로젝트 `offslvwaugvjotkywlus`에서 읽기 전용으로 회수한 활성 번들의 정확한 소스입니다. 파일별 SHA-256과 배포 번들 정보는 `LIVE_EDGE_SOURCE_MANIFEST.json`에 기록했습니다.

- `agent-runtime/index.ts` → 운영 slug `agent-runtime-g3a`, v4, `verify_jwt=true`
- `event-runtime/index.ts` → 운영 slug `event-runtime-g3a`, v2, `verify_jwt=true`
- `execution-worker/index.ts` → 운영 slug `execution-worker-g3a`, v1, `verify_jwt=true`

소스 폴더명과 운영 slug가 다르므로 폴더명만으로 배포하지 마세요. 재배포 전에는 매니페스트 해시, 운영 프로젝트 ref, 정확한 slug, `verify_jwt=true`, runtime revision, release gate, 적용된 migration을 모두 다시 확인해야 합니다. 이 체크포인트 생성 과정에서는 운영 Edge Function을 변경하거나 재배포하지 않았습니다.
