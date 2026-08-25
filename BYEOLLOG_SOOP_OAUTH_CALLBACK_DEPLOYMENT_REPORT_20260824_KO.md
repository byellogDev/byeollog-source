# 별록 SOOP OAuth 콜백 운영 배포 보고서

## 결과

- 운영 Redirect URL: `https://byeollog.com/api/auth/soop/callback`
- Vercel Production: `dpl_5XhBY9JoRhps8zV7a242YQvf2yvT` (`READY`)
- Preview: `dpl_ARBkbgRZHZvhaLq3MoXxfTukr93S` (`READY`)
- GET·HEAD: HTTP 200
- SOOP 인증 거절 응답: HTTP 400 안내 화면

## 보안·비회귀 검증

- `authCode`, `state`, `error_description`을 응답 본문에 노출하지 않습니다.
- 콜백 응답은 `no-store, private`, CSP, `DENY`, `noindex` 헤더를 적용합니다.
- 기존 12개 서버리스 함수 한도를 유지하기 위해 인증 함수 내부 처리와 Vercel rewrite를 사용했습니다.
- 콜백 계약·보안 테스트 14개를 통과했습니다.
- 운영 홈페이지 HTTP 200, 기존 서명 자동 업데이트 피드 동일, 배포 오류 로그 0건을 확인했습니다.
- Supabase DB·Auth·Storage·Edge Function과 DNS는 변경하지 않았습니다.

## 승인 후 후속 작업

SOOP Developers 승인으로 Client ID/Secret 및 실제 토큰 교환 규격이 확정되면, 서버 측 `state` 검증·인증 코드 교환·암호화 토큰 보관·갱신 및 연결 해제 흐름을 추가합니다. 현재 콜백은 신청용 공식 HTTPS 엔드포인트와 안전한 인증 응답 수신 화면까지 준비된 상태입니다.

## 작업 이력 보존 — 2026-08-25

이 항목은 SOOP Developers 재신청 준비 중 완료한 외부 API 수신 URL 작업이 후속 개발에서 누락되지 않도록 남긴 운영 기준입니다.

- 외부 공개 URL: `https://byeollog.com/api/auth/soop/callback`
- Vercel 연결: `vercel.json`에서 `/api/login?operation=soop-callback`으로 rewrite
- 실제 처리 코드: `BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/api/login.js`의 `handleSoopCallback`
- 회귀 계약: `BYEOLLOG_SERVER_DEV_20260823_SUBSCRIPTION_FIX/test/soop-oauth-callback.test.mjs`
- 현재 허용 메서드: `GET`, `HEAD`; 그 외 메서드는 HTTP 405
- 현재 역할: SOOP의 외부 인증 성공·거절 응답을 안전하게 받을 수 있음을 심사 단계에서 증명하는 고정 Redirect URL
- 현재 비범위: 승인 전에는 토큰 교환, 사용자 계정 연결, 토큰 저장·갱신을 수행하지 않음

### 유지 원칙

1. SOOP 신청 화면에는 위 URL을 대소문자와 경로까지 동일하게 입력합니다.
2. 재신청 제출 후에도 운영 URL과 rewrite를 유지합니다. URL 변경은 SOOP 등록값과 동시에 변경·검증해야 합니다.
3. `authCode`, `state`, `error_description`, 향후 Client Secret 및 토큰을 로그·HTML·Git에 남기지 않습니다.
4. 승인 후 실제 연동을 구현할 때 현재 안전 응답 화면을 곧바로 토큰 저장 로직으로 덮어쓰지 말고, `state` 일회성 검증과 계정·workspace 결합을 먼저 설계합니다.
5. 운영 배포 전후 GET·HEAD 200, 거절 응답 400, POST 405와 보안 헤더 회귀를 확인합니다.
