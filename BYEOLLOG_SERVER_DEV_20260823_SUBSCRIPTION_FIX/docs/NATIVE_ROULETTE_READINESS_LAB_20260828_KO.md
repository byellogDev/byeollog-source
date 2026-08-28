# 별록 Native Roulette Readiness Lab

## 결론

이 도구는 SOOP 공식 Chat SDK 승인 전에 자체 룰렛의 내부 계약을 대량 검증하는 로컬 품질 장비다. 운영 Vercel, 운영 Supabase, Agent 업데이트 피드, 실제 방송 오버레이에는 접근하지 않는다. 내부 검증을 모두 통과해도 실제 SOOP SDK·실측 TTS·Agent/OBS E2E가 끝나기 전에는 결과를 `READY`가 아닌 `CONDITIONAL_PASS`로 표시한다.

## 한 번에 실행

서버 소스 폴더에서 실행한다.

```powershell
npm run lab:roulette
```

기본 산출물:

- `..\output\native-roulette-readiness-lab\report.json`
- `..\output\native-roulette-readiness-lab\index.html`

더 큰 검증:

```powershell
node tools\Run-NativeRouletteReadinessLab.mjs `
  --events 50000 `
  --probability-spins 5000000 `
  --correlation-cases 20000 `
  --latency-samples 100000 `
  --tts-iterations 20000 `
  --seed 20260828
```

모든 난수 기반 장애·지연·순서 시나리오는 seed를 고정하면 같은 결과가 나온다. 보고서의 실행 시간과 생성 시각만 달라진다.

## 검증 범위

### 1. 확률과 정확히 한 번 실행

- `probability_ppm` 합계 1,000,000의 정수 확률만 사용
- 32-bit rejection sampling으로 modulo 편향 제거
- 항목별 기대 횟수 대비 6시그마 판정
- 동일 SOOP 이벤트 폭주와 이벤트 ID 내용 변경 차단
- outbox lease, 처리 전 종료, 커밋 직후 ACK 유실, 캐시 미준비 재시도
- 재시작 후 유실 0건, 사용자 노출 중복 0건
- 업보 직행 결과의 화면·효과음·TTS·액션 생략

### 2. 후원 메시지와 첫 채팅

- 후원 메시지가 있으면 모든 룰렛 결과 뒤 한 번만 읽음
- 메시지가 없으면 같은 후원자의 설정 시간 내 첫 채팅만 연결
- 화면에는 `[N초전] 닉네임 : 메시지` 표시
- TTS에는 시간 표기를 제외하고 메시지만 전달
- 다른 시청자 채팅, 시간 초과 채팅, 두 번째 채팅은 읽지 않음
- 채팅이 후원 이벤트보다 먼저 도착한 네트워크 역순은 제한된 재정렬 버퍼에서 복구
- 중복 채팅 이벤트는 다시 읽지 않음

### 3. 3초 룰렛 시간 예산

기본 내부 목표:

| 구간 | P95 목표 |
|---|---:|
| 후원 수신 → 오버레이 시작 | 250ms 이하 |
| 결과 공개 → 사전 캐시 TTS | 100ms 이하 |
| 동적 채팅 → 첫 음성 | 1,000ms 이하 |
| 룰렛 애니메이션 | 정확히 3,000ms |

합성 지연 모델은 구조의 큐 용량과 시간 예산을 확인하는 도구다. 특정 TTS 공급자의 실제 성능이라고 해석하면 안 된다.

### 4. TTS 분리 전략

- 룰렛 당첨 결과: 룰렛 저장 시 생성하여 Agent에 사전 캐시
- 후원 후 첫 채팅: 초저지연 스트리밍 후보
- 동적 TTS 장애: 화면 텍스트 또는 내장 비상 음성으로 방송 지속
- 현행 CosyVoice 완성 WAV: 품질 비교 기준이며 동적 채팅 엔진으로 고정하지 않음

실제 로컬 CosyVoice 완성 WAV 응답은 Docker가 준비된 PC에서 별도로 측정한다.

```powershell
$env:BYEOLLOG_TTS_SHARED_SECRET='<로컬에만 설정>'
node tools\Benchmark-NativeRouletteTtsEndpoint.mjs `
  --endpoint http://127.0.0.1:8080 `
  --iterations 20 `
  --json-output ..\output\native-roulette-readiness-lab\cosyvoice-local.json
```

이 실측 도구는 실수로 운영 relay를 부하 시험하지 않도록 loopback HTTP 주소만 허용한다. 결과는 완성 WAV 응답 시간이며 PCM/WebSocket 첫 조각 TTFA가 아니다.

### 5. 장애 주입

- 네트워크 단절
- Agent 종료
- OBS 재시작
- 커밋 직후 서버 종료
- 오버레이 새로고침
- TTS 중단

각 시나리오는 유실 0건, 사용자 노출 정확히 1회, 제한 시간 내 복구를 요구한다. TTS 중단만 안전한 대체 경로를 허용한다.

## 점수 해석

SOOP 승인 전 로컬 검증으로 얻을 수 있는 최고 점수는 90점이다. 다음 세 조건을 실제 환경에서 닫아야 출시 판정을 100점으로 올릴 수 있다.

1. SOOP 공식 SDK의 실제 envelope, 중복, 역순, 재연결 동작
2. 동적 채팅 TTS 후보의 실제 한국어 TTFA, 청취 품질, 동시 처리량, 비용과 상업 이용 조건
3. 실제 Agent·OBS 브라우저 소스 장시간 E2E

## 운영 격리 계약

- 기본 Lab 코어와 HTML 렌더러에는 `fetch`, HTTP 클라이언트, Supabase, 환경변수, subprocess가 없다.
- 기본 실행은 가짜 후원·채팅과 메모리 상태만 사용한다.
- 실제 TTS 측정 도구만 명시적으로 실행했을 때 `127.0.0.1`에 접근한다.
- `NATIVE_ROULETTE_ENABLED`와 `SOOP_CHAT_SDK_ENABLED`는 계속 기본 OFF다.
- dormant migration을 active migration으로 이동하거나 운영 DB에 적용하지 않는다.
- 생성된 보고서는 소스 밖 `..\output`에 저장한다.
