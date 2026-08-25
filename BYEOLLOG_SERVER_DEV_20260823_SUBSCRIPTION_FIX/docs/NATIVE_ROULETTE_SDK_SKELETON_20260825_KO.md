# 별록 네이티브 룰렛 SDK 대기형 뼈대

## 현재 상태

이 소스는 SOOP Chat SDK 승인 전에 데이터·캐시·UI 계약을 먼저 고정한 비활성 뼈대다. 운영 DB, Vercel, Edge Function, TTS Docker, 배포 에이전트에는 적용하지 않았다. SQL은 일반 `supabase db push` 대상이 아닌 `supabase/dormant-migrations/20260825110000_native_roulette_sdk_skeleton.sql`에 보존한다. 승인 후에는 이 파일을 직접 실행하지 않고 당시 운영 migration 순서에 맞는 새 timestamp의 검토된 migration으로 복원한다. 이 SQL에는 활성화 RPC가 의도적으로 없으므로, 별도 승인 구현 전에는 룰렛을 실행할 수 없다.

## 확정 데이터 흐름

1. 스트리머가 상품명, 정수 PPM 확률(합계 1,000,000), 1회당 별풍선, 배수 인정 여부를 저장한다.
2. 스트리머는 최종 clean-edge WebP 7종 중 하나와 효과음/TTS 음량, 캐시할 에이전트 PC를 선택한다.
3. 서버는 기존 설정을 수정하지 않고 새 불변 revision을 `cache_pending`으로 만든다.
4. 일반 상품마다 정확한 TTS 문구와 `native-roulette-result-v1|문구` SHA-256 키를 만들고, 선택한 에이전트에 WebP 1개와 결과 TTS 전부를 준비하도록 요구한다.
5. 에이전트는 전용 TTS 엔드포인트에서 WAV를 받아 해시·음성 버전을 검증한 뒤 로컬 캐시에 원자적으로 저장하고 영수증을 보낸다.
6. 모든 캐시 영수증이 일치하면 revision은 `ready`가 된다. `ready`는 실행 가능 상태가 아니다.
7. 향후 승인 마이그레이션이 별도 활성화 조건을 통과시킨 revision만 `active`로 바꾼다.
8. SOOP 채팅 SDK의 후원 이벤트 ID를 idempotency key로 저장하고 금액에 맞는 횟수만 추첨한다.
9. 일반 결과는 아래 표준 이벤트로 자동화 조건에 연결하고, 같은 dispatch에 오버레이·효과음·캐시 TTS 프레젠테이션을 넣는다.

```text
source=byeollog
platform=soop
eventType=roulette
subtype=native
payload.result=<당첨 상품명>
```

10. 업보 체크 결과는 예외 경로다. 오버레이, 효과음, TTS, 자동화 이벤트를 모두 건너뛰고 `direct_upbo` outbox로만 보낸다. 상품명의 `&`는 각 구간을 그대로 나누는 일반 분리만 적용하며, 앞 구간의 접두어를 뒤 구간에 복제하는 특수 규칙은 두지 않는다.

## WebP 원본 7종

모두 `1920×1080`, 91프레임, 4.8초, 무손실 알파 WebP다. 소스 파일은 현재 워크스페이스의 `output/roulette_overlay/color_animations_clean_edge`에 있고, 서버 카탈로그는 파일명뿐 아니라 정확한 바이트 수와 SHA-256을 고정한다.

- 네이비 · 골드
- 로열 퍼플 · 로즈 골드
- 에메랄드 · 샴페인
- 버건디 · 페일 골드
- 그래파이트 · 시안
- 파우더 블루 · 피치
- 더스티 라벤더 · 버터

157MB 원본 7개를 Vercel 함수나 에이전트 설치 파일에 직접 포함하지 않는다. 전용 immutable asset release에 게시한 뒤, 선택한 WebP 한 개만 에이전트가 받아 캐시하도록 한다. 현재 카탈로그의 `delivery_status`는 전부 `staged`다.

## 활성화 전 필수 게이트

- SOOP Chat SDK 사용 승인이 실제로 완료됨
- 서버 환경의 `SOOP_CHAT_SDK_ENABLED=true` 및 내부 비밀키 설정
- 7개 WebP가 SHA-256 기반 immutable 경로에 게시됨
- 에이전트가 `native_roulette.overlay`와 전용 캐시 프로토콜을 지원하는 배포 버전임
- 선택한 PC가 해당 WebP와 일반 결과 TTS 전부에 대해 일치하는 캐시 영수증을 보고함
- 일반 결과 outbox를 기존 G3A 이벤트 커밋으로 전달하고 `direct_upbo` outbox를 업보 원장에 반영하는 브리지 배포
- 재시도, 중복 SOOP 이벤트, 에이전트 오프라인, TTS relay 중단을 포함한 실제 데이터 E2E 검증

이 조건을 확인하는 별도 마이그레이션 전에는 활성화 함수를 추가하지 않는다.

## 보안 경계

- 모든 새 테이블은 `byeollog_automation` private schema에 있고 RLS와 명시적 direct-client deny 정책을 사용한다.
- 테이블 권한은 `public`, `anon`, `authenticated`, `service_role`에서 모두 회수한다.
- 공개 schema RPC는 함수 단위로 service role에만 실행 권한을 준다.
- 설정 RPC는 서버가 전달한 사용자 ID와 최신 워크스페이스 멤버십을 DB에서 다시 대조한다.
- 에이전트 캐시 RPC는 기존 runtime release lock과 장치 secret 검증을 재사용한다.
- `SECURITY DEFINER` 함수는 모두 빈 `search_path`와 짧은 `statement_timeout`을 사용한다.
- SOOP 이벤트 수신 API는 기능 플래그와 constant-time 내부 비밀키 검사를 모두 통과해야 한다.

## 이번 뼈대에서 의도적으로 남긴 작업

SOOP 승인과 실제 SDK payload가 없으므로 payload adapter 및 실제 활성화는 만들지 않았다. WebP 게시, 에이전트 캐시 coordinator 연결, outbox 소비자 배포도 현재 서비스에 영향을 줄 수 있어 소스 계약까지만 준비했다. 이 세 작업은 승인 이후 한 묶음으로 구현·검증한다.
