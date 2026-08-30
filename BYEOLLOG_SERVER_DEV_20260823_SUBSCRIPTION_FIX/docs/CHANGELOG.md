# Server changelog

## 2026-08-30 — Google Leda 운영 주 음성 전환

- Google Chirp 3 HD Leda를 운영 주 음성, Cartesia Sonic 3.6 Soojin을 예비 음성으로 연결했다.
- Google이 오디오를 보내기 전에 실패한 경우에만 Cartesia로 전환하며, 재생이 시작된 뒤에는 다른 목소리가 이어 붙지 않도록 실패를 종료한다.
- Vercel 팀·프로젝트·환경이 들어간 단기 OIDC 토큰만 Google 전용 서비스 계정을 가장할 수 있게 제한하고 서비스 계정 JSON과 Google API 키를 사용하지 않는다.
- Supabase에는 음성·메시지 원문 없이 공급자와 지연·바이트·오류 메타데이터만 기록하며, 브라우저 역할의 테이블·완료 RPC 접근을 계속 차단한다.
- 기존 Inworld 실행 기록은 통계 보존을 위해 허용하지만 신규 운영 재생 경로에서는 제거했다.
- Google Chirp 3 HD 한국어 여성 음성 6종을 초단문·일반 후원·120자 최대 채팅으로 비교하는 독립 벤치마크를 추가했다.
- Google의 양방향 스트리밍 규격에 맞춰 설정과 문장을 분리 전송하고, 반환되는 24kHz mono PCM의 첫 재생 가능 시각과 전체 합성 시간을 공통 측정기에 연결했다.
- 음성 이름을 숨긴 A~F 청취 팩과 비공개 정답표를 분리 생성한다.
- 서비스 계정 JSON이나 API 키를 저장소에 넣지 않고 로컬 ADC 인증만 사용하도록 실행기를 제한했다.
- 실제 6개 후보 모두 성공률 100%, TTFA p50 190.61~201.73ms, p95 최대 221.28ms로 지연 게이트를 통과했다.
- `윙크` 발음을 포함한 최종 블라인드에서 Google Leda가 1위, Cartesia Soojin이 2위였고 Inworld Minji는 탈락했다.

## 2026-08-30 — 공통 오버레이 고정 최대 봉투

- 1920×1080 전체 무대 안에 작은 카드를 배치하던 방식을 제거하고, 후원 종류 강조 영역과 120자 메시지를 수용하면서 사방 안전 여백을 최소화한 460×450 고정 출력 봉투로 전환했다.
- SOOP 공식 Chat SDK 이벤트를 기준으로 일반 별풍선·대결미션·도전미션 종류를 공통 오버레이까지 보존하며, 짧은 한 줄 메시지는 더 낮은 패널로 접힌다.
- 룰렛 카드·시그풍·후속 알림은 같은 경계 안에서 비슷한 크기로 출력되며, 메시지 길이가 달라져도 OBS 소스 경계는 바뀌지 않는다.
- 카드 폭 420px과 이미지 316×178 규격은 유지하면서 그림자와 등장 애니메이션이 잘리지 않을 안전 여백만 남겼다.

## 2026-08-30 — 방송형 룰렛 카드 v8와 표시 길이 규격

- 실제 방송 레퍼런스 비율에 맞춰 룰렛 이미지를 316×178, 결합 카드 폭을 420으로 고정하고 모든 OBS 해상도에서 1920×1080 논리 좌표를 동일 비율로 축소한다.
- 단차와 연차가 같은 카드 구조를 쓰며, 11연차는 카드를 다시 열지 않고 회차와 결과만 갱신한다.
- 후원자 표시 닉네임은 최대 12 grapheme, 룰렛 상품명은 최대 20 grapheme으로 규격화했다.
- 상품명은 입력·공개 가져오기·저장·방송 적용·TTS·OBS 표시에서 같은 Unicode 규칙을 사용하며, 한글 IME와 결합 이모지를 보존한다.
- 120자 후원 멘트가 결과 카드 아래에 붙어 표시되고, 연차 결과 TTS가 모두 끝난 뒤 멘트 TTS를 재생한다.
- 기존 저장본과 방송 적용본을 사전 점검해 20자 초과 상품이 없음을 확인했다.

## 2026-08-29 — 시그니처 별풍선과 공통 OBS 오버레이

- 별풍선 개수별 PC·모바일 시그풍 등록 UI와 서버 전용 레지스트리를 추가했다.
- 후원 세레모니 이미지를 `등록 시그풍 → SOOP imageUrl → 별록의 SOOP 기본 대체 이미지` 순서로 결정한다.
- 룰렛·시그풍·향후 알림이 같은 1920×1080 OBS 브라우저 소스를 사용하도록 공통 오버레이를 전환했다.
- 웹 오버레이 위치 배치 화면과 실행 API를 제거하고, 크기·위치는 OBS 소스 변환에서 관리하도록 단순화했다.
- 시그풍 파일은 비공개 Storage에 보관하고 짧은 서명 URL로만 미리보기·송출한다.
- SOOP 이미지 URL과 오버레이 CSP를 공식 자산 도메인으로 제한했다.
- 시그풍 목록 미리보기 URL을 일괄 발급하고 시그풍 페이지의 불필요한 룰렛·액션 초기 조회를 제거했다.

## 2026-08-25 — Agent collection-health compatibility hotfix

- Accept explicitly idle Agent collection health when nullable timestamps are omitted by older/current JSON clients.
- Keep invalid timestamp values fail-closed.
- Prevent optional collection-health telemetry from blocking the primary automation heartbeat and execution claim loop.
- Add regression coverage for an idle, non-collecting Agent so raffle and other local actions remain claimable.
