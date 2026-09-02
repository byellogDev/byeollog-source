# 추첨 TTS 관리형 통합 배포 순서

## 2026-09-02 운영 배포 결과

- Vercel Production: `dpl_3A7FBiYYbKmFNZoxphzZrpncYRrc` / `READY`
- Supabase migration: `harden_web_sessions_without_hot_path_latency` 성공
- Supabase migration: `unify_raffle_action_managed_tts` 성공
- Supabase Edge: `agent-runtime-g3a` v26 / `ACTIVE` / JWT 검증 유지
- Agent stable: `0.7.0.136`, release sequence `7136`
- 공개 패키지: `99,623,041` bytes
- 공개 SHA-256: `a07f1d93422d3b24815e140825e156e092a43c1ca3c695496ce54c05c1627295`
- 서명 키: 기존 Primary `rsa3072-cc1fb719f3a63774`
- 무서명 브리지 요청 차단: HTTP `401`
- 서버 테스트 `370/370`, Agent 계약 `200/200`, AgentStore `693` assertions 통과

초기 비밀값 전달 과정에서 CLI가 값을 터미널 제목에 표시해 즉시 폐기했고,
새 무작위 값으로 Vercel과 Supabase를 모두 재회전했다. 운영에는 재회전된 값만
남아 있다. 기존 전용 TTS 인프라는 구형 Agent 전환 기간 동안 유지하고, 실제
방송 추첨 canary를 확인한 뒤 종료한다.

추첨권·당첨 안내는 후원알림과 동일한 Google Chirp 3 HD Leda 주 음성 및
Cartesia Sonic 3.6 Soojin 예비 음성을 사용한다. 기존 CosyVoice/Relay와 Agent
로컬 음성 캐시·후보 사전생성은 사용하지 않는다.

## 필요한 비밀값

43자 이상의 동일한 무작위 값을 한 번 생성해 다음 두 위치에 각각 설정한다.
값 자체는 저장소·로그·지원 번들에 기록하지 않는다.

- Vercel: `BYEOLLOG_MANAGED_TTS_BRIDGE_SECRET`
- Supabase Edge secret: `BYEOLLOG_MANAGED_TTS_BRIDGE_SECRET`
- Supabase Edge secret: `BYEOLLOG_MANAGED_TTS_BRIDGE_ORIGIN=https://byeollog.com`

기존 후원알림용 Google/Cartesia 환경변수는 그대로 유지한다.

## 무중단 순서

1. Vercel 비밀값을 설정하고 웹을 배포한다.
2. Supabase에 `20260902015745_unify_raffle_action_managed_tts.sql`을 적용한다.
3. Supabase Edge 비밀값을 설정하고 `agent-runtime-g3a`를 배포한다.
4. 새 Agent를 배포한다.
5. 추첨권 테스트와 당첨 테스트에서 `managed-google-v1` 또는 장애 전환 시
   `managed-cartesia-v1` 응답 및 OBS 재생을 확인한다.
6. 안정화 확인 뒤 기존 `BYEOLLOG_TTS_ORIGIN`, `BYEOLLOG_TTS_SHARED_SECRET`,
   CosyVoice/Relay 배포를 종료한다.

순서를 바꾸면 구형 Agent의 전용 TTS만 일시 실패할 수 있으므로 1~4를 한 배포
창에서 진행한다. TTS가 실패하더라도 추첨 시각 출력은 계속되고 실행 결과에는
음성 실패가 별도로 남는다.
