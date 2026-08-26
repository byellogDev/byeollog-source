# 별록 최신 버전·운영 현황 — 2026-08-26

이 문서는 과거 기준선보다 우선하는 현재 운영 현황입니다. 확인되지 않은 추정값은 기록하지 않습니다.

## 1. 현재 권위 버전

| 영역 | 현재 기준 |
|---|---|
| Windows Agent | `0.7.0.94` |
| Agent 업데이트 sequence | `7094` |
| Web package | `0.6.3-g3a.47` |
| Web build | `0.6.3.67-g3a-agent-release-assets` |
| Git branch | `codex/public-release-v071` |
| 운영 도메인 | `byeollog.com`, `www.byeollog.com` |

Agent v0.7.0.94는 액션 생성 화면에 신원보호 필터와 아봉용 마이크 설정을 내장한 현재 안정판입니다.

## 2. Agent v0.7.0.94 배포 무결성

| 대상 | 값 |
|---|---|
| 패키지 | `byeollog_agent_v07094_INLINE_MIC_SETUP_WIN_X64.zip` |
| 패키지 크기 | `79,188,464 bytes` |
| 패키지 SHA-256 | `d612d7a73b46a763d3c3c560b6fe615a25db3da30fbec3d468ef87ef3588e4d6` |
| inner manifest SHA-256 | `03d4208a9f8ed31e0240b7cd5377f7775032f0600088f3e683b511e487edacfd` |
| updater protocol | `1` |

안정 피드는 서명돼 있으며 현재 패키지를 `https://byeollog.com`의 직접 200 응답으로 제공합니다. 기존 updater의 부트스트랩 호환을 위해 현재 안정판 패키지는 Vercel 정적 예외로 유지합니다.

## 3. 웹 운영 배포

- Vercel project: `observer_abangseladmin`
- Production deployment: `dpl_BwQr3u57vywWkcAsbgYYV54wLQof`
- Security source commit: `ba3ff9e954f03c34260f94bf1953350331a01c88`
- Source integrity commit: `1f6f890`
- 배포 방식: 검증한 Preview `dpl_H6CkkPK2HwGWcMUb2ywoz9GuFdR9`를 Production으로 승격
- 운영 확인: 홈페이지 `200`, v0.7.0.94 stable feed `200`, `/roulette-settings`와 `/api/native-roulette`는 기본 `404`

## 4. 적용된 HTTP 보안 조치

### 홈페이지 `/` CSP

- `default-src 'none'`을 기본값으로 사용합니다.
- 현재 인라인 스크립트 1개와 스타일 1개만 SHA-256 해시로 정확히 허용합니다.
- `unsafe-inline`과 `unsafe-eval`을 사용하지 않습니다.
- 인라인 이벤트 핸들러와 인라인 style 속성을 차단합니다.
- 스크립트·스타일·이미지·폰트·통신은 필요한 same-origin 범위만 허용합니다.
- frame, object, base URI를 차단하고 form action은 same-origin으로 제한합니다.
- `frame-ancestors 'none'`과 `upgrade-insecure-requests`를 적용합니다.

### 전 경로 공통 헤더

| 헤더 | 운영값 | 목적 |
|---|---|---|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` | HTTPS 강제 유지 |
| `X-Content-Type-Options` | `nosniff` | MIME 스니핑 차단 |
| `X-Frame-Options` | `DENY` | iframe 삽입 차단 |
| `Referrer-Policy` | `no-referrer` | 리퍼러 정보 전송 차단 |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | 브라우저 민감 권한 차단 |

HTTP 요청은 HTTPS로 `308` 전환됩니다. HSTS의 `preload` 토큰은 정책 의사 표시이며 브라우저 preload 목록 실제 등재 여부와는 별개입니다.

## 5. 검증과 회귀 방지

- 서버 Node 전체 테스트: `102/102 PASS`
- `homepage-csp.test.mjs`가 CSP 필수 지시어, 금지 토큰, 인라인 블록 개수와 SHA-256 일치를 고정합니다.
- `SOURCE_FILE_SHA256SUMS.txt`에 CSP 테스트와 변경된 `vercel.json` 해시를 반영했습니다.
- Production 승격 뒤 홈페이지의 CSP·HSTS·MIME·프레임·리퍼러·권한 제한 헤더를 실제 응답에서 재확인했습니다.
- 승격 직후 Vercel error 로그는 `0건`이었습니다.

## 6. 범위와 남은 관찰 항목

- 이번 신규 CSP는 홈페이지 `/`의 누락을 보완한 것입니다. 로그인·계정 페이지는 기존 별도 CSP 규칙을 유지합니다.
- `COOP`, `COEP`, `CORP`는 현재 미적용이며 일반 페이지의 필수 요건으로 간주하지 않습니다. 교차 출처 격리가 필요한 기능을 도입할 때 별도 검토합니다.
- 공개 정적 응답의 `Access-Control-Allow-Origin: *`는 현재 서비스 동작상 허용되지만, 민감 API 응답에 동일하게 노출되지 않는지는 보안 회귀 점검 범위로 계속 관리합니다.
