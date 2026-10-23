# 별록 · Byeollog

[![Verify canonical source](https://github.com/byellogDev/byeollog/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/byellogDev/byeollog/actions/workflows/verify.yml)

방송 후원을 수집하고, 스트리머의 업무와 방송 화면으로 연결하는 운영 서비스입니다. 웹 대시보드, SOOP 수집기, Windows 풍벽지 Agent, OBS용 화면, 백업을 함께 관리합니다.

> `main`은 검증한 변경을 통합하는 개발 기준입니다. 실제 운영 버전은 구성요소별 릴리스 기록과 배포 증거로 확인합니다. Git 병합과 운영 배포는 별도 절차입니다. 저장소는 2026-09-23 운영 안정본에서 출발했으며, 기존 커밋·태그를 보존합니다.

## 현재 버전과 검토 순서

- Windows Agent: **[1.0.0.60](https://github.com/byellogDev/byeollog/releases/tag/agent-v1.0.0.60)** — 2026-10-22 운영 반영. [변경·검증·남은 확인](docs/releases/2026-10-22-agent-10060.md).
- [구성요소별 운영·연구 상태](docs/PROJECT_STATUS.md)에서 제품 기능과 미완성 범위를 확인합니다.
- [설계와 권한 경계](docs/ARCHITECTURE.md) → [변경 이력](CHANGELOG.md) → [PR 목록](https://github.com/byellogDev/byeollog/pulls?q=is%3Apr) → [CI 실행](https://github.com/byellogDev/byeollog/actions/workflows/verify.yml) 순으로 구현과 검증 근거를 확인할 수 있습니다.
- [Git 관리 정리 기록](docs/releases/2026-10-23-repository-governance.md)은 장기 PR 누적 문제와 개선 내용, 브랜치 보호의 제한을 설명합니다. 과거 작업을 소규모 PR로 검토한 것처럼 이력을 재작성하지 않았습니다.

## 서비스가 해결하는 문제

| 영역 | 기능 |
| --- | --- |
| 후원 수집 | SOOP 연결, 후원 이벤트 전달, 재연결과 대기 전송 관리 |
| 업무 관리 | 업보 분류·처리 및 이력, 스트리머별 데이터 관리 |
| 방송 화면 | 풍벽지, Windows Agent와 OBS 연결, 채팅창 CSS 꾸미기 |
| 계정과 운영 | 계정 연결·가입, 관리자 진단, 권한 분리 |
| 데이터 보호 | 별도 권한을 사용하는 백업 워커와 독립 보관 |

## 저장소 지도

```text
apps/
  web/                 사용자 웹·API 진입점
  admin-runtime/       인증이 필요한 관리 기능
  collector-runtime/   수집 이벤트 처리
  public-runtime/      제한된 공개 조회
  backup-worker/       백업 전용 권한
  windows-agent/       Windows 풍벽지 프로그램
services/soop-gateway/  지속 실행되는 SOOP 연결 수집기
supabase/              확인한 운영 마이그레이션·Edge Function 원본
operations/ncp/        이전 호스트의 보관용 구성·절차
operations/iwinv/      현행 수집 호스트 이전·복구와 연구 부팅 보호
tests/                 통합 기준에서 실행하는 회귀 검사
test-support/          검사 전용 과거 기능 자료
tools/                 소스 일치·게시 전 검사
docs/                  설계, 배포 절차, 버전별 기록
```

## 시작하기

### 별록↔마인크래프트 연결 모듈

계정 연동·서버 인증은 [부분 운영 반영 기록](docs/releases/2026-09-24-minecraft-production.md)이 있습니다. **후원→게임 동작 전달은 미구현**입니다. 마인크래프트 프로젝트는 게임 서버 내부 기능을 담당합니다.

Node.js 22와 npm이 필요합니다. Windows Agent 검사는 Windows와 .NET 8을 사용합니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:source
npm test
npm run build:web
npm run scan:publication
```

```powershell
dotnet build apps/windows-agent/HurogiCollector.csproj -c Release
dotnet run --project apps/windows-agent/AgentStoreTests/AgentStoreTests.csproj -c Release
```

각 배포 앱은 자체 `package.json`과 lockfile을 사용합니다. 통합 첫 단계에서는 의존성을 끌어올리거나 공통 라이브러리로 추출하지 않았습니다. 루트 설치는 회귀 검사·웹 빌드용이며, 운영 배포는 해당 앱 폴더에서 수행합니다.

## 검증 근거 읽기

CI는 소스 manifest·게시 전 검사, Node 회귀, DB 계약, 웹 빌드, Windows Agent 빌드·저장·UI 검사를 실행합니다. 정확한 실행 결과는 위 CI 링크에서 해당 커밋으로 확인합니다. 자동 검사 통과가 고객 PC·실방송 동작 전체를 보증하지는 않습니다.

최신 Agent 1.0.0.60은 저장 경로 오류 재현, 1,332 assertions, UI·패키지·서명된 업데이트 검사와 운영 다운로드 대조를 기록했습니다. 고객 PC에서 같은 문제가 해결됐는지는 별도 확인 대상입니다. 9월 23일의 716건 검사 등 초기 결과는 [당시 기록](docs/releases/2026-09-23.md)에만 적용됩니다.

## 문서

- [설계와 권한 경계](docs/ARCHITECTURE.md)
- [개발·변경 전달 절차](docs/DEVELOPMENT.md)
- [기여·PR 작성 절차](CONTRIBUTING.md) · [Agent 소스/설치 파일 버전 대응표](docs/releases/AGENT_VERSIONS.md)
- [후보 검증·배포·복구](docs/DEPLOYMENT.md)
- [릴리스 문서 목록](docs/releases/README.md) · [버전 이력](CHANGELOG.md) · [새 릴리스 작성 양식](docs/templates/release.md)
- [기술 사례: 운영 소스 통합과 반복 장애 개선](docs/CASE_STUDY.md)
- [보안과 공개 범위](SECURITY.md)

저장소 공개 전환은 별도 검토 대상입니다. 키, 회원 데이터, 운영 로그, 백업 원본, 로컬 복구 사본은 커밋하지 않습니다.
