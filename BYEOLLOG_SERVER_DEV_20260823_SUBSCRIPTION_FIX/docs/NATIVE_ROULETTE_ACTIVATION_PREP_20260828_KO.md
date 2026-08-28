# 자체 룰렛 활성화 준비 체크포인트

## 범위

SOOP Chat SDK 승인 통보를 2026-08-29 확인했고 **자체 룰렛 활성화 준비만** 수행한다. 이번 체크포인트에서는 운영 DB migration, Agent 업데이트 배포, 기능 플래그 변경, 위플랩 이전·제거를 하지 않는다.

## 승인 직후 OAuth 준비

- SOOP 공식 배포 SDK와 문서에서 `/auth/code`, `/auth/token`, `authorization_code`, `refresh_token` 계약을 대조했다.
- `/api/auth/soop/start`, `/api/auth/soop/callback`, `/api/auth/soop/status` 서버 경로를 준비했다.
- Client Secret은 브라우저·Agent로 전달하지 않고 서버 전용 환경변수에서 토큰 교환에만 사용한다.
- 접근·갱신 토큰은 AES-256-GCM으로 애플리케이션 암호화한 뒤 server-only 테이블에 저장하도록 준비했다.
- 저장 SQL은 `20260828160441_add_soop_oauth_connections.sql` dormant migration이며 운영 DB에 적용하지 않았다.
- `SOOP_OAUTH_ENABLED` 기본 OFF, `SOOP_CHAT_SDK_ENABLED` 및 `NATIVE_ROULETTE_ENABLED`도 계속 OFF다.
- 상세 활성화·롤백 순서는 `docs/SOOP_OAUTH_ACTIVATION_RUNBOOK_20260829_KO.md`를 따른다.

## 이번에 고정한 계약

### 1. 단차·연차 발동

- 웹 초안과 오버레이 실행 설정을 별도 검증한 뒤 활성화 시점에만 결합한다.
- 단차는 설정한 별풍선과 정확히 일치할 때 1회 실행한다.
- 연차를 켠 경우 별도 별풍선 수와 실행 횟수를 정확히 사용한다.
- 예전 `배수 후원` 규칙은 자체 룰렛 v2에 복원하지 않는다.
- 단차·연차 별풍선 수가 같으면 저장을 차단한다.
- 연차 이미지를 지정하지 않으면 단차 사용자 이미지를 사용하고, 단차 사용자 이미지도 없으면 선택한 기본 이미지를 사용한다.

### 2. SOOP SDK 내부 전달 규격

공식 SDK별 필드 이름을 서버가 추측하지 않는다. Agent의 승인 SDK 어댑터가 아래 내부 규격 v1로 명시적으로 변환한다.

- `provider=soop`
- `eventType=donation|chat`
- 제공자 이벤트 ID와 제공자 발생 시각
- 후원자·채팅 작성자의 SOOP ID와 표시명
- 별풍선 수, 후원 메시지 또는 채팅 본문
- 별록 최초 수신 시각
- 연결 ID, 연결 내 증가 순번, 재연결 횟수
- 비식별 원본 payload SHA-256
- 이벤트 내용 fingerprint

동일 이벤트가 재연결 뒤 다시 도착해도 이벤트 내용 fingerprint는 같고, 연결·수신 telemetry만 달라진다. 같은 이벤트 ID에 다른 내용이 들어오면 DB 멱등성 계층에서 충돌로 처리해야 한다.

### 3. 수신 실행 경계

Vercel 함수 한도를 늘리지 않는다. 별도 `native-roulette-runtime` Supabase Edge Function 후보를 사용한다.

- `NATIVE_ROULETTE_ENABLED=true`
- `SOOP_CHAT_SDK_ENABLED=true`
- 유효한 Supabase 사용자 세션
- 활성 automation runtime release
- 워크스페이스에 등록된 Agent 장치 ID와 장치 비밀키
- 내부 relay 규격 검증

위 조건을 모두 통과해야 후원·채팅 RPC를 호출한다. 플래그가 하나라도 꺼져 있으면 존재하지 않는 경로처럼 404를 반환한다.

## 자동 감사

```powershell
npm run audit:roulette-activation
```

`fail`은 준비 코드의 회귀이고 즉시 수정해야 한다. `blocked`는 운영 활성화 전에 실제 외부 자료·자산·Agent 구현으로 닫아야 하는 게이트다. `activationReady=true`가 되기 전에는 활성화 RPC와 운영 플래그를 추가하지 않는다.

## 현재 남은 차단 게이트

1. **승인 SDK 실제 방송 fixture**
   - 공식 배포 SDK에서 `MESSAGE`, `BALLOON_GIFTED` 필드 계약은 확인했다.
   - 실제 방송에서 후원, 일반 채팅, 재연결 재전송 payload를 비식별 JSON으로 보존한다.
   - API Key·Secret·OAuth 토큰·실사용자 ID는 fixture에 넣지 않는다.
   - Client Secret을 다중 사용자 Agent에 노출하지 않는 공식 접속 방식과 실제 재연결 규약은 SOOP 1:1 문의로 확정한다.
2. **3초 immutable 룰렛 자산 7종**
   - 현재 원본은 4.8초 `staged` 상태다.
   - 3초 버전으로 재인코딩하고 실제 OBS 재생 시간, 해시, 바이트 크기를 고정한 뒤 게시한다.
3. **Agent `native_roulette.overlay`**
   - 선택 자산과 결과 TTS 캐시 영수증
   - 3초 오버레이·효과음·캐시 TTS의 원자적 실행
   - ACK 유실·재연결 시 화면과 음성 정확히 1회 보장
   - OBS 브라우저 소스가 실제 presentation을 읽었는지 확인

## DB 활성화 후보에 반영할 사항

예전 dormant skeleton은 워크스페이스당 룰렛 1개와 배수 후원을 전제로 하므로 그대로 운영 migration으로 승격하지 않는다.

- `byeollog_roulette_drafts` 여러 개를 각각 불변 revision으로 승격
- 단차·연차 trigger를 별도 행으로 저장
- 활성 trigger의 `(workspace_id, balloons)` 유일성으로 룰렛 선택 모호성 차단
- 사용자 이미지·기본 이미지 fallback 결과를 revision에 고정
- 선택 Agent와 음량은 overlay control plane snapshot으로 고정
- SDK 원본 hash, 연결 ID·순번·수신 시각을 donation/chat 수신 기록에 보존
- 동일 provider event ID + 동일 내용은 기존 결과 반환
- 동일 provider event ID + 다른 내용은 충돌로 차단
- 암호학적 rejection sampling, outbox lease와 `FOR UPDATE SKIP LOCKED` 유지
- private schema, direct-client deny RLS, service-role RPC 최소 권한 유지

이 DB 후보는 실제 승인 fixture를 고정한 뒤 새 timestamp의 **비활성 activation bundle**로 작성하고 로컬 PostgreSQL harness를 통과시킨다.

## 운영 불변 조건

- 현재 `.vercelignore`의 네이티브 룰렛 제외 규칙 유지
- dormant SQL을 `supabase/migrations`로 이동하지 않음
- Edge Function 배포 없음
- Agent release/업데이트 feed 변경 없음
- 두 기능 플래그 OFF
- 활성화 RPC 없음
- 기존 위플랩·업보·액션 경로 변경 없음
