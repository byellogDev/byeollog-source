# 별록 · Byeollog

[![Verify public source](https://github.com/byellogDev/byeollog-source/actions/workflows/verify.yml/badge.svg?branch=main)](https://github.com/byellogDev/byeollog-source/actions/workflows/verify.yml)

별록은 SOOP 방송의 후원 기록, 룰렛으로 발생한 수행 항목(업보), 방송용 풍벽지를 관리하는 서비스입니다. 웹 대시보드와 수집 서버, Windows Agent를 함께 개발·운영합니다.

## 주요 기능

| 기능 | 제공하는 작업 |
| --- | --- |
| 후원 수집·통계 | SOOP 후원 이벤트 수집, 후원자·날짜·수량별 조회, 방송별 통계와 리포트 |
| 업보 자동 수집 | 등록한 후원알림 오버레이의 룰렛 결과를 기준으로 업보 분류·등록, 남은 수량과 완료 상태 관리 |
| 이벤트명 관리 | 룰렛을 따로 등록하지 않아도 `10월 330개`처럼 이벤트명을 자동 생성하고, 필요할 때 이름을 사전 지정 |
| 풍벽지 편집 | 후원 카드 배치·크기·글꼴·색상 조절, 개별 숨김·복원, 묶음 해제와 백두산 배치 |
| 방송 화면 연결 | Windows Agent에서 풍벽지를 동기화하고, OBS 등 방송 프로그램의 브라우저 소스로 표시 |
| 계정·운영 관리 | 스트리머별 데이터와 권한 분리, 수집 상태 진단, 별도 권한의 백업 워커 |

## 전체 구조

후원 기록과 룰렛 결과는 용도에 따라 다른 경로로 처리합니다.

- **SOOP 수집기 → 후원 기록·통계·풍벽지:** 지속 연결, 재연결, 전송 대기 처리를 담당합니다.
- **후원알림 오버레이 → 업보 수집:** 사용자가 주소를 등록하고 수집을 켜면, 오버레이 결과를 기준으로 업보를 처리합니다. 채팅에 결과가 표시되는지에 의존하지 않습니다.
- **웹 대시보드 → 관리·조회:** 후원 내역과 업보를 조회하고, 수집·분류·이벤트명을 설정합니다.
- **Windows Agent → 방송용 풍벽지:** 로컬 배치 편집과 방송 화면 출력을 담당합니다.

웹 진입점, 관리 API, 수집 API, 공개 조회, 백업은 권한 경계를 분리합니다. 현행 수집 호스트는 iwinv이며, NCP 구성은 이전 기록으로 남아 있습니다. 구성요소별 운영·연구 범위는 [현재 상태](docs/PROJECT_STATUS.md)에서 확인할 수 있습니다.

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

## 현재 버전과 개발 기록

- Windows Agent: **[1.0.0.60](https://github.com/byellogDev/byeollog-releases/releases/tag/agent-v1.0.0.60)** — 2026-10-22 운영 반영. [변경·검증·남은 확인](docs/releases/2026-10-22-agent-10060.md).
- [구성요소별 운영·연구 상태](docs/PROJECT_STATUS.md)에서 제품 기능과 미완성 범위를 확인합니다.
- [설계와 권한 경계](docs/ARCHITECTURE.md), [변경 이력](CHANGELOG.md), [커밋 이력](https://github.com/byellogDev/byeollog-source/commits/main/) · [공개 후 PR 목록](https://github.com/byellogDev/byeollog-source/pulls?q=is%3Apr), [CI 실행](https://github.com/byellogDev/byeollog-source/actions/workflows/verify.yml)에 구현과 검증 근거를 기록합니다.
- [Git 관리 정리 기록](docs/releases/2026-10-23-repository-governance.md)은 장기 PR 누적 문제와 개선 내용, 브랜치 보호의 제한을 설명합니다. 과거 작업을 소규모 PR로 검토한 것처럼 이력을 재작성하지 않았습니다.

`main`은 검증한 변경을 통합하는 개발 기준이며, 운영 배포와는 별도입니다. 현재 통합 구조는 2026-09-23 운영 안정본을 기준으로 정리했고, 이전 개발 이력도 보존했습니다.

## 공개 범위

실제 개발 이력을 보존한 공개 소스 사본입니다. 계정 식별정보와 개인 연락처를 익명화하고, 권한이 확인되지 않은 자산은 제외·대체했습니다. [공개 범위·이력 대응·검사 제한](docs/public-source/README.md)을 먼저 확인하세요. 운영 원본의 커밋·태그는 비공개 저장소에서 그대로 보존합니다.

## 개발 환경과 검증

Node.js 22와 npm이 필요합니다. Windows Agent 검사는 Windows와 .NET 8을 사용합니다.

### 웹·서버 소스 검사와 빌드

저장소 루트에서 실행합니다.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run verify:source
npm run test:public
npm run build:web
npm run scan:publication
```

### Windows Agent

```powershell
dotnet build apps/windows-agent/HurogiCollector.csproj -c Release
dotnet run --project tools/agent-ui-tests/AgentUiTests.csproj -c Release
```

각 앱은 자체 `package.json`과 lockfile을 사용합니다. 루트 설치는 회귀 검사·웹 빌드용입니다. 공개 사본에는 운영 자격증명이 없으며, 이 폴더에서 운영 배포나 운영 DB 마이그레이션을 실행하지 않습니다.

## 검증 근거 읽기

공개 CI는 공개 소스 manifest·게시 전 검사, 공개 범위의 Node 회귀, DB 계약, 웹 빌드, Windows Agent 빌드·UI 검사를 실행합니다. 원본 자산을 요구하는 검사 제외 목록은 공개 범위 문서에 명시합니다. 정확한 실행 결과는 위 CI 링크에서 해당 커밋으로 확인합니다. 자동 검사 통과가 고객 PC·실방송 동작 전체를 보증하지는 않습니다.

최신 Agent 1.0.0.60은 저장 경로 오류 재현, 1,332 assertions, UI·패키지·서명된 업데이트 검사와 운영 다운로드 대조를 기록했습니다. 고객 PC에서 같은 문제가 해결됐는지는 별도 확인 대상입니다. 9월 23일의 716건 검사 등 초기 결과는 [당시 기록](docs/releases/2026-09-23.md)에만 적용됩니다.

## 확장 기능: 마인크래프트 연결

계정 연동·서버 인증은 [부분 운영 반영 기록](docs/releases/2026-09-24-minecraft-production.md)이 있습니다. **후원→게임 동작 전달은 미구현**입니다. 마인크래프트 프로젝트는 게임 서버 내부 기능을 담당합니다.

이 모듈은 별록의 확장 기능이며, 위의 개발·검사 명령은 별록 프로젝트 전체에 적용됩니다.

## 문서

- [설계와 권한 경계](docs/ARCHITECTURE.md)
- [개발·변경 전달 절차](docs/DEVELOPMENT.md)
- [기여·PR 작성 절차](CONTRIBUTING.md) · [Agent 소스/설치 파일 버전 대응표](docs/releases/AGENT_VERSIONS.md)
- [후보 검증·배포·복구](docs/DEPLOYMENT.md)
- [릴리스 문서 목록](docs/releases/README.md) · [버전 이력](CHANGELOG.md) · [새 릴리스 작성 양식](docs/templates/release.md)
- [기술 사례: 운영 소스 통합과 반복 장애 개선](docs/CASE_STUDY.md)
- [보안과 공개 범위](SECURITY.md)

공개 사본의 갱신에도 전체 이력 검토가 필요합니다. 키, 회원 데이터, 운영 로그, 백업 원본, 로컬 복구 사본은 커밋하지 않습니다.
