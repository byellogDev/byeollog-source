# SOOP 브라우저 없는 수집 실험

> 이 SDK 기반 관측은 종료된 연구 기록입니다. 특히 이 디렉터리의 예전 `soak-monitor.mjs`/`soak-controller.py`는 운영 토큰을 갱신할 수 있는 lease 경로를 사용하므로 실방송 관측에 재실행하지 않습니다. 현재 승인된 관측은 [직접 연결 후보](../soop-direct-lab/README.md)의 읽기 전용 준비 API와 감독기를 사용합니다. 모의 실험과 과거 결과 보존을 위해 소스를 남깁니다.

모의 검증 도구와 제한된 실방송 관측 후보다. `lab.mjs`는 Node 22에서 공식 SDK 원본을 계정별 vm에 로드하고 합성 HTTP 응답과 로컬 WebSocket 서버로 시험한다. 실제 SOOP 500개 접속·DB 처리량 검증이 아니며 vm은 보안 경계가 아니다. `shadow-observer.mjs`의 실방송 시험은 아래와 같이 별도 컨테이너에서 수행한다.

저장소 루트에서 Node 22와 기존 `npm ci` 의존성을 사용한다. 새 의존성이나 `.env` 로드는 없다.

```powershell
node tools/soop-browserless-lab/prepare.mjs
node tools/soop-browserless-lab/lab.mjs functional
node --expose-gc tools/soop-browserless-lab/lab.mjs 50 100 500
node tools/soop-browserless-lab/assignment-lab.mjs
node tools/soop-browserless-lab/outbox-lab.mjs
```

- prepare만 공식 SDK를 다운로드한다. 해시가 달라지면 중단한다. 원본·결과·임시 큐는 Git에서 제외한 `.local/soop-browserless-lab/`에 저장한다. 인증값은 필요하지 않다.
- lab: 실제 SDK 로그인/입장 프레임, 채팅·별풍선 파싱, 계정 격리, 소켓 종료 후 새 realm 생성. 공유 realm·종료된 realm 재사용은 실패를 재현하는 음성 대조군이다. 연결 중에는 계정별 채팅·후원 각 1개를 전송하고 약 100ms 쉰다. 기본 100회이며 단절 중에는 주입하지 않아 재연결 공백의 손실은 검증하지 않는다.
- assignment: 현재 권한 발급 코드에 합성 DB/OAuth를 주입하여 동시 워커 두 개가 모두 권한을 받는지 확인한다. 분산 할당 기능을 구현한 것은 아니다.
- outbox: 현재 암호화 파일 큐의 재개방, 순서, 중복 enqueue 억제, 응답 유실 재시도와 100/500ms 모의 전송 지연을 확인한다. 수신측 중복 방지는 Set으로 모의한다. 실제 DB나 프로세스 강제 종료 검증은 아니다.

강제 GC 없이 500세션·10회 재연결 추가 시험:

```powershell
$env:LAB_ROUNDS='300'
$env:LAB_CYCLES='10'
node --max-old-space-size=2048 tools/soop-browserless-lab/lab.mjs 500
Remove-Item Env:LAB_ROUNDS,Env:LAB_CYCLES
```

CPU·메모리는 모의 서버와 관측 자료구조까지 포함한 로컬 프로세스 값이다. 약 1분 시험으로 장시간 누수·SOOP 연결 허용량을 판정하지 않는다. 장시간 부하 시험을 기본 CI에 추가하지 않았다.

[검증 결과와 한계](../../docs/research/2026-09-23-browserless-soop.md)

## 관측 전용 후보

`shadow-observer.mjs`는 운영 DB·큐·권한 갱신·상태 기록 모듈을 가져오지 않는다. SDK 로그인·입장·keepalive 패킷만 허용하고 채팅 발신·관리 패킷을 차단한다. 요청 계정과 접속 방 소유자가 다르면 중단하며 최대 관측 시간은 120초다. 자동 재연결은 하지 않는다. SDK 원본 해시를 고정하며 결과에는 원문·아이디·인증값 대신 집계와 최대 200개 HMAC 표본만 출력한다. 이 표본 자체로 운영 경로와 일치가 증명되는 것은 아니다.

120초는 기본 CLI 상한이다. 승인된 장기 감독 실행에 한해 `maxDurationMs`를 명시하여 최대 48시간으로 늘릴 수 있다. `soak-entry.mjs`는 감독 연결의 종료·응답 중단을 감시하고, `soak-monitor.mjs`는 기존 방 소유자·연결·수신을 읽기 전용으로 관측한다. `soak-controller.py`는 계정별 컨테이너와 유한 크기 비교 대기열을 관리한다. 방송 종료 외 원인 불명 오류는 점검 전까지 자동 재시도하지 않는다.

장기 도구 검사는 Python 3의 `python -B tools/soop-browserless-lab/soak-compare.test.py`와 위 Node 검사로 실행한다. 실제 대상과 자격증명 전달 제어는 비공개 실행 자료로 분리한다. [48시간 관측 계획·실행 상태](../../docs/research/2026-09-23-shadow-soak.md)를 참고한다.

```powershell
node --test tools/soop-browserless-lab/shadow-observer.test.mjs
```

패킷 제한·접속 목적지·인증 실패·계정 불일치 차단 4개 시험을 통과했다. 승인된 테스트 방송에서 별도 컨테이너와 기존 연결 감시를 함께 실행하여 실제 채팅 2건의 양쪽 수신 프레임 일치를 확인했다. 운영 전환이나 장기 안정성 검증은 아니다. 자격증명을 명령행·환경파일·로그로 남기지 말고, 실행 시 별도 제한 컨테이너의 stdin으로 전달해야 한다. 운영 볼륨을 연결하지 않는다.

실제 SOOP 연결에서는 Node 22.23.2 기본 WebSocket으로 ready에 도달하지 못했다. 같은 환경에서 HTTP Upgrade 101은 확인됐으며, 기존 고정 의존성 `ws@8.21.0`을 `observe`의 `WebSocketImpl`로 주입했을 때 ready와 채팅 수신이 성공했다. 기본 CLI가 이 전송 구현을 자동 선택하는 것은 아니다. 실행 제어기는 비공개 `.local`에 있으며 공식 SDK 원본은 수정하지 않았다.

실행 전 순서:

1. 승인된 테스트 계정의 방송 시작과 기존 수집 연결의 정상 수신을 확인한다.
2. 기존 수집기의 연결/재연결 로그와 최신 상태를 동시에 관측한다. 상태 파일은 15초 주기로 갱신되므로 파일만으로 즉시 감지한다고 주장하지 않는다.
3. 별도 제한 컨테이너에서 관측 후보 하나만 실행한다. 기존 경로에 끊김·재접속이 생기거나 관측 증거가 끊기면 후보를 중단한다.
4. 두 경로의 실제 수신을 확인한다. 동시 연결 성공만으로 후원 누락 없음까지 판정하지 않는다.
5. 테스트 계정 통과 후에만 승인된 실방송 관측으로 진행한다. 실행 결과와 미검증 범위는 연구 문서에 기록한다.
