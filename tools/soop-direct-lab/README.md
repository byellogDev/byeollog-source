# SDK 없는 SOOP 직접 연결 후보

연구용 수신기다. 운영 gateway에서 import하지 않으며 DB·outbox·자격증명 갱신 기능이 없다. 기존 공식 SDK의 OAuth 접속 절차와 패킷 입출력을 확인하여 Node/ws로 구현했다. Meloming/Rogi Go 소스는 반입하지 않았으며 공식 지원 SDK라고 표시하지 않는다.

```powershell
node --test tools/soop-direct-lab/client.test.mjs tools/soop-direct-lab/sdk-parity.test.mjs
```

기존 `ws@8.21.0`과 Node 22를 사용한다. SDK 대조 검사는 기존 prepare 도구가 비공개 `.local`에 받은 해시 고정 SDK를 읽는다. 파일이 없으면 실패하며 건너뛰지 않는다. 후보 bundle에는 SDK가 포함되지 않는다. 자동 검사는 합성 데이터·루프백 소켓만 사용한다.

## 경계

- 계정별 컨테이너 256 MiB, CPU 0.25, PIDs 32, UID 65534, 읽기 전용 파일시스템, 운영 볼륨·DB 키 없음.
- OAuth chatinfo POST 목적지 고정, redirect 금지, 응답 64 KiB 제한, 반환 계정 확인, 공식 SOOP 호스트와 TLS 사용.
- 로그인·입장·keepalive와 WebSocket ping/close만 발신. 채팅 발신 API, 쿠키 로그인, 자동 토큰 갱신 없음.
- 성공한 login ACK → 해당 방의 join ACK 뒤 ready. 방 불일치·손상 패킷·인증 거부·크기 초과는 중단.
- 10초 입장 시한, 60초 keepalive, 180초 통신 무응답 감시. 채팅 없는 방송과 통신 단절 구분.
- 연결마다 새 인스턴스. 감독 파이프 소실·시한 도달 시 소켓·타이머 회수.
- 원문 채팅·후원자·금액·토큰은 관측 파일에 기록하지 않는다. 계정별 임의 키 HMAC과 횟수로 대조한다.
- 콘텐츠 코드 5/18/26/33/86/87/103/105/107/109/121/125를 대조한다. 미션 정산·합계는 새 후원으로 변환하지 않는다. 운영 분류기가 처리하지 않는 나머지 코드는 제한된 집계로 남긴다.
- SDK 전체 표시 속성·raw hash 동등성을 주장하지 않는다. 향후 운영 통합에서는 전송 경로별 진단 hash와 업무 멱등키 계약을 검토해야 한다.

## 감독 실행

`build-bundle.mjs`가 adapter, 기존 감독 entry, 새 monitor/controller, 고정 ws를 묶고 해시를 계산한다. 계정 ID·실행 receipt·집계는 비공개 `.local/soop-direct-lab`에 둔다.

첫 실방송은 승인된 테스트 계정만 연결한다. 기존 경로와 60초 이상 공존하고 프레임 최소 1개가 일치해야 운영 두 계정 후보를 허용한다. 방송 대기와 canary 대기는 실제 연결 시간에 포함하지 않는다.

방송 종료 신호도 기존 경로의 `waiting_for_live/broadcast_offline`과 독립 대조한 뒤에만 다음 방송을 기다린다. 그 외 오류는 해당 계정 중단 후 검토한다. 안전 중단을 자동으로 우회하지 않는다.

[진행 기록](../../docs/research/2026-09-23-direct-soak.md)
