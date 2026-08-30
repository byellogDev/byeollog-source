# 실제 Supabase 로컬 전체 재생 감사

- 작성일: 2026-08-31 (Asia/Seoul)
- 대상 운영 프로젝트: `offslvwaugvjotkywlus`
- 운영 DB 변경: 없음(카탈로그·설정 읽기만 수행)
- 결론: PostgreSQL 17.6 기반 빈 로컬 Supabase에서 resolved-history 89개 migration 전체 재생 통과

## 환경과 재생 범위

- Podman Desktop 1.29.1, Podman Engine 6.0.2, WSL2 rootless machine `byeollog-supabase`
- Supabase CLI 2.116.0
- 로컬 Supabase Postgres image: `public.ecr.aws/supabase/postgres:17.6.1.165`
- 운영 `server_version`: PostgreSQL 17.6
- Podman machine: 4 CPU, 8192 MiB, 80 GiB, Docker-compatible named pipe 사용

임시 작업공간의 migration 체인은 다음 89개로 구성했다.

1. 합성 pre-Stage6N7 bootstrap 1개
2. 보존된 원격 migration 79개
3. exact G3A canary shadow fixture
4. 누락된 dormant seal 제거 전환
5. dormant native roulette skeleton과 SOOP OAuth
6. local SOOP readiness와 overlay experiment 선적용
7. local follow-up migration 2개
8. 현재 로컬 기본 권한을 운영 ACL과 맞추는 최종 shadow ACL parity 전환

`supabase db reset --local`은 89개를 처음부터 끝까지 적용해 성공했다. 이 체인은 운영 배포용이 아니라 누적 운영 상태를 검증하기 위한 격리 shadow 체인이다.

## 운영 카탈로그 일치

실제 PostgreSQL에서 동일한 정렬·정규화 규칙으로 계산한 로컬/운영 개수와 MD5 fingerprint는 다음과 같다.

| 객체 | 개수 | 로컬 = 운영 fingerprint |
|---|---:|---|
| relations(테이블·뷰·시퀀스 metadata) | 70 | `a60a98d39b8a85b8fec12f826117200c` |
| columns | 735 | `8bde1bbe1df65398a6273db863f6caf6` |
| constraints | 485 | `172d3d09a03c5fe0fcc2f48d58515caa` |
| function metadata | 158 | `d4617eeb18b05f318fc236b2cea04b25` |
| function ACL | 267 | `6d84e5304780f0753977005b35452ecf` |
| indexes | 216 | `6223079b579adca12865c0f9ce143627` |
| policies(roles 포함) | 67 | `03169b99a1d97a66102b477a58251b8f` |
| relation ACL | 806 | `41bff2ee230dcfe042b47810820640c1` |
| triggers | 17 | `af58b15b1ee49f7a9340b1665e1d19db` |
| user-defined types | 0 | `d41d8cd98f00b204e9800998ecf8427e` |

함수 raw definition 전체 fingerprint는 로컬 `180138f263478575a165f62d4bcb429e`, 운영 `7b2c552280bc42275b520a8a9695fc16`으로 다르다. 차이는 bootstrap 함수 9개에만 있고, 6개는 공백·대소문자뿐이다. 나머지 3개도 `bangsel_void_roulette_ws`, `byeollog_bind_workspace_owner`의 말미 세미콜론 유무와 `get_public_bangsel`의 암시적 오름차순 대 명시적 `ASC`뿐이다. 함수 metadata·ACL·실행 의미에는 차이가 없고 후속 함수 149개 raw definition은 정확히 일치한다.

확장도 로컬과 운영이 일치했다.

| extension | version |
|---|---|
| `pg_cron` | 1.6.4 |
| `pg_net` | 0.20.4 |
| `pgcrypto` | 1.3 |
| `supabase_vault` | 0.3.1 |

`byeollog-soop-gateway-heartbeat-monitor-v1` cron job은 양쪽 모두 30초 주기, active, database/user `postgres`였다.

## 기능·애플리케이션 검증

- REST admin ready, Auth health, Storage status, Edge internal health, Studio: HTTP 200
- Auth: signup → session → `/user` 왕복 통과
- Storage: bucket 생성 → object upload/download → object/bucket 정리 통과
- DB: 운영 실제 ACL 모델을 반영한 service-role 트랜잭션 smoke 통과
- anon/authenticated가 public RPC를 직접 실행하지 못하고 service_role만 실행하는 운영 경계 일치
- Supabase security advisor: 이슈 없음
- Supabase performance advisor: 이슈 없음
- PGlite resolved replay: `PASS 80/80`
- 서버 Node 테스트: `298/298 PASS`
- 에이전트 회귀: `634 assertions PASS`
- 에이전트 .NET 8 Release build: 경고 0, 오류 0

## 확인된 제한과 비수정 항목

Vector analytics 로그 수집기만 unhealthy/restarting이다. 컨테이너는 `host.docker.internal:2375`의 Docker TCP API를 기대하지만 이번 Podman 환경은 Windows named pipe를 사용한다. 무인증 API를 `0.0.0.0:2375`로 여는 방식은 안전하지 않아 적용하지 않았다. DB, Auth, Storage, REST, Edge, Studio와 analytics API 자체의 검증에는 영향을 주지 않았지만 Vector 기반 로그 ingestion은 검증하지 못했다.

DB lint에는 이미 대체된 내부 함수 두 개의 오류가 남는다.

- `byeollog_automation.save_guided_rule_v5_impl`: ambiguous `rule_id`
- `byeollog_automation.save_guided_rule_v6_impl`: ambiguous `rule_id`

두 함수는 후속 버전으로 대체됐고 public wrapper 권한도 회수된 역사 객체다. 이번 목표는 현재 운영 구조의 역분석과 재생이므로 함수 본문을 임의 변경하지 않았다. 그 밖에 rollout dashboard/compat 함수의 volatility 경고와 일부 미사용·shadow 변수 경고가 있으나 이번 재생 실패는 아니다.

## 판정

단일 원본 SQL이 없다는 전제에서도 현재 운영 구조는 합성 bootstrap과 보충 이력을 통해 빈 PostgreSQL/Supabase에 재생 가능하다. 제약조건과 ACL까지 운영과 일치하며 주요 플랫폼·애플리케이션 smoke test도 통과했다. 따라서 “스키마 역분석과 재생 가능성 검증” 작업은 완료다.

다만 이 합성 체인은 검증용 shadow 기준선이다. 운영 프로젝트에서 `db reset`, `db push`, `migration repair`를 실행하거나 별도 승인 없이 canonical migration으로 승격하지 않는다.
