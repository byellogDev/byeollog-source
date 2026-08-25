# 별록 Agent 자동 업데이트 서버 인계

기준: 2026-08-23 KST
서버 소스: `0.6.3-g3a.13 / 0.6.3.25-g3a-agent-v07046`

## 운영 상태

- Vercel 프로젝트: `observer_abangseladmin`
- 검증 Preview: `dpl_HZFT146D7beDdCULupPkPmRpXJwc`
- 승격 Production: `dpl_HxrWM2k6dfdd8YZC37Z5E28M9tB5`
- Production 상태: READY, Node.js 22.x, 12 Functions
- Production aliases: `byeollog.com`, `www.byeollog.com`, `observer_abangseladmin.vercel.app`
- Supabase·DB·Auth·Storage·DNS·결제 변경 없음

## 공개 업데이트 파일

- Feed: `agent-updates/stable/win-x64.json`
- Feed URL: `https://byeollog.com/agent-updates/stable/win-x64.json`
- Feed SHA-256: `f5ebb9719fb6ffaa33781b58e6fc5b79866f99049b4e13b8657c5cc0fd1831b8`
- Feed version / sequence: `0.7.0.46 / 7046`
- Feed key ID: `rsa3072-cc1fb719f3a63774`
- Agent ZIP: `agent-updates/releases/0.7.0.46/byeollog_agent_v07046_OFFICIAL_LOGO_STARTUP_WIN_X64.zip`
- Agent ZIP bytes: `72,926,401`
- Agent ZIP SHA-256: `0707de87f767ca109cc76636ef6f70a9aedf82db9aced0f3776459a8a150358f`
- signed inner manifest SHA-256: `a2241df867144371188b891fd3950a0f1d784dc8cd98f8e194c7bc98f36e1aba`

Feed는 RSA-PSS-SHA256 주 업데이트키로 서명했다. 개인키·PFX·복구 암호는 서버 소스와 Vercel 배포에 포함하지 않는다.

## 변경 및 검증

- v0.7.0.45는 사용자 거부 디자인이라 운영 피드에 한 번도 배포하지 않았다.
- v0.7.0.46은 레거시 꼬리 별 심볼을 제거하고 공식 별록 로고를 HTML 시작 화면과 네이티브 대체 화면 양쪽에 적용한다.
- Agent Node 계약 `122/122`, AgentStore `318 assertions` 통과.
- 서버 Node 계약 `19/19`, JS/MJS 구문 검사 통과.
- Preview에서 feed와 전체 ZIP을 실제 다운로드해 로컬 서명 원본과 바이트·SHA-256이 일치함을 확인했다.
- 검증된 동일 Preview를 Production으로 promote했다.
- Production alias에서도 feed와 전체 ZIP을 다시 다운로드해 동일성을 확인했다.
- 설치된 v0.7.0.44의 자체 `--update-check`를 실행해 v0.7.0.46 설치, `current.json` 전환, `previous.json=0.7.0.44`, 새 EXE preflight exit 0을 확인했다.
- 업데이트 상태는 `installed_next_launch`, highest release sequence `7046`으로 기록됐다.

## 다음 버전 규칙

릴리스 ZIP과 provenance는 로컬 `agent-updates/releases/<version>/`에 추가하되, ZIP은 `npm run release:assets -- --version <version>`으로 공개 `byellogDev/byeollog-releases` GitHub Release의 `agent-v<version>` 태그에 업로드한다. 업로더는 기존 자산을 덮어쓰거나 삭제하지 않고 원격 전체 바이트를 다시 읽어 SHA-256을 대조한다. provenance JSON은 수 KB이므로 기존 Vercel 소스에 유지한다. 새 feed를 오프라인 주 키로 서명한 뒤 Preview의 `byeollog.com` 호환 경로가 GitHub Release로 전달되는지 확인하고 전체 ZIP 크기·SHA-256을 대조한다. Preview를 통과한 동일 배포만 Production으로 promote한다.

Vercel 애플리케이션 배포에서는 `.vercelignore`로 `agent-updates/releases/**/*.zip`을 제외한다. 공개 ZIP 호환 URL `/agent-updates/releases/<version>/*.zip`은 공개 GitHub Release 자산으로 307 전달되므로 기존 signed feed URL 계약은 바꾸지 않는다. GitHub Release 태그와 버전 ZIP은 절대 덮어쓰지 않는다.

공개 GitHub Release 저장소에는 전체 버전 이력을 보존한다. 새 버전은 먼저 새 태그에 업로드하고 전체 원격 SHA-256을 검증한 뒤 feed를 전환한다. 같은 태그·파일명의 교체는 금지하며 수정이 필요하면 더 높은 새 Agent 버전으로 발행한다.

`.vercel/.env.*`, `node_modules`, 빌드 출력과 개인키는 서버 체크포인트에 포함하지 않는다. `SOURCE_FILE_SHA256SUMS.txt`가 체크포인트 파일의 canonical SHA-256 목록이다.
