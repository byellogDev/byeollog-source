# Supabase 마이그레이션 이력 조정 감사

- 작성일: 2026-08-30 (Asia/Seoul)
- 대상 프로젝트: `offslvwaugvjotkywlus`
- 조사 기준 체크포인트: `a90eca7fe43c2c5f01dbc3cba4b8eb5b836d5443`
- 조사 방식: 로컬 파일, Supabase CLI `2.116.0`, 원격 `supabase_migrations.schema_migrations`, 운영 스키마를 읽기 전용으로 비교
- 운영 DB 변경: 없음

## 결론

현재 로컬 마이그레이션 디렉터리는 운영 DB 이력의 정본이 아니다. 운영 DB에는 79개 버전, 로컬에는 59개 버전이 있으며 버전 번호가 양쪽에서 정확히 일치하는 항목은 14개뿐이다. 따라서 지금 `supabase db push` 또는 일괄 `supabase migration repair`를 실행하면 안 된다.

권장 방향은 **원격 이력을 변경하지 않고, 원격 버전과 원문을 기준으로 로컬 정본 체인을 새로 구성하는 것**이다. 그 뒤 빈 shadow DB에서 전체 재생을 검증하고, 마지막에만 `db push --dry-run`으로 무변경임을 확인한다.

## 조사 결과

| 구분 | 개수 | 판정 |
|---|---:|---|
| 로컬 활성 마이그레이션 | 59 | 현재 디렉터리 기준 |
| 원격 기록 마이그레이션 | 79 | 운영 `schema_migrations` 기준 |
| 버전 번호 정확히 일치 | 14 | CLI에서 양쪽 열이 같은 항목 |
| 이름은 같고 버전만 다름 | 38 | 이 중 35개는 정규화 SQL도 동일 |
| 로컬에만 있는 이름 | 7 | 아래에서 3개는 원격의 다른 이름과 SQL 동일 |
| 원격에만 있는 이름 | 27 | 초기 기준선 24개와 교차 이름 3개 |

### 같은 이름·다른 버전 38개

35개는 공백과 줄바꿈을 정규화한 SQL 해시가 동일했다. 내용 차이가 확인된 세 항목은 다음과 같다.

| 로컬 | 원격 | 차이와 처리 원칙 |
|---|---|---|
| `20260823162319_restore_collector_rule_read_access` | `20260823162627_restore_collector_rule_read_access` | 실행 SQL은 같고 로컬 설명 주석만 다르다. 원격 버전/원문을 정본으로 사용한다. |
| `20260824160000_add_missing_raffle_sealed_at` | `20260824051310_add_missing_raffle_sealed_at` | 원격은 컬럼 추가만, 로컬은 설명 주석과 `COMMENT ON COLUMN`이 추가됐다. 메타데이터가 필요하면 과거 파일을 수정하지 말고 새 forward migration으로 추가한다. |
| `20260824173931_add_flashbang_action` | `20260824175316_add_flashbang_action` | 로컬은 `5000 ms/120000 ms`, 원격 최초 적용본은 `3000 ms/150000 ms`다. 후속 `fix_flashbang_timeout_contract` 등이 최종 계약을 `5000/120000`으로 고쳤으므로 최초 파일은 원격 원문으로 복원하고 후속 수정 이력은 유지한다. |

### 이름은 다르지만 SQL이 같은 세 항목

| 로컬 | 원격 정본 |
|---|---|
| `20260825120000_add_voice_anonymize_action` | `20260825064819_add_voice_anonymize_action_20260825` |
| `20260828231500_add_native_roulette_overlay_layout` | `20260828235253_add_generic_overlay_part_layout_and_preview` |
| `20260828234000_add_roulette_result_overlay_part` | `20260829004057_add_roulette_result_overlay_part_and_zero_scale` |

세 항목 모두 정규화 SQL 해시가 정확히 일치하므로 원격 버전과 이름을 정본으로 채택한다.

### 로컬 전용으로 남은 네 항목

| 로컬 파일 | 운영 상태 | 판정 |
|---|---|---|
| `20260824130000_add_raffle_winner_tts_gateway` | 대상 RPC가 존재하고, 후속 `restore_raffle_winner_tts_gateway`의 `raffle_winner_voice_key_v1` 구현이 활성화돼 있다. `service_role`만 실행 가능하다. | 후속 이력으로 대체됨. 그대로 push하지 않는다. |
| `20260828173951_soop_gateway_readiness_observability` | 네 개의 관측 테이블이 모두 존재하며 RLS 활성, `anon/authenticated` 조회 불가, `service_role` 조회 가능 상태다. | 스키마에는 반영됐지만 원격 이력과 대응하는 단일 기록이 없다. 재생 체인에서 별도 검증이 필요하다. |
| `20260829193604_add_live_roulette_followup_card` | `claim_native_roulette_overlay_v3`가 존재하고 `event_occurred_at` 반환 계약이 살아 있다. | 후속 공통 오버레이 재구축에 흡수된 것으로 판정한다. 그대로 push하지 않는다. |
| `20260829200648_keep_followup_chat_open_during_series` | 최신 `ingest_native_roulette_soop_chat_v2`가 닉네임 상관관계, 3초 시리즈 grace, `event_occurred_at` 계약을 포함한다. | 후속 재구축/상관관계 마이그레이션에 흡수됐다. 그대로 push하지 않는다. |

두 함수는 이후 마이그레이션에서 다시 정의됐기 때문에 로컬 전용 과거 파일을 새 마이그레이션처럼 적용하면 최신 구현을 과거 구현으로 되돌릴 수 있다.

### 원격 전용 초기 기준선

원격에는 `20260814121415`부터 `20260820052931`까지 24개 초기 마이그레이션이 있고 로컬에는 없다. 이들은 `migration fetch` 또는 원격 이력의 `statements` 내보내기로 별도 임시 디렉터리에 확보해야 한다. 현재 로컬 파일을 곧바로 덮어쓰면 안 된다.

## 안전한 조정 절차

1. 현재 `supabase/migrations`를 변경하지 않은 채 원격 79개 버전과 `name`, `statements`를 별도 임시/reference 디렉터리에 내보낸다.
2. 원격 버전/이름/원문을 기준으로 새 canonical 체인을 만든다. 35개 동일 SQL과 교차 이름 3개는 원격 식별자로 맞춘다.
3. 세 개의 SQL 차이 항목은 위 표의 원칙으로 처리한다. 특히 `add_flashbang_action`의 최초 원격 값과 후속 수정 이력을 모두 보존한다.
4. 관측 테이블 생성 이력이 원격 체인에서 빠져 있는지 확인한다. 빠져 있다면 운영 이력을 임의로 고치지 말고, 별도의 재현 가능한 baseline 전략을 설계한다.
5. 새 빈 shadow DB에서 원격 기준선부터 마지막 마이그레이션까지 전부 재생한다. 함수 시그니처, RLS, 권한, 트리거, 인덱스와 최종 계약을 검사한다.
6. `supabase migration list --linked`에서 원격 79개가 모두 로컬과 같은 버전에 놓이고 로컬 전용 행이 0개인지 확인한다.
7. 그 뒤에만 `supabase db push --linked --dry-run`을 실행한다. 예상 SQL이 한 줄이라도 나오면 실제 push를 중단하고 다시 조사한다.
8. dry-run이 무변경이고 애플리케이션 테스트가 통과한 뒤에만 실제 배포 절차를 검토한다.

## 금지 사항

- 현재 상태에서 `supabase db push` 실행 금지
- 여러 버전을 한꺼번에 `supabase migration repair`로 맞추기 금지
- 원격에 이미 적용된 과거 SQL을 로컬에서 편집한 뒤 같은 이력으로 간주하지 않기
- 로컬 전용 네 파일을 신규 변경처럼 운영 DB에 재적용하지 않기
- 원격 초기 24개를 확보하기 전에 기존 로컬 migration 디렉터리를 이동·삭제·덮어쓰기 금지

`migration repair`는 스키마를 바꾸는 도구가 아니라 원격 migration history의 상태를 바꾸는 도구다. 실제 스키마와 파일이 어긋난 상태에서 이를 먼저 사용하면 불일치를 숨길 수 있다.

## 재현 명령

다음 명령은 현황 확인용이다. 첫 두 명령은 읽기 전용이며 마지막 명령은 canonical 체인이 완성되기 전에는 실행하지 않는다.

```powershell
npx supabase@latest --version
npx supabase@latest migration list --linked --output-format json

# canonical 체인 완성 후에만
npx supabase@latest db push --linked --dry-run
```

## 공식 참고자료

- Supabase Database Migrations: https://supabase.com/docs/guides/deployment/database-migrations
- Supabase CLI Reference: https://supabase.com/docs/reference/cli/introduction
- Supabase Changelog: https://supabase.com/changelog

## 다음 인계 작업

다음 담당자는 **원격 이력 export를 별도 디렉터리에 생성하고, 원본 로컬 디렉터리와 diff를 만드는 단계**부터 시작한다. 이 단계까지는 운영 DB 변경이 필요 없다. 실제 파일 이동, 과거 파일 교체, migration repair, DB push는 각각 검증 결과를 보고 별도 승인 후 진행한다.
