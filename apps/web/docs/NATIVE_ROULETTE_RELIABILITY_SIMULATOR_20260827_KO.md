# 별록 자체 룰렛 로컬 신뢰성 시뮬레이터

## 목적

SOOP Chat SDK 승인 전에도 자체 룰렛의 확률·중복 방지·outbox 재시도·재시작 복구 계약을 대량 검증한다. 이 도구는 가짜 후원 데이터만 사용하는 메모리 전용 프로그램이며 네트워크, 운영 Supabase, Vercel, Agent 업데이트 피드에 접근하지 않는다.

## 실행

서버 소스 폴더에서 다음 명령을 실행한다.

```powershell
npm run test:roulette-reliability
```

더 큰 검증과 JSON 결과 저장:

```powershell
node tools/Simulate-NativeRouletteReliability.mjs `
  --events 50000 `
  --probability-spins 1000000 `
  --seed 20260827 `
  --json-output ..\output\native-roulette-reliability-report.json
```

## 고정 검증 항목

- 1,000,000 PPM 정수 추첨과 항목별 6시그마 확률 편차
- 동일 SOOP 이벤트 100회 재수신 시 최초 스핀 집합만 생성
- 같은 이벤트 ID의 후원자·수량·발생시각 변경 거부
- 후원 순서 역전과 중복 혼합 입력에서 스핀 유실 없음
- 처리 전 크래시와 처리 직후 ACK 유실을 모두 재현
- 재시작 후 lease 만료 재처리와 사용자 노출 중복 억제
- TTS 캐시 미준비 재시도 후 정확히 한 번 실행
- 업보 직행 결과에서 화면·효과음·TTS 기록이 생성되지 않음
- 룰렛 시작 후 결과 TTS가 3~4초 구간에 시작하는 순서 모델
- 최대 10회 실패 후 outbox가 무한 재시도하지 않고 종료

## 운영 격리

- 이 도구에는 HTTP·Supabase·Vercel 클라이언트가 없다.
- 운영 환경 변수를 읽거나 변경하지 않는다.
- `NATIVE_ROULETTE_ENABLED`와 SOOP SDK 플래그는 계속 기본 OFF다.
- dormant 마이그레이션과 운영 배포물은 수정하거나 적용하지 않는다.
