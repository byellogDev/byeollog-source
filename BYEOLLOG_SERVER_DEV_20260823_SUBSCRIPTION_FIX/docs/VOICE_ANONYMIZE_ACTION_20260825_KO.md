# (신원보호모드/개발중) 서버 계약

## 공개 동작

- 표시 이름: `(신원보호모드/개발중)`
- 기존 다운톤 액션 타입: `obs.voice_anonymize_for`
- 업톤·다운톤 선택 액션 타입: `obs.voice_anonymize_for_v2`
- 실행 위치: 스트리머가 선택한 `agentDeviceId`의 로컬 Agent
- 조건: 룰렛 결과 일치 또는 고정 별풍선 수 일치
- 실행 시간: 3~60초
- 프리셋: `anonymous_low`(다운톤), `anonymous_high`(업톤)
- 생성·수정·실행 테스트: 기존 스트리머 manager/editor 흐름과 같은 권한을 사용하며 별도 숨김이나 접근 차단 없음

## 저장·실행 경계

`save_guided_rule_v15`는 v14 인자를 그대로 유지한다. 새 설정 화면은
`obs.voice_anonymize_for_v2`로 저장하며 `anonymous_low`와 `anonymous_high` 중
하나만 허용한다. 기존 `obs.voice_anonymize_for` 규칙과 음성 외 액션은 v14로
그대로 위임해 구버전 다운톤 규칙을 깨뜨리지 않는다.

저장된 action params와 실제 Agent job에는 다음 상수 계약만 전달한다.

```json
{
  "label": "(신원보호모드/개발중)",
  "controlType": "voice_anonymize",
  "target": "microphone",
  "durationMs": 10000,
  "preset": "anonymous_low 또는 anonymous_high",
  "requiresObsMicInput": true,
  "requiresObsFilter": true
}
```

서버는 OBS 입력명이나 필터명을 원격으로 받지 않는다. Agent는 로컬 설정의
OBS 마이크와 프리셋별 필터를 확인한 다음에만 필터를 활성화한다. 기본 이름은
다운톤 `별록 신원보호모드`, 업톤 `별록 신원보호모드 업톤`이다. 저장 시에는
선택한 Agent가 온라인이고 `obs.voice_anonymize_for_v2` capability를 광고하는지
확인하며, 실제 마이크·필터 존재 여부는 미리보기와 실행 직전에 다시 검증한다.

## 안전 동작

- 설정 화면에서 선택한 톤을 5초간 로컬 미리보기할 수 있으며 종료 후 원래 필터 상태로 복구한다.
- `dispatch_guided_rule_test_v5`는 저장된 규칙 버전·프리셋·params를 다시 검증하고 실제 로컬 실행 1건만 큐에 넣는다. 기존 액션 테스트는 v4로 위임한다.
- 같은 규칙의 30초 이내 진행 중 테스트는 중복 생성하지 않는다.
- 모든 실행에는 서버 기준 `notAfterUtc`가 추가되며 이벤트 발생 후 2분이 지나면 실행할 수 없다.
- Agent가 오프라인이거나 capability를 보고하지 않으면 저장·테스트가 실패한다.
- OBS 마이크 또는 로컬 필터가 없으면 Agent가 원본 음성에 손대지 않고 실패해야 한다.
- Agent는 성공·실패·재시작과 관계없이 기존 필터 활성 상태를 복원해야 한다.

## 운영 적용 순서

1. 기존 `20260825120000_add_voice_anonymize_action.sql` 적용 상태 확인
2. `20260825134122_add_voice_anonymizer_pitch_presets.sql` 적용
3. 새 action allowlist가 포함된 `agent-runtime-g3a`와 `event-runtime-g3a` 배포
4. Agent 새 버전 배포
5. Agent의 device status에서 `obs.voice_anonymize_for_v2` 확인
6. 두 로컬 5초 미리보기와 저장된 3초 테스트 규칙으로 필터 활성화·원복 확인

DB와 Edge가 준비되기 전에 새 Agent부터 배포하면 신규 capability를 포함한 device status가 구형 Edge에서 거부될 수 있으므로 이 순서를 바꾸지 않는다.
