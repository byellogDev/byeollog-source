# Supabase 원격 migration reference — 2026-08-30

이 디렉터리는 Supabase 프로젝트 `offslvwaugvjotkywlus`의 원격 migration history를 Supabase CLI `2.116.0`의 `migration fetch`로 읽어 온 **비실행 reference**다.

## 안전 경계

- 활성 migration 경로는 `supabase/migrations`다.
- 이 reference는 `supabase/reference-migrations` 아래에 있어 CLI의 활성 migration으로 취급되지 않는다.
- 운영 DB, migration history, 데이터에는 쓰기 작업을 하지 않았다.
- 이 디렉터리를 활성 경로로 복사하거나 `db push`하기 전에 반드시 별도 승인을 받고 shadow DB 검증을 완료한다.

## 검증 결과

- fetched SQL 파일: 79개
- 고유 버전: 79개
- 빈 파일: 0개
- fetch 임시 원본과 SHA-256 불일치: 0개
- 격리된 workdir에서 `migration list --project-ref ...`: 로컬/원격 79개 버전 전부 일치
- 비밀키, API 키, JWT, 자격증명 포함 DB URL 패턴: 발견 없음

`REMOTE_SHA256SUMS.txt`는 79개 SQL 원문의 SHA-256을 기록한다. `LOCAL_TO_REMOTE_COMPARISON.csv`는 현재 활성 59개와 원격 정본의 대응 관계를 기록하고, `REMOTE_ONLY_MIGRATIONS.csv`는 대응되지 않은 원격 초기 24개를 기록한다. `SUMMARY.json`은 분류 개수와 재생 차단 사유를 기계 판독 형식으로 제공한다.

## 비교 분류

| 분류 | 개수 |
|---|---:|
| 버전·이름·SQL 일치 | 10 |
| 버전·이름 일치, 로컬 설명 주석만 추가 | 4 |
| 이름·SQL 일치, timestamp만 다름 | 35 |
| 이름 일치, 로컬 설명 주석만 추가 | 1 |
| 이름 일치, 실제 SQL 차이 | 2 |
| 이름은 다르지만 SQL 일치 | 3 |
| 로컬 전용 또는 후속 이력에 흡수 | 4 |

## 재생 차단 사유

`20260814130048_stage6n7_existing_schema_baseline.sql`은 기존 운영 DB가 수동 SQL로 만들어졌으며 해당 파일은 빈 DB용 bootstrap이 아니라고 명시한다. 저장소에서도 그 이전 전체 bootstrap을 찾지 못했다.

따라서 이 79개 파일만 빈 DB에 적용하는 것은 완전한 재생 검증이 아니다. 먼저 Stage 6N7 이전 스키마의 권위 있는 bootstrap을 복구하거나, 별도의 검증된 기준선 전략을 만들어야 한다.

## 재생성

현재 reference와 활성 migration의 대응표·체크섬은 저장소 루트에서 다음 명령으로 다시 생성할 수 있다.

```powershell
& .\tools\audit_supabase_migration_reference.ps1
```

원격 reference 자체를 다시 fetch할 때는 반드시 별도 임시 Supabase workdir을 사용한다. 활성 `supabase/migrations`에서 `migration fetch`를 실행하지 않는다.
