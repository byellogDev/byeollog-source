# Agent 패키지 검증과 서명

기존 설치 프로토콜의 검증 도구를 정식 소스 트리로 옮겼습니다. 프로그램은 `apps/windows-agent`에서 빌드합니다. 과거 개발 폴더의 실행 파일을 배포하지 않습니다.

1. 현재 공개 배포의 설치 루트 파일을 해시로 확인하고 보존합니다.
2. 새 실행 파일에 `Test-ReleaseExecutable.ps1`을 실행합니다.
3. `New-ReleaseManifest.ps1`과 `Test-UpdateRootCompatibility.ps1`로 매니페스트·프로토콜 루트 9개를 확인합니다.
4. `Seal-TesterZip.ps1`로 ZIP 왕복 무결성을 확인합니다.
5. `New-AgentUpdateCatalog.ps1`에 공개 키 경로를 `-TrustAnchorsPath`로 명시하고, 저장소 밖의 보호된 서명 자료를 사용합니다. 개인키를 복사하거나 커밋하지 않습니다.
6. 현재 온라인 설치 소스는 `apps/web/installer`입니다. `VERIFYONLY` 검증은 실제 설치와 구분합니다.
7. `Test-InstallerResultPath.ps1 -CompilerPath <ISCC.exe> -OutputDirectory <private .local directory>`로 실제 PowerShell 결과 파일을 Inno Setup의 `LoadStringsFromFile`과 운영 경로 검사에 통과시킵니다. UTF-8 BOM·한글 경로와 경로 이탈 차단을 검사합니다. `VERIFYONLY`는 설치 후 결과 경로 확인을 건너뛰므로 이 검사를 대체하지 않습니다.

새 버전에서는 공개 매니페스트·provenance와 버전 고정 검사를 함께 갱신합니다. 서명·해시·권한·기존 설치 호환성 검사를 삭제하거나 완화하지 않습니다.

## UI 버전과 배포 일치

- UI 캐시는 실행 assembly의 MVID로 구분합니다. `v1.0.0.50` 같은 고정 폴더나 수동으로 올리는 별도 UI 버전으로 되돌리지 않습니다.
- 화면을 준비할 때 HTML·CSS·JavaScript·이미지를 내장 리소스와 바이트 단위로 대조합니다. 같은 빌드 폴더라도 내용이 다르거나 파일이 없으면 임시 파일을 완전히 기록한 뒤 교체합니다. 일치하는 파일, 이전 빌드 폴더, 사용자 설정은 수정하지 않습니다.
- `AgentStoreTests`의 `UiAssetCacheTests`로 이전 캐시 보존, 동일 길이 손상, 잘린 CSS, 누락된 JS, 동시 준비와 임시 파일 정리를 검사합니다.
- `dotnet run --project tools/agent-ui-tests/AgentUiTests.csproj -c Release`로 실제 앱 assembly에서 꺼낸 화면을 검사합니다. 제거된 버튼·폼이 다시 포함되지 않는지와 공지 유지·캐시 복구를 확인합니다.
- 배포 ZIP의 실행 파일은 manifest와 일치해야 합니다. UI 수정 시 실제 패키지에 내장된 화면도 소스와 대조하고, 공개 다운로드와 서명된 업데이트 피드가 그 패키지를 가리키는지 확인합니다. 소스 검사만으로 고객 PC에 해당 화면이 적용됐다고 판단하지 않습니다.
