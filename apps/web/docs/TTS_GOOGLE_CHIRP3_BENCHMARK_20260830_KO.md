# Google Chirp 3 HD 한국어 TTS 재평가

작성일: 2026-08-30
상태: 실측 완료 · Google Leda 운영 주 음성 전환

## 목적

기존 주 음성의 한국어 발음이 선명하지 않다는 시청 경험 문제를 재평가하고, Google Cloud Text-to-Speech의 `Chirp 3 HD` 한국어 여성 음성 6종을 동일 조건으로 블라인드 비교해 운영 공급자를 결정한다.

## 비교 조건

- 음성: Achernar, Aoede, Kore, Leda, Pulcherrima, Zephyr
- 문장: 초단문, 일반 후원, SOOP 최대 120자
- 출력: 24kHz mono PCM16LE
- 방식: 양방향 스트리밍, 첫 재생 가능 오디오 도착 시간 측정
- 블라인드 결과: 실제 음성 이름을 숨긴 A~F 통합 청취 파일
- 운영 반영: 청취 결과와 지연 수치를 확인한 뒤 별도 승인

## 실측 결과

모든 후보가 6회 측정에서 성공률 100%와 지연 게이트를 통과했다. 각 후보는 음질 편향을 막기 위해 A~F로 다시 섞었다.

| Google 음성 | TTFA p50 | TTFA p95 | 판정 |
| --- | ---: | ---: | --- |
| Achernar | 200.33ms | 203.20ms | 통과 |
| Aoede | 197.21ms | 208.05ms | 통과 |
| Kore | 190.61ms | 206.64ms | 통과 |
| Leda | 193.60ms | 204.81ms | 통과 |
| Pulcherrima | 199.21ms | 221.28ms | 통과 |
| Zephyr | 201.73ms | 208.03ms | 통과 |

지연 차이는 음질 선택을 뒤집을 수준이 아니다. 초단문·일반 후원·120자 문장을 이어 붙인 블라인드 통합 파일을 듣고 발음 명료도와 방송 분위기를 우선 평가한다.

## 최종 블라인드 결정

`윙크` 단독 발음, 일반 후원, 정확히 120자 문장을 사용해 기존 두 후보와 최종 비교했다. 체감 음량을 맞춘 P·Q·R 평가 결과는 `Q > P > R`이었다.

- Q: Google Chirp 3 HD Leda — 주 음성 선정
- P: Cartesia Sonic 3.6 Soojin — 예비 음성 유지
- R: Inworld TTS-2 Flash Minji — 한국어 발음 품질 사유로 탈락

지속 연결 예열 후 최종 실측:

| 후보 | TTFA p50 | TTFA p95 | 성공률 |
| --- | ---: | ---: | ---: |
| Google Leda | 185.99ms | 199.00ms | 100% |
| Cartesia Soojin | 185.55ms | 188.07ms | 100% |
| Inworld Minji | 225.52ms | 228.29ms | 100% |

운영 경로는 Google Leda를 먼저 호출하고, 첫 오디오가 도착하기 전에 Google 요청이 실패한 경우에만 Cartesia Soojin으로 전환한다. Inworld는 신규 운영 요청에서 호출하지 않는다.

## 안전한 인증 원칙

프로젝트 `.env`나 저장소에 API 키·서비스 계정 JSON을 넣지 않는다. 로컬 벤치마크는 Google이 권장하는 Application Default Credentials(ADC)를 사용하고, Vercel 운영 함수는 Workload Identity Federation을 사용한다.

1. Google Cloud 프로젝트에서 결제를 연결한다.
2. Cloud Text-to-Speech API를 사용 설정한다.
3. Google Cloud CLI를 설치한다.
4. 아래 명령으로 로컬 사용자 인증을 만든다.

```powershell
gcloud auth application-default login
```

측정 실행:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Run-GoogleChirpTtsBenchmark.ps1
```

완료 결과:

- 지연 보고서: `output/tts-phase2/google-chirp3-korean-report.json`
- 원본 음성: `output/tts-phase2/samples-google-chirp3-korean/`
- 블라인드 청취: `output/tts-phase2/blind-google-chirp3-korean/`
- 비공개 정답표: `output/tts-phase2/blind-google-chirp3-korean-key.private.json`

## 구현 메모

- 스트림의 첫 요청은 음성·오디오 설정만 전송한다.
- 두 번째 요청에 합성 문장을 전송한다.
- 반환 PCM은 WAV 헤더가 없으므로 벤치마크 공통 WAV 컨테이너로 감싼다.
- ADC는 Google CLI의 사용자별 설정 위치에 저장되며 프로젝트 파일과 배포물에 포함되지 않는다.
- 운영 Vercel 함수는 `owner:jminsu123-7345s-projects:project:observer_abangseladmin:environment:production|preview` 주체만 전용 서비스 계정을 가장할 수 있다.
- Preview 빌드의 실제 Vercel OIDC 토큰으로 Leda 스트리밍 합성을 검증했으며 12회 모두 Google PCM을 반환했다. 검증용 빌드 훅과 실행 파일은 즉시 제거해 운영 배포에 남기지 않았다.
- 운영에 저장하는 것은 공급자·지연·오디오 바이트·오류 코드뿐이며 음성 파일과 후원 메시지 원문은 저장하지 않는다.
- 룰렛 실험 데이터의 통계·업보 분리 정책은 TTS 공급자 전환과 무관하게 유지한다.
