# TTS 2단계: 실제 후보 선정과 실측 상태

작성일: 2026-08-29
상태: 재평가 완료 — Google Leda 주 조합, Cartesia Soojin 예비 조합 선정

## 결론부터

최초 선정 후 실제 시청에서 Inworld Minji의 일부 한국어 발음이 불명확하다는 피드백이 확인됐다. `윙크` 단독 발음과 SOOP 최대 120자 문장을 포함한 재평가 결과, 동적 후원 메시지와 첫 채팅의 주 조합을 **Google Chirp 3 HD + Leda**로 변경한다. **Cartesia Sonic 3.6 + Soojin**은 예비 조합을 유지하고 Inworld Minji는 탈락 처리한다. 현행 CosyVoice 3는 룰렛 결과 선생성·캐시용으로 남길 수 있다.

Inworld 120자 SOOP 최대 채팅 실측:

- HTTP stream 10회: 성공률 100%, TTFA p50 255ms, p95·최대 812ms — 지연 게이트 실패
- 지속 WebSocket 10회: 성공률 100%, TTFA p50 226ms, p95·p99·최대 233ms — 지연 게이트 통과
- WebSocket 120자 전체 합성 p50 1,187ms, 생성 음성 길이 p50 약 17.5초
- 한국어 네 음성 동일 조건: 모두 TTFA 224~229ms
- 블라인드 청취 결과: C만 채택, C의 실제 음성은 Minji. Hyunwoo·Seojun·Yoona는 제외

Cartesia 한국어 음성 14개 중 대화형 후보 6개를 같은 세 문장으로 블라인드 비교했다. B(Minji)와 E(Soojin)가 1차 후보였고, Inworld Minji까지 다시 섞은 결승에서는 Inworld Minji가 1위, Cartesia Soojin이 2위, Cartesia Minji가 3위였다.

Cartesia Soojin 120자 지속 WebSocket 10회 실측:

- 성공률 100%
- TTFA p50 192ms, p95·p99·최대 203ms — 지연 게이트 통과
- 예비 조합: **Cartesia Sonic 3.6 + Soojin + 지속 WebSocket**

따라서 별도 회사 장애에 대비한 예비 공급자까지 선정 완료했다. Cartesia Minji와 나머지 블라인드 후보는 제외한다.

- 처음 생성하는 8개 한국어 문장: TTFA p50 2,919ms, p95 4,996ms
- 동일 문장 메모리 캐시: TTFA p50 4ms, p95 17ms
- 성공률: 두 시험 모두 100%

따라서 동적 TTS는 관리형 스트리밍 공급자를 별도로 사용하고, 고정 룰렛 결과는 배포 전에 생성해 캐시하는 이중 경로가 합리적이다.

## 최종 공급자 결정

1. Google Chirp 3 HD + Leda + 양방향 스트리밍 — 주 공급자
2. Cartesia Sonic 3.6 + Soojin + 지속 WebSocket — 예비 공급자
3. 현행 CosyVoice 3 완성 WAV — 선생성 룰렛 결과 캐시 전용 후보

Inworld TTS-2 Flash + Minji는 최종 `윙크` 블라인드 평가에서 탈락했다.

Inworld와 Cartesia의 실제 지속 WebSocket 어댑터를 별록 공통 벤치마크에 구현했다. 둘 다 24kHz mono PCM16LE로 정규화할 수 있어 다음 단계의 인증된 서버 중계와 OBS AudioWorklet에 직접 연결할 수 있다.

ElevenLabs·Azure는 주·예비 조합이 모두 음질과 지연 기준을 통과했으므로 이번 선정 단계에서는 추가 비용을 쓰지 않고 보류한다. 이후 실제 시청에서 현행 주 음성의 일부 한국어 발음이 불명확하다는 피드백이 확인되어 Google Chirp 3 HD는 별도 블라인드 재평가 대상으로 전환했다. 이 재평가는 운영 음성을 자동 교체하지 않는다.

## 측정 원칙

- 같은 서울 인터넷 회선, 같은 한국어 8문장, 같은 반복 횟수
- 첫 바이트와 첫 재생 가능 PCM을 분리
- p50 450ms, p95 800ms, p99 1,200ms, 성공률 99.9%를 자동 판정
- 짧은 채팅 `딸깍`을 별도 확인
- 숫자·영문 혼용·룰렛 상품명 발음을 WAV로 블라인드 청취
- 공급자 마케팅 지연 수치는 참고만 하고 별록 실측으로 합격 여부를 결정

## 인증정보 저장

키를 프로젝트나 `.env`에 평문 저장하지 않는다. 아래 도구는 Windows DPAPI CurrentUser로 암호화하고 현재 사용자와 SYSTEM만 파일을 읽도록 제한한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Save-TtsBenchmarkCredentials.ps1
```

필요한 값:

- Cartesia API Key
- Cartesia 한국어 Voice ID
- ElevenLabs API Key
- ElevenLabs 한국어 Voice ID

Inworld와 Cartesia는 별도 도구가 API 키를 DPAPI로 저장하고 한국어 음성을 자동 조회한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Save-InworldTtsBenchmarkCredential.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Save-CartesiaTtsBenchmarkCredential.ps1
```

저장 후 실측:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Run-ManagedTtsBenchmark.ps1
```

키와 음성 ID는 결과 JSON, WAV 파일명, 콘솔 출력에 기록하지 않는다.

## 현재 결과물

- 냉문장 CosyVoice: `output/tts-phase2/cosyvoice3-local-report.json`
- 캐시 CosyVoice: `output/tts-phase2/cosyvoice3-warm-cache-report.json`
- CosyVoice 청취 표본: `output/tts-phase2/samples-cosyvoice3/`
- 관리형 후보 설정: `tools/tts-benchmark/providers.managed.example.json`
- 관리형 후보 실행기: `tools/Run-ManagedTtsBenchmark.ps1`
- Inworld HTTP 120자: `output/tts-phase2/inworld-max-chat-120-report.json`
- Inworld WebSocket 120자: `output/tts-phase2/inworld-websocket-max-chat-120-report.json`
- Inworld 한국어 음성 비교: `output/tts-phase2/inworld-korean-voices-report.json`
- Inworld 블라인드 청취 세트: `output/tts-phase2/blind-inworld-korean-voices/`
- Cartesia 한국어 음성 비교: `output/tts-phase2/cartesia-korean-voices-report.json`
- Cartesia Soojin WebSocket 120자: `output/tts-phase2/cartesia-soojin-websocket-max-chat-120-report.json`
- Cartesia 블라인드 청취 세트: `output/tts-phase2/blind-cartesia-korean-voices/`
- 최종 3자 블라인드 청취 세트: `output/tts-phase2/blind-final-voices/`

## 발견해 함께 고친 운영 결함

Docker Desktop이 `%LOCALAPPDATA%\Programs\DockerDesktop`에 설치된 PC를 자동복구 스크립트가 찾지 못했다. 실제 설치 경로와 Docker CLI 경로를 모두 탐색하도록 수정했고, 로컬 CosyVoice·Quick Tunnel·고정 Worker 중계까지 정상 상태로 복구했다.
