# 별록 v0.7.0.2 비공개 베타 ClickOnce 릴리스

이 문서는 운영 ClickOnce 배포가 완료됐다는 기록이 아니며, 기존 ZIP 설치판을 대체하지 않는다. 비공개 베타 ClickOnce 채널을 별도로 만들고, 승인된 `byeollog.exe`의 바이트를 그대로 보존하는 절차를 정의한다. ZIP 설치·업데이트·롤백 스크립트와 ClickOnce 산출물을 섞지 않는다.

## 두 배포 경로

현재 승인 바이너리를 보존해야 하는 릴리스에는 `Build-ClickOnceBeta.ps1`을 사용한다. 이 스크립트는 승인 EXE를 복사한 뒤 `dotnet-mage`가 별도의 `Launcher.exe`와 두 ClickOnce 매니페스트만 만들게 한다. 승인 EXE의 SHA-256은 복사 전, 런처 생성 후, 매니페스트 서명 후, 최종 검증에서 다시 확인된다.

`Properties/PublishProfiles/ByeollogBetaClickOnce.pubxml`은 향후 표준 SDK 게시 경로다. `SignManifests=true`인 표준 `dotnet publish`는 단일 파일 EXE 자체에 서명할 수 있으므로 바이트가 바뀐다. 따라서 이미 승인된 EXE의 정확한 SHA-256을 유지해야 하는 v0.7.0.2에는 이 프로필을 사용하지 않는다.

## 필수 준비

- Windows 10/11 x64와 .NET 8 SDK
- 최종 배포 위치로 사용할 외부 HTTPS 기본 주소. 임시 주소, HTTP, localhost, 쿼리·조각이 붙은 주소는 허용하지 않는다.
- 코드 서명 용도의 인증서와 개인 키. 인증서는 릴리스 담당자 계정의 `Cert:\CurrentUser\My`에 설치하고 40자리 인증서 지문만 전달한다.
- HTTPS 타임스탬프 서비스 주소
- 승인된 v0.7.0.2 `byeollog.exe`와 별도로 확인한 SHA-256

PFX, 개인 키, 인증서 암호, 토큰, `.env` 파일은 저장소·릴리스 폴더·지원 번들에 복사하거나 커밋하지 않는다. 두 PowerShell 스크립트는 PFX 경로나 암호를 입력받지 않는다. 릴리스 담당자 PC의 인증서 저장소에 있는 개인 키만 사용한다.

## 승인 바이트 보존형 패키징

저장소 루트에서 Windows PowerShell 5.1 이상을 열고 환경별 값은 비밀 저장소나 릴리스 시스템의 보호 변수에서 주입한다. 아래 변수 중 하나라도 비어 있으면 실행하지 않는다.

```powershell
$approvedExe = $env:BYEOLLOG_APPROVED_EXE
$approvedSha256 = $env:BYEOLLOG_APPROVED_SHA256
$baseUrl = $env:BYEOLLOG_CLICKONCE_BASE_URL
$certificateThumbprint = $env:BYEOLLOG_CLICKONCE_CERT_THUMBPRINT
$timestampUrl = $env:BYEOLLOG_TIMESTAMP_URL

.\Build-ClickOnceBeta.ps1 `
  -ApprovedExePath $approvedExe `
  -ExpectedExeSha256 $approvedSha256 `
  -DeploymentBaseUrl $baseUrl `
  -CertificateThumbprint $certificateThumbprint `
  -TimestampUrl $timestampUrl `
  -Version 0.7.0.2
```

스크립트는 `.config/dotnet-tools.json`에 고정된 `Microsoft.DotNet.Mage` 8.0.0만 복원한다. 성공 시 `dist\clickonce\ByeollogClickOnce-0.7.0.2`가 생긴다. 같은 버전 폴더가 이미 있으면 덮어쓰지 않고 중단한다. 같은 버전으로 다른 바이트를 다시 배포하지 말고 새 네 부분 버전을 발급한다.

산출물의 핵심 구조는 다음과 같다.

```text
ByeollogClickOnce-0.7.0.2/
  byeollog.application
  APPROVED_EXE_SHA256.txt
  CLICKONCE_BUILD_METADATA.json
  Application Files/
    byeollog_0_6_3_3/
      byeollog.exe
      Launcher.exe
      byeollog.exe.manifest
```

`Application Files` 안에는 `dotnet-mage`가 만든 추가 런처 파일이 더 있을 수 있다. `byeollog.exe`는 반드시 `APPROVED_EXE_SHA256.txt`의 값과 일치해야 한다.

## 로컬 검증과 업로드

패키징 스크립트가 검증기를 자동 호출하지만, 업로드 전 독립적으로 한 번 더 실행한다.

```powershell
.\Verify-ClickOnceBeta.ps1 `
  -PackageRoot .\dist\clickonce\ByeollogClickOnce-0.7.0.2 `
  -ExpectedExeSha256 $approvedSha256 `
  -ExpectedVersion 0.7.0.2 `
  -ExpectedDeploymentBaseUrl $baseUrl `
  -ExpectedCertificateThumbprint $certificateThumbprint
```

산출물 전체를 HTTPS 기본 주소 아래에 상대 경로 그대로 업로드한다. 서버는 최소한 다음 형식을 제공해야 한다.

- `.application`: `application/x-ms-application`
- `.manifest`: `application/x-ms-manifest`
- `.exe`: `application/octet-stream`

루트의 `byeollog.application`은 업데이트 확인 대상이므로 캐시 시간을 짧게 두거나 재검증하도록 한다. 버전 폴더는 불변으로 취급한다. 업로드가 끝난 뒤 같은 검증 명령에 `-ProbeHostedFiles`를 추가해 리디렉션 없는 HTTPS 2xx 응답을 확인한다. 서버에서 인증이나 일회용 쿼리 문자열을 요구하면 ClickOnce 업데이트가 깨질 수 있다.

## 설치·업데이트 테스트 게이트

아래 항목을 모두 통과하기 전에는 베타 링크를 배포하지 않는다.

1. 깨끗한 Windows 사용자 계정에서 최종 `byeollog.application`을 열어 설치하고, 게시자와 버전 `0.7.0.2`를 확인한다.
2. 별록을 실행해 일반 사용자 로그인을 완료하고 기존 세션·SQLite 설정·OBS WebSocket·마이크 선택이 정상인지 확인한다. 개발자 자동연결이나 개발 토큰은 설치 요건이 아니다.
3. 앱과 OBS를 종료한 뒤 더 높은 네 부분 버전을 같은 HTTPS 경로에 올린다. 다시 실행해 업데이트가 감지되고 승인된 새 버전으로 교체되는지 확인한다.
4. 업데이트 뒤 사용자 로그인 세션, 로컬 데이터, OBS 설정, 마이크 설정이 유지되는지 확인한다. ClickOnce 캐시를 애플리케이션 데이터 저장소로 사용하면 안 된다.
5. 네트워크를 끊은 상태에서 이미 설치된 버전이 실행되는지 확인하고, 네트워크 복구 뒤 업데이트 확인이 정상화되는지 확인한다.
6. 기존 ZIP 설치판이 있는 PC에서는 두 앱을 동시에 실행하지 않는다. ZIP판을 완전히 종료한 상태에서 ClickOnce판을 설치·실행하고, 반대 순서도 확인한다. ZIP의 `INSTALL_OR_UPDATE.cmd`, `Byeollog-Launcher.ps1`, 포인터 기반 롤백 동작은 그대로여야 한다.
7. `Verify-ClickOnceBeta.ps1`이 잘못된 EXE 해시, 다른 인증서 지문, HTTP 주소, 변조된 매니페스트를 각각 거부하는 음성 테스트를 실행한다.

## 향후 표준 SDK 게시 경로

승인 절차가 “게시 후 생성된 서명 EXE”를 기준으로 바뀐 뒤에만 다음 프로필을 사용한다. 최종 주소와 인증서 지문은 프로필에 기록하지 않고 반드시 명령행 보호 변수로 전달한다.

```powershell
dotnet publish .\HurogiCollector.csproj `
  -p:PublishProfile=ByeollogBetaClickOnce `
  -p:ClickOnceBaseUrl=$baseUrl `
  -p:ClickOnceCertificateThumbprint=$certificateThumbprint `
  -p:ClickOnceTimestampUrl=$timestampUrl
```

이 경로에서는 게시가 끝난 뒤 생성된 EXE와 매니페스트를 새로 승인하고 해시를 기록한다. 수동 바이트 보존형 산출물과 표준 SDK 산출물을 같은 URL이나 같은 버전 번호에 혼합하지 않는다.
