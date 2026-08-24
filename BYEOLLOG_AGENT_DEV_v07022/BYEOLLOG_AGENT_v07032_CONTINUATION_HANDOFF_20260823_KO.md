# 별록 에이전트 v0.7.0.32 자동 업데이트 인계

기준 시각: 2026-08-23 KST
최종 Agent: `0.7.0.32 / 0.7.0-public.30 / 공개판 30`

## 최종 산출물

- Tester ZIP: `DIST/byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64.zip`
- Tester ZIP SHA-256: `c731ac88caea6148612877bcb7b893d507133ab13bebd2bf4643c703e8d5f247`
- EXE SHA-256: `e889979e0233f08f01c8ef9b445666141373443bdd8b86e20c319d76c482dda9`
- 내부 `release-manifest.json` SHA-256: `165beea94cbb91375cceac5df3cd04a3b12f4c101e37f9b2d24b0fb66837c1c0`
- v0.7.0.31 산출물은 보안 검토 전 내부 중간본이며 공개·Preview·Production에 배포하지 않았다. 전달 금지.

## 사용자 설치 방식

v0.7.0.32는 자동 업데이트를 심는 최초 공개 설치판이다. 기존 사용자는 이번 한 번만 Tester ZIP을 새 폴더에 완전히 풀고 `INSTALL_AND_CHECK.cmd`를 실행해야 한다. 이후에는 시작 메뉴의 `별록 에이전트` 또는 `LAUNCH_BYEOLLOG.cmd`로 실행해야 자동 업데이트가 동작한다. 단독 `byeollog.exe` 실행은 관리형 설치 포인터를 우회하므로 자동 업데이트 대상이 아니다.

설치 루트는 `%LOCALAPPDATA%\Programs\ByeollogCollector`, 사용자 데이터는 `%LOCALAPPDATA%\ByeollogAgent`로 분리되어 있다. 업데이트는 사용자 로그인 프로필, 위플랩 WebView 프로필, OBS·마이크 설정, 규칙, SQLite, 업로드·ACK 상태를 삭제하거나 이동하지 않는다.

## 업데이트 동작

1. Launcher가 현재 버전의 manifest와 앱 SHA-256을 검증한다.
2. 현재 Agent를 정상 실행한다.
3. 별도 숨김 프로세스가 `--update-check`를 실행한다.
4. 고정 HTTPS feed의 RSA-PSS-SHA256 서명과 고정 공개키를 검증한다.
5. ZIP 크기·SHA-256, 내부 manifest SHA-256, 모든 파일 크기·SHA-256을 검증한다.
6. 새 불변 버전 폴더에 앱을 준비하고 실제 후보 EXE의 내장 버전·공개키 preflight를 통과시킨다.
7. 실행 중인 방송·수집·아봉·마이크는 건드리지 않고 다음 실행 포인터만 전환한다.
8. 다음 앱 실행부터 새 버전을 사용한다.

다운로드·서명·디스크·preflight 실패는 현재 Agent 실행을 막지 않는다. 오류 후 최소 15분이 지난 다음 앱 실행에서 재시도한다. 수동 롤백 시 문제가 있었던 정확한 버전은 `blockedVersion`으로 기록해 재설치를 막되 더 높은 수정판은 허용한다.

Updater protocol v1은 설치 루트의 Launcher·설치·롤백 도구 9개를 v0.7.0.32 바이트로 고정한다. 이후 자동 공개판은 버전 폴더의 앱만 갱신한다. Launcher 프로토콜 변경이 필요하면 새 수동 bootstrap 버전이 필요하다.

## 서명 신뢰점

- key ID: `rsa3072-69d28a1ef55f02f2`
- 알고리즘: RSA-3072 / RSA-PSS-SHA256
- Windows 인증서 저장소 지문: `7766F8636736FD395E5FE3CCB3BAA72DA1F43406`
- Subject: `CN=Byeollog Agent Offline Update Signing 2026`
- 개인키는 소스·ZIP·Vercel에 포함하지 않고 Windows CurrentUser 인증서 저장소에서만 사용했다.
- `New-AgentUpdateCatalog.ps1`은 Subject뿐 아니라 modulus·exponent·key ID가 Agent 고정 공개키와 정확히 같을 때만 서명한다.
- 다음 공개판 서명 전 암호화된 오프라인 PFX 백업을 별도 안전 매체에 만들어야 한다. 비밀번호 없는 개인키 내보내기는 금지한다.

Windows Authenticode 코드 서명은 이번 공급망 서명과 별개이며 사용자 요청대로 추후 진행한다. 현재 공개 EXE는 Authenticode 인증서 부재를 이유로 배포 차단하지 않는다.

## 운영 배포

- Vercel 프로젝트: `observer_abangseladmin`
- 검증 Preview: `dpl_GT4WtvbzLxABNWD3jrsDgT2ndZWQ`
- Production: `dpl_8799JdD5Yo3JyaqwwTyZvwM6V1pt`, READY, Node.js 22.x, 12 Functions
- Feed: `https://byeollog.com/agent-updates/stable/win-x64.json`
- ZIP: `https://byeollog.com/agent-updates/releases/0.7.0.32/byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64.zip`
- Feed SHA-256: `ad3e43b20ee996bef6ed7a3590013af7c7e901dbd2cbc16b2d7641f0369fcf56`
- Feed는 60초 CDN 재검증, ZIP은 버전 고정 경로의 1년 immutable 캐시다.
- Production에서 feed HTTP 200·조건부 304, ZIP HTTP 200, 72,902,454 bytes와 SHA-256 일치를 직접 확인했다.
- Supabase, 운영 DB, Auth, Storage, DNS, 도메인, 결제 설정은 변경하지 않았다.

## 검증 결과

- AgentStore: 310 assertions 통과
- Node Agent 계약: 97/97 통과
- Server 테스트: 10/10 통과
- Server JavaScript 구문: 27개 통과
- self-contained win-x64 publish 성공
- manifest v2 / VerifyPackage / Tester ZIP 왕복 무결성 통과
- Preview feed와 ZIP이 로컬 서명 원본과 바이트 단위 일치
- Production feed와 ZIP이 Preview·로컬 서명 원본과 바이트 단위 일치
- 후보 EXE는 서명 버전이 내장 버전과 다르면 preflight 종료 코드 3으로 거부한다.

## 다음 공개판 절차

1. v0.7.0.33 이상 새 버전 번호를 사용하고 동일 버전 바이트를 덮어쓰지 않는다.
2. protocol v1 설치 루트 9개 파일을 v0.7.0.32와 바이트 동일하게 유지한다.
3. Agent 테스트·publish·VerifyPackage·ZIP 왕복을 모두 통과한다.
4. `New-AgentUpdateCatalog.ps1`로 새 immutable ZIP URL·크기·해시를 서명한다.
5. Vercel Preview에 배포하고 feed 서명, full ZIP 다운로드 SHA-256, 기존 홈페이지/API를 확인한다.
6. 같은 Preview를 Production으로 promote한다.
7. Production alias에서 리다이렉트 없는 feed/ZIP 200과 전체 SHA-256을 다시 확인한다.

현재 ZIP은 약 69.5 MiB로 Vercel 단일 정적 파일 한도 안이지만 여유가 크지 않다. 향후 100 MiB에 접근하면 사용자의 별도 Storage/비용 승인을 받은 뒤 Vercel Public Blob 등 immutable 대용량 저장소로 옮긴다. 자동 버전 폴더 정리 정책은 아직 없으므로 당분간 current·previous 복구성을 우선한다.
