# SOOP OAuth 활성화 준비 런북

## 현재 상태

- SOOP Developers 등록 Redirect URL과 동일한 `/api/auth/soop/callback`을 사용한다.
- 운영은 `SOOP_OAUTH_ENABLED=true`이며 실제 스트리머 계정 연결이 완료됐다.
- 기존 위플랩/Collector/Agent/룰렛 실행 경로에는 접근하지 않는다.
- 토큰 저장 SQL은 운영 DB에 적용됐고 연결·자가진단·자동 refresh를 검증했다.
- Client Secret과 SOOP 토큰은 브라우저 응답, URL, 로그, 저장소에 기록하지 않는다.

## 준비된 서버 경로

| 경로 | 용도 | 보호 방식 |
|---|---|---|
| `/api/auth/soop/start` | 로그인된 스트리머의 SOOP 동의 시작 | 라이브 멤버십 확인, 교차 사이트 시작 차단, 10분 서명 쿠키 |
| `/api/auth/soop/callback` | 일회용 `authCode` 교환 | 서명 쿠키와 선택적 `state` 검증, no-store, 비밀값 비반사 |
| `/api/auth/soop/status` | 웹 UI용 연결 상태 | 로그인·워크스페이스 권한 확인, 토큰 미반환 |

토큰 교환은 SOOP 공식 SDK 배포본과 문서에 맞춰 서버에서 다음 형식으로 수행한다.

- 인증: `https://openapi.sooplive.com/auth/code`
- 토큰: `POST https://openapi.sooplive.com/auth/token`
- 발급: `grant_type=authorization_code`
- 갱신: `grant_type=refresh_token`

## 운영 환경변수

아래 값은 Vercel 서버 환경변수로만 등록한다. `NEXT_PUBLIC_` 접두사를 사용하거나 Git에 커밋하지 않는다.

```text
SOOP_OAUTH_ENABLED=false
SOOP_CLIENT_ID=<SOOP Developers Client ID>
SOOP_CLIENT_SECRET=<SOOP Developers Client Secret>
SOOP_REDIRECT_URI=https://byeollog.com/api/auth/soop/callback
SOOP_TOKEN_ENCRYPTION_KEY=<32 random bytes encoded as base64url or 64 hex chars>
```

암호화 키는 Client Secret과 별개로 생성하며 재사용하지 않는다. 예시 생성 명령은 값을 화면에 출력하므로 개인 PC에서 실행한 직후 Vercel Sensitive 환경변수에 넣고 공유하지 않는다.

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).TrimEnd('=').Replace('+','-').Replace('/','_')
```

## 완료된 활성화 순서

1. 운영 Supabase 토큰 스키마, RLS, 권한을 확인했다.
2. Vercel Production에 OAuth 환경변수를 Sensitive/Config로 분리 등록했다.
3. 동의 → 콜백 → 암호화 저장 → status → refresh 자가진단을 검증했다.
4. 일시적인 SOOP 오류는 연결을 해제하지 않고, 명시적인 400/401/403 refresh 거부만 재연결 필요로 판정한다.
5. 채팅 게이트웨이와 자체 룰렛은 OAuth와 별도 플래그로 계속 잠겨 있다.

## 남은 공식 확인 사항

SOOP 공식 브라우저 SDK는 생성자와 채팅 입장 패킷에 Client Secret을 사용한다. 여러 스트리머에게 배포되는 Agent나 공개 웹 페이지에 공용 Client Secret을 넣으면 추출 가능하므로, 다음 중 SOOP이 공식 지원하는 방식을 1:1 문의로 확인하기 전에는 `SOOP_CHAT_SDK_ENABLED=true`로 바꾸지 않는다.

- 서버가 발급한 access token만으로 Chat SDK에 접속하는 confidential-client 방식
- 스트리머별 또는 설치별 제한 키
- 서버 측 공식 Chat SDK 또는 장기 연결 relay 지원 방식

OAuth 토큰 교환은 서버 전용으로 준비됐지만, 위 Client Secret 전달 규칙은 별개의 출시 게이트다.

## 롤백

- `SOOP_OAUTH_ENABLED=false`로 즉시 새 연결과 토큰 교환을 중단한다.
- `SOOP_CHAT_SDK_ENABLED=false`와 `NATIVE_ROULETTE_ENABLED=false`를 유지한다.
- 필요 시 연결 행을 `revoked`로 전환하고 토큰을 폐기한다.
- Client Secret 또는 암호화 키 노출이 의심되면 즉시 회전하고 기존 연결을 재승인한다.
