# Stage 6N7 이전 합성 bootstrap

이 DB는 작업 중 필요한 SQL을 그때그때 추가 적용하며 진화했으므로, 목표 시점 전체를 담은 단일 “원본 스키마 SQL”은 존재하지 않았다. `bangsel_v8_3_supabase_setup.sql`은 초기 단계의 한 SQL일 뿐 완성된 정본이 아니다.

이 디렉터리는 운영 Supabase 프로젝트 `offslvwaugvjotkywlus`의 현재 카탈로그와 원격 79개 migration을 역대조해, 첫 원격 migration 직전의 누적 상태를 한 번에 재생할 수 있도록 만든 **합성·통합 bootstrap 스냅샷**이다. 목적은 존재하지 않는 원본 파일을 복원하는 것이 아니라 누적 운영 상태를 재현 가능한 기준선으로 고정하는 것이다.

## 파일

- `reconstructed_pre_stage6n7_bootstrap.sql` — 첫 원격 migration 직전 누적 상태를 만드는 합성 bootstrap
- `RECONSTRUCTION_AUDIT_KO.md` — 역산 근거, 확정/추정 항목, 남은 검증
- `FULL_SUPABASE_REPLAY_AUDIT_20260831_KO.md` — 실제 PostgreSQL 17.6/Supabase 로컬 스택의 89단계 전체 재생·카탈로그·smoke 감사
- `verify_reconstructed_baseline.ps1` — 구조·경계·reference 연결을 검사하는 읽기 전용 정적 검증기
- `shadow-replay/` — PGlite 0.5.8 기반 80단계 재생 도구, shadow fixture와 누락 전환 SQL
- `RECONSTRUCTED_SHA256SUMS.txt` — 줄바꿈을 LF로 고정한 SQL·Markdown 결과물의 SHA-256 목록

## 적용 순서

격리된 PGlite shadow replay와 실제 PostgreSQL 17.6 기반 Supabase 로컬 전체 재생이 모두 완료됐다. `shadow-replay`에서 `npm ci`, `npm run replay`를 실행하면 합성 bootstrap과 원격 79개가 누락 이력 보충 후 `PASS 80/80`을 반환한다. 원격 보존본만의 실패는 `npm run replay -- --strict-reference-only`로 재현한다.

전체 Supabase 로컬 검증에서는 아래 순서로 89개 migration을 재생했고 `supabase db reset --local`이 통과했다.

1. 이 bootstrap
2. `reference-migrations/offslvwaugvjotkywlus-20260830/migrations`의 79개 SQL을 파일명 순서대로 전부 적용
3. canary fixture, 누락된 dormant/local 전환과 최종 shadow ACL parity 전환 적용
4. 최종 스키마를 운영의 읽기 전용 카탈로그와 비교
5. 함수, RLS, 권한, 트리거, 인덱스, Auth·Storage·HTTP와 애플리케이션 smoke test 확인

이 파일을 현재 활성 `supabase/migrations`에 복사하거나, 연결된 운영 프로젝트에 적용하거나, 운영에서 `db reset`을 실행하면 안 된다. 실제 로컬 전체 재생은 통과했지만, 결과물은 과거에 누락된 수동 이력까지 합성한 shadow 기준선이다. 별도 검토 없이 canonical migration으로 승격하거나 운영에 적용하지 않는다. 세부 증거와 Vector 로그 수집기 제한은 `FULL_SUPABASE_REPLAY_AUDIT_20260831_KO.md`를 따른다.

정적 검증:

```powershell
pwsh -File .\supabase\reconstructed-baseline\offslvwaugvjotkywlus-pre-stage6n7\verify_reconstructed_baseline.ps1
```
