# 별록 보안 항목 1·3 운영 인계

기준 시각: 2026-08-23 10:14 KST

## 완료 범위

1. 공개 `SECURITY DEFINER` RPC 2개 정리
   - `public.get_public_workspace(text)`
   - `public.get_public_bangsel(text, text)`
2. `RLS enabled, no policy` 테이블 27개 정리
3. Auth·Storage·DNS·도메인·결제·비밀키 회전은 변경하지 않음

## 최종 구조

- 시청자 공개 페이지는 Supabase URL·publishable key를 더 이상 포함하지 않는다.
- 공개 페이지는 같은 도메인의 고정 작업만 호출한다.
  - `POST /api/data?operation=public-workspace`
  - `POST /api/data?operation=public-bangsel`
- 기존 12개 Vercel Function 수를 늘리지 않고 `api/data.js`에 읽기 전용 작업을 병합했다.
- 두 RPC는 `SECURITY INVOKER`이며 `anon`·`authenticated` 실행권이 없다.
- Vercel 서버의 `service_role`만 두 RPC를 실행한다.
- 서버 전용 27개 테이블에는 `anon`·`authenticated` 대상의 명시적 `false` 정책을 추가했다. 서비스 역할과 기존 서버 처리에는 영향을 주지 않는다.

## 무중단 배포 순서와 식별자

1. Supabase `20260823010650 grant_public_rpc_service_role`
2. Vercel Preview `dpl_2tLBse5E7MCavzgwGdz5vyvF4ZzK`
3. Preview 검증 후 Production 승격 `dpl_7oP2qeVUeDLnDhcExr7ufr5DzAF5`
4. Production 공개 조회 정상 확인
5. Supabase `20260823011107 harden_public_rpc_and_rls`
6. PostgREST·공개 페이지·Security Advisor 사후 검증

## 검증 결과

- Node 회귀 테스트: 19/19 PASS
- 공개 RPC 중 `SECURITY DEFINER`: 0개
- `anon`/`authenticated` RPC 실행권: 없음
- `service_role` RPC 실행권: 있음
- 명시적 RLS 정책: 27개
- 이전 공개키를 이용한 직접 PostgREST RPC: HTTP 401
- Production 공개 워크스페이스: 1행, 응답 필드 3개 유지
- Production 공개 업보: 16행, 응답 필드 5개 유지
- 잘못된 workspace 입력: HTTP 400
- Agent 자동 업데이트 피드: `0.7.0.42` 유지
- 최근 Production error 로그: 0건
- Supabase Security Advisor: 기존 32건 중 Auth 경고 1건만 남음

남은 경고는 `auth_leaked_password_protection`이다. 이번 승인에서 Auth 변경은 제외됐으므로 건드리지 않았다. 참고: https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection

## 소스와 migration

- `api/data.js`
- `bangsel_public_workspace_isolation.html`
- `test/security-hardening.test.mjs`
- `supabase/migrations/20260823010650_grant_public_rpc_service_role.sql`
- `supabase/migrations/20260823011107_harden_public_rpc_and_rls.sql`
- `SECURITY_HARDENING_DEPLOYMENT_MANIFEST_20260823.json`
- `SOURCE_FILE_SHA256SUMS.txt`

## 긴급 롤백 주의

DB에서 브라우저 RPC 실행권을 닫았으므로 Vercel만 구버전으로 롤백하면 구 공개 페이지가 실패한다. 긴급 롤백은 반드시 다음 순서로 한다.

1. DB에서 두 함수를 다시 `SECURITY DEFINER`로 바꾸고 `anon`·`authenticated` 실행권을 복구한다.
2. 그 다음 Vercel을 직전 Production으로 롤백한다.
3. 공개 페이지와 직접 RPC를 재검증한다.

현재 배포가 정상일 때는 롤백하지 않는다.
