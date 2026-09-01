# SOOP 실시간 게이트웨이 운영 준비

## 운영 원칙

- OAuth 계정 연결과 게이트웨이 ingress는 서버 비밀키 경계 안에서 동작한다.
- 호스트의 게이트웨이 감독 프로세스는 상시 대기하지만, 워크스페이스별 채팅 세션은 방송 시작 시 자동 연결되고 방송 종료 시 `waiting_for_live`로 돌아간다.
- 사용자가 수집 시작·중지를 직접 조작하는 기능은 제공하지 않는다.
- 자체 룰렛 데이터는 승인 전 격리 계약을 계속 적용하며 업보·통계에 합산하지 않는다.
- Agent·OBS·기존 위플랩 경로는 이 게이트웨이의 시작·종료 수명주기와 분리한다.

## 구성 요소

1. `services/soop-chat-gateway`
   - 공식 SOOP 브라우저 SDK를 headless Chromium에서 실행한다.
   - 워크스페이스마다 Chromium 프로세스를 띄우지 않고, Chromium 1개 안에서 워크스페이스별 격리 탭을 사용한다. 렌더러는 기본 8개로 제한하고 탭 생성은 최대 8개씩만 병렬 처리한다.
   - 브라우저 장애 시 모든 탭은 닫힌 것으로 처리하며, 각 워크스페이스의 기존 재접속 루프가 서로 다른 지연값으로 다시 연결한다. 이 지연 분산은 장애 복구 때 100개 연결이 동시에 몰리는 현상을 막는다.
   - 토큰은 서버 DB에서 갱신하며 로그에 남기지 않는다.
   - 방송 종료는 OAuth 실패와 구분해 세션만 닫고, 30초 간격으로 다음 방송 시작을 확인한다.
   - `handleChatClosed`와 일시 오류는 자동 재접속하며, 19금 여부 같은 방송 정보 변경을 OAuth 해제로 취급하지 않는다.
   - 재연결 중 동일 이벤트 replay만 억제하고, 같은 문장의 정상 반복 채팅은 보존한다.
   - 후원·일반 채팅이 아닌 SDK 패킷과 식별 불가능한 시스템성 메시지는 개인정보 없이 종류·순번·사유만 기록하고 격리한다.
2. `/api/auth/soop/gateway`
   - 32자 이상 서버 비밀키와 워크스페이스별 `gateway_enabled`가 모두 필요하다.
   - raw SDK payload를 저장하지 않고 fingerprint와 단계별 시각만 기록한다.
   - `native_roulette_enabled=false`이면 룰렛 RPC를 호출하지 않는다.
3. 대시보드 `SOOP 실시간 경로`
   - OAuth → 게이트웨이 → SDK 이벤트 → 자체 룰렛 상태를 표시한다.
   - 가상 후원 전체 점검은 최신 룰렛 초안을 검증하고 3초 공개·TTS·액션 순서를 계산할 뿐 실제 실행하지 않는다.
   - 실방송 수신 진단은 다음 실제 이벤트를 관측하면 통과하며 룰렛과 액션을 실행하지 않는다.
4. Windows 호스트 감독
   - `tools/Install-SoopGatewayTask.ps1`가 로그인 작업을 등록하고 즉시 시작한다.
   - `tools/Run-SoopGatewayHidden.ps1`는 단일 인스턴스 mutex를 유지하고 Node 감독 프로세스를 실행한다.
   - Node 감독 프로세스는 SDK 자식 프로세스를 초 단위로 복구하고 `%LOCALAPPDATA%\Byeollog\soop-gateway\supervisor-state.json`에 마지막 종료 코드·신호·PID·부팅 추정 시각을 원자적으로 남긴다.
   - 작업 스케줄러는 감독 프로세스 자체가 종료된 경우 1분 간격으로 최대 999회 재시작하며 배터리 전환 때문에 중단하지 않는다.
   - 로그는 `%LOCALAPPDATA%\Byeollog\logs\soop-gateway.jsonl`에 UTF-8 JSONL로 기록한다.
   - 서버 전송 전 이벤트는 `%LOCALAPPDATA%\Byeollog\soop-gateway\outbox`에 AES-256-GCM으로 암호화 저장하고, 연결 복구 뒤 중복 안전하게 재전송한다.

## 장애 감시와 검증

- Supabase Cron은 30초마다 게이트웨이 세션을 검사하고 하트비트가 45초 넘게 없으면 `byeollog_soop_gateway_incidents`에 장애를 연다. 신호가 돌아오면 같은 장애를 자동 종료한다.
- Vault에 `soop_gateway_alert_webhook_url`을 저장하면 Slack·Discord 호환 본문으로 장애/복구 알림을 보낸다. 선택 비밀 `soop_gateway_alert_webhook_token`이 있으면 Bearer 헤더로 함께 전송한다.
- `tools/Test-SoopGatewayRecovery.ps1`은 기본적으로 무중단 상태만 검사한다. `-IncludeLiveProcessKill`은 실제 자식 프로세스를 종료하므로 방송 중에는 절대 실행하지 않는다.
- `tools/Start-SoopGatewaySoak.ps1 -Hours 24`는 15초 간격으로 감독·자식 PID와 하트비트를 기록하고 `%LOCALAPPDATA%\Byeollog\soak\report.json`에 가동률·최장 중단·재시작 수를 판정한다.

## 중앙 서버 이전

- `services/soop-chat-gateway/compose.example.yml`은 재시작 정책, 영속 전송함 볼륨, 로컬 전용 헬스 포트, 읽기 전용 루트 파일시스템, Linux capability 제거를 포함한다.
- 서버 선정 전에는 이 컨테이너로 실제 SDK 연결 수·메모리·CPU를 24시간 측정한다. 서버 비용이 발생하는 생성 작업은 별도 승인 후 진행한다.
- 중앙 서버로 옮긴 뒤에도 Windows 호스트를 즉시 제거하지 않는다. 새 호스트의 24시간 검증이 끝난 뒤 워크스페이스를 순차 전환한다.

### 리전과 100명 수용 기준

- 1순위는 Oracle Cloud 서울(`ap-seoul-1`), 2순위는 도쿄(`ap-tokyo-1`)다. 둘 다 제공 리전이지만 Always Free A1 인스턴스는 홈 리전의 실제 잔여 용량이 있어야 생성할 수 있다.
- Google Cloud의 상시 무료 `e2-micro`는 미국 리전에만 해당하므로 SOOP 이벤트 반응속도가 중요한 운영 수집기 후보에서 제외한다.
- 개발 PC에서 인증하지 않은 실제 SOOP SDK 화면 100개를 공유 브라우저 하나로 30초 안정화한 결과는 Chromium 프로세스 트리 약 1.0 GiB, 유휴 CPU 약 0.9%/1코어였다. 이는 브라우저 구조의 메모리 가능성을 확인한 값이지, 100개 실방송 연결 인증 결과는 아니다.
- Oracle A1 Always Free의 2 OCPU·12 GiB 범위에서는 100개 연결이 자원상 유력하다. 다만 무료 인스턴스 한 대는 SLA와 이중화가 없으므로, 아래 실연결 승격 조건을 통과하기 전에는 100명 운영을 보장하지 않는다.
- `npm run benchmark:soop-gateway-browser -- 100 30000`으로 토큰 없이 브라우저 기본 비용을 재현할 수 있다.

승격은 서울에서 1 → 10 → 25 → 50 → 100 워크스페이스 순으로 진행하고, 각 단계에서 다음 조건을 모두 만족해야 한다.

1. 24시간 동안 이벤트 유실·중복 실행이 0건이다.
2. SOOP SDK 콜백부터 서버 ingress 수신까지 p95 250ms 이하, p99 500ms 이하를 유지한다.
3. ingress 수신부터 온라인 Agent 깨우기까지 p95 250ms 이하를 유지한다. 두 구간을 합친 후원·액션 전달은 p95 500ms 이하를 목표로 한다.
4. CPU p95 70% 미만, 메모리 70% 미만을 유지하며 outbox 적체가 자동 해소된다.
5. 브라우저 강제 종료 시험 뒤 60초 안에 전체 세션이 복구되고, 복구 중 이미 접수된 이벤트는 outbox로 보존된다.
6. 도쿄는 서울의 무료 용량을 확보하지 못했을 때만 후보로 올리고, 같은 실방송 지연 조건을 통과해야 한다.

## 실제 방송 검증 순서

1. 운영 DB에서 테스터 워크스페이스 하나만 `gateway_enabled=true`로 설정한다.
2. Windows 호스트에서는 사용자 환경변수를 설정하고 `tools/Install-SoopGatewayTask.ps1`을 한 번 실행한다.
3. 대시보드가 `정상 연결`과 `수신 대기`를 표시하는지 확인한다.
4. `실방송 수신 진단 준비`를 누른 뒤 일반 채팅 1건, 후원 1건을 보낸다.
5. provider→gateway, gateway→server 지연과 중복 여부를 확인한다.
6. fixture를 비식별 저장하고 gateway를 다시 OFF로 돌린다.
7. 이 단계에서도 `native_roulette_enabled`와 `NATIVE_ROULETTE_ENABLED`는 변경하지 않는다.

## 장애·롤백

- 워크스페이스의 `gateway_enabled=false`는 해당 계정의 신규 수신만 중지한다. 호스트 감독 작업은 다른 계정을 위해 계속 대기한다.
- ingress 비밀키 노출이 의심되면 Vercel과 gateway host에서 동시에 회전한다.
- heartbeat가 45초 넘게 없으면 DB 장애 레코드와 대시보드 경고가 생성되며, 외부 webhook을 설정한 경우 관리자에게 알린다.
- 재인증 필요 상태는 SOOP refresh가 400/401/403으로 명시적으로 거부된 경우에만 사용한다.
