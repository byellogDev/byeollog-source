# 변경과 PR 절차

이 저장소는 웹·수집기·Windows Agent를 함께 관리합니다. 구현에 앞서 [AGENTS.md](AGENTS.md), [설계](docs/ARCHITECTURE.md), [현재 상태](docs/PROJECT_STATUS.md)를 확인합니다.

1. `git fetch origin` 후 `origin/main`에서 목적별 `codex/<topic>` 브랜치를 만듭니다. 작업 중인 다른 브랜치와 미완료 변경을 보존합니다.
2. 오류 수정은 가능한 경우 실패 조건을 먼저 재현합니다. 관련 앱만 수정하고 의미 있는 회귀 검사를 추가합니다.
3. 변경 파일을 명시해 stage하고 `git diff --cached`를 확인합니다. `git add -A`로 연구 자료나 임시 파일을 함께 넣지 않습니다.
4. `npm run verify:source`, `node tools/scan-publication.mjs --tracked` 및 변경에 필요한 검사를 실행합니다. 주요 작업은 릴리스 문서·CHANGELOG·일일 작업 기록을 함께 갱신합니다.
5. PR의 base를 `main`으로 설정하고 문제·변경 후 동작·검사·미검증·배포 여부를 기록합니다. 다른 기능을 이어 붙이기 전에 기존 PR을 마무리합니다.
6. 최신 head SHA의 `verify` 성공, diff, 충돌, 검토 의견을 확인하고 승인된 범위만 병합합니다. base 변경 시 병합 예정 트리가 검사 대상과 같은지 확인하고, 다르면 새 CI를 실행합니다.
7. 기존 커밋을 보존하는 merge commit을 사용합니다. 원격 SHA와 main CI를 확인한 뒤 병합된 작업 브랜치를 정리합니다. 고유 커밋이 있는 브랜치는 삭제하지 않거나 먼저 명시적인 보존 태그를 만듭니다.
8. 운영 배포는 [배포 절차](docs/DEPLOYMENT.md)에 따라 별도로 수행합니다. 병합·빌드 성공은 배포 완료가 아닙니다.

## 이력과 검증의 정직성

- 기존 커밋의 작성자·작성 시각·태그를 바꾸거나 force-push하지 않습니다.
- 실제 동료 리뷰가 없으면 있었다고 표시하지 않습니다. 자동 검사, 코드 검토, 실제 사용자 확인을 구분합니다.
- 연구 실패·보류 기록을 삭제해 성공한 작업만 남기지 않습니다. 후속 채택 또는 폐기는 링크로 연결합니다.
- 현행 GitHub 요금제에서는 비공개 저장소의 브랜치 보호를 사용할 수 없습니다(2026-10-23 API 확인). 이 문서의 절차는 작업 규칙이며 서버 강제 차단이 아닙니다. 요금제 변경이 승인되면 `verify` 필수 검사, 직접 push·force-push·삭제 제한을 별도로 적용하고 확인합니다.

## 버전 규칙

- Agent: `agent-v<4자리 버전>` (예: `agent-v1.0.0.60`). 소스·설치 자산 릴리스를 상호 연결합니다.
- 운영 변경: `ops-YYYY.MM.DD-<topic>`; 문서·정리: `maintenance-YYYY.MM.DD-<topic>`.
- 연구·후보: `research-...` / `candidate-...`, GitHub prerelease로 표시합니다.
- 과거 태그는 이름이 달라도 보존합니다. [대응표](docs/releases/AGENT_VERSIONS.md)로 추적합니다.
- 기록 보완·유지보수 릴리스는 제품 Latest를 교체하지 않습니다. 새로운 Agent 버전 없이 피드나 설치 자산을 바꾸지 않습니다.
- 루트 `package.json`의 `2026.9.23`은 통합 검사 환경의 기준 버전입니다. 사용자에게 배포되는 Agent 버전과 같다고 해석하지 않습니다.
