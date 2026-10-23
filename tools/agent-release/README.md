# Agent 패키지 검증과 서명

기존 설치 프로토콜의 검증 도구를 정식 소스 트리로 옮겼습니다. 프로그램은 `apps/windows-agent`에서 빌드합니다. 과거 개발 폴더의 실행 파일을 배포하지 않습니다.

1. 현재 공개 배포의 설치 루트 파일을 해시로 확인하고 보존합니다.
2. 새 실행 파일에 `Test-ReleaseExecutable.ps1`을 실행합니다.
3. `New-ReleaseManifest.ps1`과 `Test-UpdateRootCompatibility.ps1`로 매니페스트·프로토콜 루트 9개를 확인합니다.
4. `Seal-TesterZip.ps1`로 ZIP 왕복 무결성을 확인합니다.
5. `New-AgentUpdateCatalog.ps1`에 공개 키 경로를 `-TrustAnchorsPath`로 명시하고, 저장소 밖의 보호된 서명 자료를 사용합니다. 개인키를 복사하거나 커밋하지 않습니다.
6. 현재 온라인 설치 소스는 `apps/web/installer`입니다. `VERIFYONLY` 검증은 실제 설치와 구분합니다.

새 버전에서는 공개 매니페스트·provenance와 버전 고정 검사를 함께 갱신합니다. 서명·해시·권한·기존 설치 호환성 검사를 삭제하거나 완화하지 않습니다.
