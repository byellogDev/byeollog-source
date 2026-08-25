# (신원보호모드/개발중) 서버 계약

## 공개 동작

- 표시 이름: `(신원보호모드/개발중)`
- 액션 타입: `obs.voice_anonymize_for`
- 실행 위치: 스트리머가 선택한 `agentDeviceId`의 로컬 Agent
- 조건: 룰렛 결과 일치 또는 고정 별풍선 수 일치
- 실행 시간: 3~60초
- 프리셋: `anonymous_low` 한 종류만 허용
- 생성·수정·실행 테스트: 기존 스트리머 manager/editor 흐름과 같은 권한을 사용하며 별도 숨김이나 접근 차단 없음

## 저장·실행 경계

`save_guided_rule_v14`는 기존 v13 인자를 유지하고 `p_voice_preset`만 추가한다. 음성 액션이 아닌 기존 규칙은 `p_voice_preset=null`일 때 v13으로 그대로 위임된다.

저장된 action params와 실제 Agent job에는 다음 상수 계약만 전달한다.

```json
{
  "label": "(신원보호모드/개발중)",
  "controlType": "voice_anonymize",
  "target": "microphone",
  "durationMs": 10000,
  "preset": "anonymous_low",
  "requiresObsMicInput": true,
  "requiresObsFilter": true
}
```

서버는 OBS 입력명이나 필터명을 원격으로 받지 않는다. Agent가 로컬 설정의 OBS 마이크와 정확한 필터 `별록 신원보호모드`를 확인한 다음에만 필터를 활성화해야 한다. 따라서 저장 시에는 선택한 Agent가 온라인이고 해당 action capability를 광고하는지 확인하고, 실제 OBS 마이크·필터 존재 여부는 실행 직전 Agent가 재검증한다.

## 안전 동작

- `dispatch_guided_rule_test_v4`는 저장된 규칙 버전과 params를 다시 검증하고 실제 로컬 실행 1건만 큐에 넣는다.
- 같은 규칙의 30초 이내 진행 중 테스트는 중복 생성하지 않는다.
- 모든 실행에는 서버 기준 `notAfterUtc`가 추가되며 이벤트 발생 후 2분이 지나면 실행할 수 없다.
- Agent가 오프라인이거나 capability를 보고하지 않으면 저장·테스트가 실패한다.
- OBS 마이크 또는 로컬 필터가 없으면 Agent가 원본 음성에 손대지 않고 실패해야 한다.
- Agent는 성공·실패·재시작과 관계없이 기존 필터 활성 상태를 복원해야 한다.

## 운영 적용 순서

1. `20260825120000_add_voice_anonymize_action.sql` 적용
2. 새 action allowlist가 포함된 `agent-runtime-g3a`와 `event-runtime-g3a` 배포
3. Agent 새 버전 배포
4. Agent의 device status에서 `obs.voice_anonymize_for` 확인
5. 3초 테스트 규칙으로 OBS 필터 활성화와 원복을 확인

DB와 Edge가 준비되기 전에 새 Agent부터 배포하면 신규 capability를 포함한 device status가 구형 Edge에서 거부될 수 있으므로 이 순서를 바꾸지 않는다.
