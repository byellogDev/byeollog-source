# 배포와 복구

## 배포 전

- 대상 앱, Git 커밋, 현재 운영 배포 ID와 복구 대상을 로컬 운영 기록에 저장합니다.
- `.vercel/project.json`의 프로젝트 연결을 현재 플랫폼 정보와 대조합니다. 다른 폴더의 연결 파일을 재사용하지 않습니다.
- `npm run verify:source`, `npm test`, `npm run build:web` 및 정확한 Git 파일 목록의 게시 전 검사를 실행합니다.
- 환경변수의 **이름·대상 프로젝트·환경**을 확인합니다. 값은 기록·공개하지 않습니다.

## 후보 검증

해당 앱 디렉터리에서 생산 환경 설정을 사용하는 후보를 만듭니다.

```sh
vercel deploy --prod --skip-domain
vercel inspect <candidate-url>
vercel curl /login --deployment <candidate-url>
```

`--skip-domain`만으로 모든 주소가 기존 배포에 고정된다고 가정하지 않습니다. 이번 실행에서 팀 이름이 포함된 시스템 alias가 후보를 가리키는 것을 확인했습니다. 별도 프로젝트·명시적 alias 복구 등으로 필요한 격리 수준을 확보하고, 후보 전후 실제 alias를 조회합니다. 운영 사용자 도메인의 이전·이후 배포 ID를 반드시 대조합니다.

Deployment Protection을 해제하지 않습니다. 보호된 후보 API는 승인된 플랫폼 검증 경로로 호출합니다. 내부 런타임을 연동하는 경우 최종 후보의 upstream 설정을 확인하고, 임시 후보 URL을 사용한 통합 시험용 배포를 운영으로 승격하지 않습니다.

### 실행 지역과 환경 설정 확인

- `vercel.json`에 지역이 있어도 실제 배포에 반영됐다고 가정하지 않습니다. 프로젝트의 `resourceConfig.functionDefaultRegions`와 후보 및 승격 후 배포 API의 `regions`를 대조합니다.
- REST로 후보를 만들 때는 지역을 요청에 명시합니다. `deploymentId`로 소스를 재사용해도 Preview의 운영 인증값 상속을 가정하지 않습니다. 환경변수 이름과 적용 범위, 실제 응답을 확인하고 누락된 후보는 승격하지 않습니다.
- 플랫폼에서 읽은 배포 메타데이터는 비공개 `.local`에 보관하고 다음 검사를 후보와 최종 운영 배포에 각각 실행합니다. 실패하면 승격하지 않으며, 승격 후 실패하면 직전 배포로 복구합니다.

```sh
node tools/verify-deployment-region.mjs apps/web/vercel.json .local/<작업>/web-deployment.json
node tools/verify-deployment-region.mjs apps/admin-runtime/vercel.json .local/<작업>/admin-runtime-deployment.json
```

- 소스 파일 해시·라우팅·권한 경계를 기존 운영과 비교합니다. 지역만 바꾸는 작업에 미완료 기능 변경을 섞지 않습니다. 비인증 응답 일치는 로그인 후 기능이나 성능 검증을 대신하지 않습니다.

## 반영

검증한 **동일 후보**를 `vercel promote <candidate-url>`로 승격합니다. 반영 후 화면·CSS/JS·API 상태를 재조회하고 이전 기준과 비교합니다. 단순 빌드 성공으로 완료 처리하지 않습니다.

iwinv 수집기는 대기 전송과 실패 보관 건수를 확인하고 기존 환경·볼륨·프로세스 한도를 보존합니다. 변경 파일만 포함한 이미지를 사전 검사하고, 교체 후 연결·큐·로그 상태를 확인합니다. 재시작 시 연결 중인 방송은 잠시 재연결될 수 있습니다. 2026-10-05 NCP에서 이전했으며 [현재 운영·이전 절차](../operations/iwinv/README.md)를 따릅니다.

## 복구

- Vercel: 기록한 직전 배포를 승격하고 실제 도메인·API를 다시 확인합니다.
- iwinv 수집기: 직전 이미지와 변경 전 파일로 복구하고 동일 환경·볼륨으로 기동합니다. NCP 자원은 [2026-10-06 반납](releases/2026-10-06-ncp-retirement.md)했으므로 기존 서버로 즉시 복귀할 수 없습니다. 호스트 재구축이 필요하면 보존 자료와 최신 큐·처리 이력으로 별도 복구하며 두 수집 호스트를 동시에 쓰기 모드로 시작하지 않습니다.
- DB: 각 마이그레이션의 영향과 되돌리기 가능 여부를 사전에 기록합니다. Git revert만으로 이미 적용된 SQL·데이터 변경이 복구되지는 않습니다.
- Agent: 서명 피드와 호환성·복구 자산을 보존합니다. 설치된 Agent에는 낮은 sequence를 강제 적용하지 않으며, 필요한 경우 더 높은 버전의 복구 패키지를 별도로 검증합니다.

비공개 운영 증거에는 정확한 배포 ID·해시·시각을 남기고, 버전 문서에는 민감정보를 제거한 검증 결과를 남깁니다.
