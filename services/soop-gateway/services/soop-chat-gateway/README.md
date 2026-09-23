# Byeollog SOOP Chat Gateway

별록 서버의 OAuth 토큰을 사용해 공식 SOOP Chat SDK 연결을 장시간 유지하는 독립 프로세스입니다. Vercel 요청 함수나 스트리머 Agent 안에 종속되지 않으며, 워크스페이스별 `gateway_enabled`가 켜진 경우에만 연결합니다.

필수 서버 전용 환경변수:

- `SUPABASE_URL`, `SUPABASE_SECRET_KEY`
- `SOOP_CLIENT_ID`, `SOOP_CLIENT_SECRET`, `SOOP_TOKEN_ENCRYPTION_KEY`
- `SOOP_GATEWAY_INGRESS_SECRET`
- 선택: `BYEOLLOG_SOOP_GATEWAY_URL`, `SOOP_GATEWAY_BROWSER`, `SOOP_GATEWAY_STATE_DIR`
- 브라우저 용량: `SOOP_GATEWAY_SESSIONS_PER_SHARD`(기본 16), `SOOP_GATEWAY_RENDERER_PROCESS_LIMIT`(기본 8)

실행:

```powershell
npm run gateway:soop
```

운영에서는 `supervisor.mjs`를 실행합니다. Windows 작업 스케줄러와 Docker 예시는 각각 `tools/Install-SoopGatewayTask.ps1`, `compose.example.yml`에 있습니다.

```powershell
node services/soop-chat-gateway/supervisor.mjs
```

영속 상태 디렉터리에는 감독 상태와 암호화된 미전송 이벤트만 저장됩니다. 네트워크가 끊겨도 이벤트를 먼저 AES-256-GCM으로 저장하고 서버 복구 후 재전송합니다. 컨테이너에서는 반드시 `/var/lib/byeollog`를 영속 볼륨으로 유지해야 합니다.
Docker 실행 전 `.env.gateway.example`을 `.env.gateway`로 복사하고 실제 ingress 비밀키를 입력합니다. 채워진 `.env.gateway`는 소스 관리에 포함하지 않습니다.

기본 안전 조건:

- DB의 `gateway_enabled=false`이면 SDK를 열지 않습니다.
- `native_roulette_enabled=false`이면 이벤트 관측만 가능하며 추첨 RPC는 호출되지 않습니다.
- 액세스·리프레시 토큰, Client Secret, 채팅 원문을 로그에 기록하지 않습니다.
- 방송 종료는 인증 실패와 구분하고 30초 후 다시 확인합니다.
- 일시 연결 오류는 1~30초 지수 백오프로 복구합니다.
- 서버 요청은 본문·시각·nonce를 묶은 HMAC-SHA256 서명을 사용합니다. 정적 bearer 허용은 배포 전환 중에만 `SOOP_GATEWAY_ALLOW_LEGACY_BEARER=true`로 켤 수 있습니다.
- 재시도 가능한 장애는 암호화 outbox에 지수 백오프로 보존하고, 반복되는 영구 4xx 이벤트만 암호화 DLQ로 격리해 뒤 이벤트를 계속 전달합니다.
- pending 100건 이상 또는 DLQ 발생은 `outbox_pressure` 구조화 로그로 경고합니다.
- Node 자식 프로세스는 독립 감독 프로세스가 자동 재시작하며, 감독 프로세스는 OS 또는 컨테이너 정책이 복구합니다.
- `GET /healthz`는 로컬 운영 점검에만 노출합니다. 인터넷에 직접 공개하지 않습니다.
- `SOOP_GATEWAY_CHROME_NO_SANDBOX=true`는 권한 제거·읽기 전용 파일시스템을 적용한 격리 컨테이너 예시에서만 사용합니다.

브라우저 세션은 한 Chromium 프로세스 안에서 기본 16개씩 별도 렌더러 샤드에 배치합니다. 이벤트에는 추측 불가능한 세션 ID가 붙고 서버 측 세션 맵으로 다시 분기되므로 워크스페이스 간 이벤트가 섞이지 않습니다. 한 렌더러 장애의 영향도 해당 샤드로 제한됩니다. 운영에서 다중 세션 샤딩 문제가 의심되면 `.env.gateway`의 `SOOP_GATEWAY_SESSIONS_PER_SHARD=1`로 바꾸고 컨테이너를 재시작해 워크스페이스별 페이지 격리 모드로 즉시 낮출 수 있습니다. 이 설정은 이벤트 전달·저장 경로를 바꾸지 않습니다.
