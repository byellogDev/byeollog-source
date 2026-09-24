# 별록 · Byeollog

방송 후원을 수집하고, 스트리머의 업무와 방송 화면으로 연결하는 운영 서비스입니다. 웹 대시보드, SOOP 수집기, Windows 풍벽지 Agent, OBS용 화면, 백업을 함께 관리합니다.

> 이 저장소는 **2026-09-23 운영 안정본을 출발점으로 통합한 개발 기준**입니다. 배포 대상은 역할별로 분리되어 있습니다. 이력 보존용 폴더나 개인 PC의 임시 사본에서 배포하지 않습니다.

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
operations/ncp/        운영 구성·보관 정책
tests/                 통합 기준에서 실행하는 회귀 검사
test-support/          검사 전용 과거 기능 자료
tools/                 소스 일치·게시 전 검사
docs/                  설계, 배포 절차, 버전별 기록
```

## 시작하기

### 별록↔마인크래프트 연결 모듈

2026-09-24부터 계정 연동·서버 인증·후원 전달 등 연결 모듈은 이 저장소에서 직접 개발·검증·배포합니다. 마인크래프트 프로젝트는 게임 서버 내부 기능을 담당합니다. [담당 범위와 검증 상태](docs/integrations/minecraft-candidate-review.md)를 참고하세요.

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

## 이번 버전의 확인 결과

- JavaScript 회귀 검사 **716건 통과**, 실패·건너뜀 0건.
- 기준 소스 **1,183개** 대조, 성능 수정 **3개 파일**만 의도적으로 변경.
- Windows Agent 저장·복구·업데이트 계약 검사 실행 성공.
- 웹 후보의 9개 공개 화면·API 응답을 운영과 비교해 상태·본문 해시 일치 확인.
- 반영 후 실제 백업 대상 조회 및 수집기 상태 확인.

이 결과는 가입, 계정 재연결, OBS 화면, 실제 백업 복원을 이번 릴리스에서 모두 다시 조작했다는 뜻이 아닙니다. 확인 방법과 한계는 [릴리스 기록](docs/releases/2026-09-23.md)에 구분합니다.

## 문서

- [설계와 권한 경계](docs/ARCHITECTURE.md)
- [개발·변경 전달 절차](docs/DEVELOPMENT.md)
- [후보 검증·배포·복구](docs/DEPLOYMENT.md)
- [버전 이력](CHANGELOG.md) · [새 릴리스 작성 양식](docs/templates/release.md)
- [기술 사례: 운영 소스 통합과 반복 장애 개선](docs/CASE_STUDY.md)
- [보안과 공개 범위](SECURITY.md)

저장소 공개 전환은 별도 검토 대상입니다. 키, 회원 데이터, 운영 로그, 백업 원본, 로컬 복구 사본은 커밋하지 않습니다.
