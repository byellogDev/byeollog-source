# 별록 방송 디지털 트윈

## 목적

SOOP 공식 Chat SDK 승인 전에도 아래 방송 경로를 실제 시간 순서로 반복 검증한다.

```text
가상 SOOP 후원·채팅
  → 후원/채팅 상관관계
  → 룰렛 결과 커밋
  → 3초 오버레이·효과음
  → 결과 TTS·후속 채팅 TTS
  → 액션 전달
  → Agent ACK·OBS 상태 복구
```

이 도구는 운영 제품이 아니다. `127.0.0.1`에만 바인딩하고 Supabase, Vercel,
byeollog.com, 실제 Agent 큐에 접속하지 않는다. `.vercelignore`에도 모든 실행 파일과
문서를 고정하여 운영 배포 입력에서 제외한다.

## 실행

저장소 루트에서 실행한다.

```powershell
npm run twin:roulette
```

Windows에서는 터미널을 계속 띄우지 않는 시작 스크립트를 사용할 수 있다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/Start-NativeRouletteDigitalTwin.ps1
```

이미 서버가 실행 중이면 새 프로세스를 만들지 않고 기존 컨트롤러만 연다. 사용이 끝나면
컨트롤러의 `로컬 서버 종료` 버튼으로 숨겨진 Node 프로세스까지 종료한다.

준비 메시지에 출력되는 주소를 연다.

- 컨트롤러: `http://127.0.0.1:17261/`
- OBS 브라우저 소스: `http://127.0.0.1:17261/overlay?audio=1`
- 음성 없는 투명 오버레이: `http://127.0.0.1:17261/overlay`

`audio=1`은 로컬 룰렛 WAV와 운영체제 한국어 음성 합성만 사용한다. 이 음성은
방송 품질을 판정하는 TTS 후보가 아니라 흐름과 재생 순서를 확인하기 위한 대역이다.

## 시나리오

1. 후원 메시지 · 단차
2. 후원 후 첫 채팅
3. 채팅 패킷 선도착 후 후원 패킷 도착
4. 연차 3회
5. 업보 직행
6. Agent 연결 끊김·재연결
7. OBS 재시작·오버레이 복구
8. 주 TTS 장애·로컬 비상 음성

채팅 선도착은 사용자가 후원 전에 채팅했다는 뜻이 아니다. 실제 발생 시각은 후원이
먼저이지만 SOOP 내부 버퍼나 서로 다른 SDK 이벤트 경로 때문에 별록에 전달되는 순서만
뒤집힌 상황이다. 디지털 트윈은 채팅을 최대 2초간 보관하고 SOOP 발생 시각과 동일
사용자 ID를 모두 확인한 경우에만 연결한다.

## 헤드리스 장기 검증

기본 8,000회(시나리오별 1,000회)를 실행한다.

```powershell
npm run test:roulette-twin
```

더 큰 검증은 다음처럼 실행한다.

```powershell
node tools/Run-NativeRouletteDigitalTwin.mjs --headless --runs 10000 --seed 20260828
```

보고서는 소스 외부의 다음 경로에 기록한다.

```text
../output/native-roulette-digital-twin/campaign-report.json
../output/native-roulette-digital-twin/last-scenario.json
```

## 고정 불변 조건

- 룰렛 연출은 회차당 정확히 3,000ms다.
- 결과 TTS는 결과 공개보다 먼저 시작하지 않는다.
- 후속 채팅의 `[N초전]`은 화면에만 표시하고 TTS가 읽지 않는다.
- 업보 지정 결과는 룰렛 연출, 결과 TTS, 연결 액션을 생략한다.
- Agent 재연결과 OBS 재시작 뒤 같은 결과·액션을 두 번 실행하지 않는다.
- 하나의 시나리오는 완료 이벤트를 정확히 한 번만 기록한다.
- 7개 룰렛 미리보기는 해시·바이트 계약을 통과한 로컬 자산만 제공한다.

## 현재 한계

- 로컬에 보관된 7개 대형 WebP 원본을 해시·바이트 재검증한 뒤 사용하고 3초 시점에 결과를 공개한다. 원본이 없거나 변조되면 검증된 미리보기 PNG로만 대체한다.
- TTS는 흐름 검증용 로컬 대역이며 실제 스트리밍 PCM TTFA나 음질을 보증하지 않는다.
- 공식 SOOP envelope와 재연결 규약은 승인 후 가상 SOOP 어댑터 자리에 교체해 다시 검증해야 한다.
- 실제 Agent·OBS 장시간 실행 검증은 별도 E2E 승인 게이트다.

## 운영 영향 방지

- 서버 바인딩: `127.0.0.1` 고정
- 허용 Host: `127.0.0.1`, `localhost`와 실행 포트만
- 외부 Origin POST 거부
- 데이터베이스 클라이언트와 운영 URL 없음
- 보고서만 소스 외부 로컬 폴더에 기록
- 운영 Vercel 배포 및 Agent 업데이트 없음
