# 별록 개발 기준선 — 2026-08-25

## 1. 권위 소스

| 영역 | 디렉터리 | 버전 |
|---|---|---|
| Windows Agent | `BYEOLLOG_AGENT_DEV_v07022` | `0.7.0.81` |
| Web/Vercel/Supabase | `BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX` | package `0.6.3-g3a.47`, build `0.6.3.66-g3a-winner-preview-voice-sync` |

폴더명보다 코드에 선언된 버전을 우선합니다. 다른 Agent DEV 폴더와 서버 checkpoint는 회귀 비교·복구 증거로만 사용합니다.

## 2. 마지막 확인된 운영 배포

- Vercel project: `observer_abangseladmin`
- Production deployment: `dpl_8oKN5Fa9KLCMQkuZkrgZETKpnKQj`
- Production aliases: `byeollog.com`, `www.byeollog.com`
- Supabase project: `offslvwaugvjotkywlus`
- Edge Functions: `agent-runtime-g3a v11`, `event-runtime-g3a v7`, `execution-worker-g3a v3`
- Agent update release sequence: `7081`
- Agent package: `byeollog_agent_v07081_WINNER_PREVIEW_VOICE_SYNC_WIN_X64.zip`

## 3. v0.7.0.81 무결성

| 대상 | SHA-256 |
|---|---|
| release ZIP | `bb96f4954d0350894e54a0f784ecdd28e12e77e8d51b02274e9da8e119de25d9` |
| Agent EXE | `d32bd0e4eac6209365596b507366a39b6eac7ce09d7313a054f9d069cfc9cd53` |
| inner manifest | `f40f2c0b8b58f4373667486a1b361bfa458f1b897d64f54190ae75eb8b46b733` |
| signed feed | `6d3ca47415dcf14d1a9c6d76f960c18eff9426329357bafde827b3d90a6a448a` |

다음 대화용 최신 운영 증거는 `PROJECT_HANDOFF_20260825_NEXT_CHAT`에 있습니다. `PUBLIC_RELEASE_READINESS_REPORT_20260825_KO.md`는 v71 당시의 역사 기록으로 보존합니다.

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
- 추첨 Browser Source 음성, 오프라인 fallback, 섬광탄과 설정창 미리듣기
- SOOP Developers callback 수신 준비

이번 범위에서 제외한 항목:

- TTS 상시 호스팅 전환
- 유료 Supabase 기능
- 백그라운드 업데이트 알림과 구버전 자동 정리
- 실제 사용자가 없는 다중 구버전 설치 환경 회귀 테스트
