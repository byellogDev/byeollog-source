# 별록 에이전트 v0.7.0 RC2 — G4 단일 Windows canary

G4의 목적은 자동 테스트로 대신할 수 없는 실제 Windows·OBS·마이크·화면 복구를
최종 후보 한 개로 한 번만 확인하는 것입니다. 백업 도구를 반복 시험하는 단계가
아니며, 실제 이벤트도 정확히 한 번만 사용합니다.

## 실행 전 관문

- [ ] 최종 Tester ZIP과 외부 SHA-256이 일치함
- [ ] G3A DB/Edge/server가 server-first 순서로 준비되고 대상 workspace만 허용됨
- [ ] global/workspace gate 상태와 rollback 담당자가 확인됨
- [ ] 안정판 v0.5.1.8 및 직전 설치 포인터가 보존됨
- [ ] OBS WebSocket, Windows 마이크, FreeShot 브라우저 소스가 준비됨
- [ ] 중복 없는 통제된 `아봉10초` 이벤트 1건을 사용할 수 있음

관문 하나라도 충족하지 않으면 이 문서를 진행하지 않습니다.

## A. 자동 준비 — 실제 이벤트 0회

Tester ZIP을 새 폴더에 푼 뒤 `RUN_G4_CANARY_PREP.cmd`를 한 번 실행합니다.

통과 문구: `PREPARATION PASSED. NO LIVE EVENT WAS USED.`

이 한 번의 실행에 readiness, install/verify, 무실이벤트 replay, 앱 실행이 포함됩니다.
정상 경로에서는 별도 readiness나 replay를 다시 실행하지 않습니다.

## B. 실이벤트 전 복구 확인 — 실제 이벤트 0회

1. 기존 별록 계정으로 한 번 로그인합니다.
2. 기존 Collector의 pair/upload와 통제된 규칙 저장이 정상인지 확인합니다.
3. 승인된 절차에 포함된 경우 유휴 상태에서 네트워크를 한 번 끊었다 복구합니다.
4. 앱을 한 번 종료·재실행해 단일 인스턴스, 설정 보존, 재연결을 확인합니다.

여기서 실패하면 실제 이벤트를 사용하지 않고 중단합니다.

## C. 실기 canary — 실제 이벤트 정확히 1회

1. 트레이에서 `아봉10초 최종 실기기 검증 (실제 이벤트 1회)`을 누릅니다.
2. 앱의 사전진단 통과 안내 뒤 15분 안에 `아봉10초`를 정확히 1회 발생시킵니다.
3. 이벤트 중 OBS·마이크·오버레이를 직접 조작하지 않습니다.
4. OBS와 FreeShot 양쪽의 표시·자동 숨김 질문에 한 번 답합니다.
5. 생성된 `acceptance-v070_RC2-*.zip`을 보존합니다.

앱이 자동 판정하는 항목:

- 시작 전/종료 후 안전 상태
- 실제 이벤트 수신 및 중복 없는 성공 실행
- 10,000ms 음소거와 실행 전 마이크 상태 복구
- 정확한 오버레이 이미지 ID·버전·SHA-256
- OBS/FreeShot localhost 브라우저 조회와 이미지 자동 숨김
- 서버 ACK 및 불확실 작업·복구 저널 0건

## 실패 시

- 실제 이벤트를 반복하지 않습니다.
- 마이크가 실행 전 상태로 돌아왔는지 먼저 확인합니다.
- acceptance ZIP이 있으면 그대로 보존합니다.
- 추가 자료를 요청받은 경우에만 CREATE_SUPPORT_BUNDLE.cmd를 한 번 실행합니다.
- 신규 경로의 gate를 OFF로 유지하고 안정판 포인터로 rollback합니다.

## 합격 기준

- P0/P1 결함 0건
- acceptance 결과 `pass`
- 기존 수집 데이터·규칙·설정의 의도치 않은 변경 0건
- 중복 실행·미처리 ACK·불확실 작업·복구 저널 0건
- rollback 후 안정판 실행 및 사용자 상태 보존

## 봉인·검증 근거 위치

- G3A server↔Agent bridge 계약: PASS
- Node 소스 계약: PASS 79/79
- Linux source-only packaging dry-run: PASS, source inventory 110개
- .NET 회귀와 win-x64 publish는 이 문서가 든 Tester ZIP을 만들기 전에 one-click build가 통과해야 합니다.
- Tester ZIP 바깥의 `.sha256.txt`가 봉인 바이트의 최종 해시 근거입니다.
- Windows 실제 canary 결과는 앱이 만든 `acceptance-v070_RC2-*.zip`에 기록합니다.
- 운영 배포: NOT_PERFORMED
