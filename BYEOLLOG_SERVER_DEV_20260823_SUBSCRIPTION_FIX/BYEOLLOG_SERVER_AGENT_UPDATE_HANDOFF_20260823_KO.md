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

릴리스 ZIP은 버전별 immutable 경로에 추가하고 기존 바이트를 덮어쓰지 않는다. 새 feed를 오프라인 주 키로 서명한 뒤 Preview에서 전체 ZIP을 다운로드해 서명된 크기·SHA-256과 대조한다. Preview를 통과한 동일 배포만 Production으로 promote한다.

현재 ZIP은 Vercel 단일 정적 파일 한도 안이지만 약 69.5 MiB다. 이후 100 MiB에 접근하면 Storage/비용에 대한 사용자 별도 승인 후 immutable 대용량 저장소 이전을 검토한다.

`.vercel/.env.*`, `node_modules`, 빌드 출력과 개인키는 서버 체크포인트에 포함하지 않는다. `SOURCE_FILE_SHA256SUMS.txt`가 체크포인트 파일의 canonical SHA-256 목록이다.
