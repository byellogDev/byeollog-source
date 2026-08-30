# Stage 6N7 이전 스키마 역분석 후보

이 디렉터리는 운영 Supabase 프로젝트 `offslvwaugvjotkywlus`의 현재 카탈로그와 원격 79개 migration을 역대조해 만든 **재구성본**이다. 원본 `bangsel_v8_3_supabase_setup.sql`을 회수한 것이 아니다.

## 파일

- `reconstructed_pre_stage6n7_bootstrap.sql` — 첫 원격 migration 직전 상태를 만드는 후보 bootstrap
- `RECONSTRUCTION_AUDIT_KO.md` — 역산 근거, 확정/추정 항목, 남은 검증
- `verify_reconstructed_baseline.ps1` — 구조·경계·reference 연결을 검사하는 읽기 전용 정적 검증기
- `RECONSTRUCTED_SHA256SUMS.txt` — 줄바꿈을 LF로 고정한 SQL·Markdown 결과물의 SHA-256 목록

## 적용 순서

격리된 빈 로컬 Supabase에서만 아래 순서로 재생한다.

1. 이 bootstrap
2. `reference-migrations/offslvwaugvjotkywlus-20260830/migrations`의 79개 SQL을 파일명 순서대로 전부 적용
3. 최종 스키마를 운영의 읽기 전용 dump와 비교
4. 함수, RLS, 권한, 트리거, 인덱스와 애플리케이션 smoke test 확인

이 파일을 현재 활성 `supabase/migrations`에 복사하거나, 연결된 운영 프로젝트에 적용하거나, 운영에서 `db reset`을 실행하면 안 된다. 빈 DB 전체 재생과 최종 diff가 통과하기 전에는 canonical migration으로 승격하지 않는다.

정적 검증:

```powershell
pwsh -File .\supabase\reconstructed-baseline\offslvwaugvjotkywlus-pre-stage6n7\verify_reconstructed_baseline.ps1
```
