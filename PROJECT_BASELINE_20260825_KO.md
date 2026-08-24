# 별록 개발 기준선 — 2026-08-25

## 1. 권위 소스

| 영역 | 디렉터리 | 버전 |
|---|---|---|
| Windows Agent | `BYEOLLOG_AGENT_DEV_v07022` | `0.7.0.71` |
| Web/Vercel/Supabase | `BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX` | package `0.6.3-g3a.40`, build `0.6.3.56-g3a-collection-health-visibility` |

폴더명보다 코드에 선언된 버전을 우선합니다. 다른 Agent DEV 폴더와 서버 checkpoint는 회귀 비교·복구 증거로만 사용합니다.

## 2. 마지막 확인된 운영 배포

- Vercel project: `observer_abangseladmin`
- Production deployment: `dpl_4itAANkC16WveGtQviErqJxNRU6J`
- Production aliases: `byeollog.com`, `www.byeollog.com`
- Supabase project: `offslvwaugvjotkywlus`
- Edge Functions: `agent-runtime-g3a v8`, `event-runtime-g3a v5`, `execution-worker-g3a v2`
- Agent update release sequence: `7071`
- Agent package: `byeollog_agent_v07071_COLLECTION_HEALTH_VISIBILITY_WIN_X64.zip`

## 3. v0.7.0.71 무결성

| 대상 | SHA-256 |
|---|---|
| release ZIP | `24bcd58baa2c738a2426a8aa576a1e4a65dab9ab5fc1594492de788e18c5820a` |
| Agent EXE | `2b78a6112f7452e9f7729673ce418bd9af6c86789ee19f769c4bc2723372f187` |
| inner manifest | `ba6b194187435def2bace91808348e7116edc96f47a661e1d8d498b341d41f03` |
| signed feed | `ed84c2edf61a2fcf67b5804445d7b17c82690af0f70fac2711d5e1a572d9dfc1` |

상세 배포 증거는 `PUBLIC_RELEASE_READINESS_REPORT_20260825_KO.md`에 보존되어 있습니다.

## 4. 추적하지 않는 항목

- 루트의 `.tmp*`, 대용량 VOD, 실험 음성, 과거 `RELEASE_*`
- Agent의 `bin`, `obj`, `artifacts`, `DIST`, `publish_*`
- Server의 `node_modules`, `.vercel`, `.env*`, 임시 검증 파일
- 자동 업데이트 release ZIP과 설치 실행 파일
- PFX/PEM/KEY/DPAPI 등 인증·비밀 자료

이는 삭제 정책이 아니라 Git 추적 경계입니다. 기존 증거는 그대로 보존합니다.

## 5. 이번 공개배포 준비 범위

- Agent heartbeat와 실제 방송 수집 건강도 분리
- 늦게 수신되어 실행하지 않은 이벤트의 사용자 가시성
- rollout/action 기록 시간과 의미 명확화
- 무료 보안 통제, CI/회귀 게이트, 빌드 경고 정비
- Preview 검증 후 동일 산출물 Production 승격

이번 범위에서 제외한 항목:

- TTS 상시 호스팅 전환
- 유료 Supabase 기능
- 백그라운드 업데이트 알림과 구버전 자동 정리
- 실제 사용자가 없는 다중 구버전 설치 환경 회귀 테스트
