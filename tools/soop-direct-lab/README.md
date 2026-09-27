# SDK 없는 SOOP 직접 연결 후보

2026-09-28: 기존 수집 내용 비교는 사용자 수락 완료. 이후 작업은 [운영 전환 준비](../../docs/research/2026-09-28-direct-production-readiness.md)를 따른다. 별도 `handoff-probe.mjs`/`handoff-probe-entry.mjs`와 `delivery-candidate.mjs`는 연결 교체·내구성 전송을 검증하는 **미배포 후보**이며 현재 bundle에 포함하지 않는다. `node --test tests/soop-direct-handoff.test.mjs`로 실제 로컬 WebSocket·암호화 임시 큐 검사 18건을 실행한다. 새 토큰은 승인된 감독 파이프에서 읽고 후보가 직접 갱신하지 않는다. 실행 입력·중단 조건·남은 통합은 위 절차에 명시한다.

연구용 수신기다. 운영 gateway에서 import하지 않으며 DB·outbox·자격증명 갱신 기능이 없다. 기존 공식 SDK의 OAuth 접속 절차와 패킷 입출력을 확인하여 Node/ws로 구현했다. Meloming/Rogi Go 소스는 반입하지 않았으며 공식 지원 SDK라고 표시하지 않는다.

```powershell
node --test tools/soop-direct-lab/cdp-frames.test.mjs tools/soop-direct-lab/cdp-scope.test.mjs tools/soop-direct-lab/client.test.mjs tools/soop-direct-lab/sdk-parity.test.mjs
python -B tools/soop-direct-lab/soak-controller.test.py
python -B tools/soop-browserless-lab/soak-compare.test.py
```

기존 `ws@8.21.0`과 Node 22를 사용한다. SDK 대조 검사는 기존 prepare 도구가 비공개 `.local`에 받은 해시 고정 SDK를 읽는다. 파일이 없으면 실패하며 건너뛰지 않는다. 후보 bundle에는 SDK가 포함되지 않는다. 자동 검사는 합성 데이터·루프백 소켓만 사용한다.

실제 CDP 계약 검사는 `CHROMIUM_BINARY`, `PYTHON_BINARY`(cryptography 설치) 환경 변수를 지정하고 `node tools/soop-direct-lab/cdp-scope.integration.mjs`로 실행한다. 별도 임시 Chrome 프로필·임시 인증서·TLS 루프백 서버만 사용하며 SOOP에 접속하지 않는다. 테스트 내부의 인증서 확인 생략은 루프백 가짜 서버에만 사용하고 실제 후보 TLS 설정에는 적용하지 않는다.

## 경계

- 계정별 컨테이너 256 MiB, CPU 0.25, PIDs 32, UID 65534, 읽기 전용 파일시스템, 운영 볼륨·DB 키 없음.
- OAuth chatinfo POST 목적지 고정, redirect 금지, 응답 64 KiB 제한, 반환 계정 확인, 공식 SOOP 호스트와 TLS 사용.
- 로그인·입장·SOOP keepalive와 WebSocket close만 발신. 채팅 발신 API, 쿠키 로그인, 자동 토큰 갱신 없음.
- 성공한 login ACK → 해당 방의 join ACK 뒤 ready. 방 불일치·손상 패킷·인증 거부·크기 초과는 중단.
- 10초 입장·쓰기 시한, 60초 SOOP keepalive. 180초 무수신은 `idle_unconfirmed`로 기록하며 그것만으로 종료하지 않는다. 쓰기 완료는 상대 연결 정상의 증거가 아니다. 명시적 close/error, 쓰기 실패·시한·버퍼 상한, 감독기의 양쪽 수신 비교로 별도 판정한다.
- 연결마다 새 인스턴스. 감독 파이프 소실·시한 도달 시 소켓·타이머 회수.
- 원문 채팅·후원자·금액·토큰은 관측 파일에 기록하지 않는다. 계정별 임의 키 HMAC과 횟수로 대조한다.
- 콘텐츠 코드 5/18/26/33/86/87/103/105/107/109/121/125를 대조한다. 미션 정산·합계는 새 후원으로 변환하지 않는다. 운영 분류기가 처리하지 않는 나머지 코드는 제한된 집계로 남긴다.
- SDK 전체 표시 속성·raw hash 동등성을 주장하지 않는다. 향후 운영 통합에서는 전송 경로별 진단 hash와 업무 멱등키 계약을 검토해야 한다.

## 감독 실행

2026-09-26 사용자 결정: 관측 캠페인은 `stopPolicy: user_declared`, `endEpoch: null`로 실행하며 사용자가 관측완료를 선언할 때까지 고정 시각으로 종료하지 않는다. 개별 세션은 기존 최대 48시간·OAuth 만료 범위로 제한하고 정상 종료 후 다음 세션을 관측한다. 방송 대기·재개는 계정별 독립이다. 오류·불일치·자원·증거 용량 안전 중단은 유지하며 무조건 재시작하지 않는다. 검증 집계는 사용자 요청 때 수행하고 취소한 예약 자동화를 재개하지 않는다.

`build-bundle.mjs`가 adapter, 기존 감독 entry, 새 monitor/controller, 고정 ws를 묶고 해시를 계산한다. 계정 ID·실행 receipt·집계는 비공개 `.local/soop-direct-lab`에 둔다.

기존 Chromium의 CDP 관측에서는 text/binary 메시지만 SOOP 파서로 전달한다. ping/pong/close 프레임은 데이터 비교 대상이 아니며 실제 socket close 이벤트의 중단은 유지한다. 손상된 데이터는 계속 중단하고 opcode·길이·고정 파서 오류 코드만 기록한다. 원문·requestId·임의 예외 메시지는 저장하지 않는다. [수정·실행 검증](../../docs/releases/2026-09-26-monitor-control-frames.md).

세 승인 계정은 각각 기존 연결 안정과 소유자를 확인한 뒤 독립적으로 연결한다. 계정별 60초 이상 공존·프레임 1개 일치는 초기 대조 이정표이며 다른 계정의 시작을 막지 않는다. 방송 대기는 실제 연결 시간에 포함하지 않는다.

방송 종료 신호도 최대 180초 동안 신선한 기존 경로의 `waiting_for_live/broadcast_offline`과 독립 대조한 뒤에만 다음 방송을 기다린다. 그 외 오류는 해당 계정 중단 후 검토한다. 안전 중단을 자동으로 우회하지 않는다.

2026-09-27: 14바이트 빈 본문 지원, 계정 URL이 확인된 단일 소켓으로 CDP requestId 고정, 양쪽 숫자 헤더 진단 및 준비 전 오류 회수를 추가했다. 원문은 보관하지 않는다. [수정·배포·검증 한계](../../docs/releases/2026-09-27-broadcast-observation-fix.md).

[진행 기록](../../docs/research/2026-09-23-direct-soak.md)

## 레퍼런스 적용 범위

Meloming/Rogi의 직접 연결·연결 관리자 분리·제한된 자원·입장 확인 구조를 검토했다. 기존 OAuth와 후원 분류는 별록 SDK 계약으로 검증한다. 외부 소스 반입은 없다. [비교 기록](../../docs/research/2026-09-23-collector-reference-comparison.md).

Meloming은 180초 읽기 시한 뒤 관리자가 연결을 회수하고 재대조·재연결한다. 연구 후보는 실패 증거를 보존하기 위해 오류 시 `needs_review`로 멈춘다. 따라서 자동 복구까지 같은 구조가 아니다. 9월 25일 수정은 정상 유휴 연결의 오종료를 제거하며, 자동 재연결·다중 워커 인계 구현을 포함하지 않는다. [수정과 검증 한계](../../docs/releases/2026-09-25-idle-connection-fix.md).
