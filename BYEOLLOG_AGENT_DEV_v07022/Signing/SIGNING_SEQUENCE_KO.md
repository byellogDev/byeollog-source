# 별록 공개판 Authenticode 서명 순서

기준: `v0.7.0.33` 이후 공개판
도구: `Signing/Invoke-ByeollogAuthenticodeSigning.ps1`

## 목적과 신뢰 경계

이 파이프라인은 Windows가 설치 파일과 `byeollog.exe`의 **게시자**를 확인하게 하는
Authenticode 공개 서명 절차다. 자동 업데이트 feed의 RSA-PSS-SHA256 서명과 ZIP·manifest
해시 검증은 그대로 유지한다. 두 서명은 서로 대체하지 않으며 둘 다 통과해야 한다.

`v0.7.0.32`에 사용한 `CN=Byeollog Agent Offline Update Signing 2026` 인증서는 자동
업데이트 카탈로그용 자체 관리 키다. 공개 신뢰 체인이 아니므로 Windows 공개판 코드
서명에 재사용하지 않는다. 소스, ZIP, 감사 JSON 또는 Artifact Signing metadata에 개인키,
토큰, 비밀번호, client secret을 넣지 않는다.

## 권장 공급자

### 1. Microsoft Artifact Signing

권장 운영 방식이다. 다음 항목을 별도로 준비한다.

- Windows SDK의 Microsoft 서명 `signtool.exe`
- Microsoft가 서명한 Artifact Signing client dlib
- Artifact Signing regional endpoint, account name, certificate profile name
- `PublicTrust` profile에서 받은 인증서 체인의 승인된 루트 지문
- 공식 배포본에서 직접 확인해 승인한 SignTool·dlib SHA-256
- 로컬 `az login`, 관리 ID 또는 CI의 workload identity처럼 provider가 지원하는 단기 인증

스크립트가 만드는 metadata JSON에는 위의 공개 식별자 네 필드만 들어간다. 인증 토큰은
metadata나 감사 파일에 기록하지 않는다.

```powershell
$targets = "C:\release\v0.7.0.33\byeollog.exe"

.\Signing\Invoke-ByeollogAuthenticodeSigning.ps1 `
  -Provider ArtifactSigning `
  -TargetPath $targets `
  -Policy Required `
  -ReleaseChannel Production `
  -ReleaseVersion 0.7.0.33 `
  -ExpectedPublisher "<Artifact Signing 인증서의 정확한 전체 X.500 Subject>" `
  -SignToolPath "C:\Program Files (x86)\Windows Kits\10\bin\<SDK>\x64\signtool.exe" `
  -ExpectedSignToolSha256 "<승인한 SignTool SHA-256>" `
  -ArtifactSigningDlibPath "C:\tools\ArtifactSigning\Azure.CodeSigning.Dlib.dll" `
  -ExpectedArtifactSigningDlibSha256 "<승인한 dlib SHA-256>" `
  -ArtifactSigningMetadataPath "C:\release\audit\v07033-artifact-signing-metadata.json" `
  -ArtifactSigningEndpoint "https://<region>.codesigning.azure.net/" `
  -ArtifactSigningAccountName "<account>" `
  -ArtifactSigningCertificateProfileName "<profile>" `
  -ApprovedPublicRootThumbprint "<profile 공개 체인의 루트 지문>" `
  -AuditReportPath "C:\release\audit\v07033-authenticode.json"
```

### 2. 공개 CA 인증서 저장소

공개 신뢰 코드 서명 인증서와 접근 가능한 개인키가 Windows 인증서 저장소에 있을 때만
사용한다. 인증서는 현재 유효하고 Code Signing EKU(`1.3.6.1.5.5.7.3.3`)가 있어야 하며,
Windows 공개 신뢰 체인, 승인된 공개 루트 지문과 온라인 폐기 확인을 통과해야 한다. USB 토큰/HSM 공급자라면
개인키를 내보내지 않고 해당 CSP/KSP를 통해 접근한다.

```powershell
.\Signing\Invoke-ByeollogAuthenticodeSigning.ps1 `
  -Provider CertificateStore `
  -TargetPath "C:\release\v0.7.0.33\byeollog.exe" `
  -Policy Required `
  -ReleaseChannel Production `
  -ReleaseVersion 0.7.0.33 `
  -ExpectedPublisher "<인증서의 정확한 전체 X.500 Subject>" `
  -SignToolPath "<승인한 Windows SDK x64 signtool.exe>" `
  -ExpectedSignToolSha256 "<승인한 SignTool SHA-256>" `
  -CertificateThumbprint "<공개 코드 서명 인증서 지문>" `
  -CertificateStoreLocation CurrentUser `
  -CertificateStoreName My `
  -ApprovedPublicRootThumbprint "<공개 CA 루트 지문>" `
  -AuditReportPath "C:\release\audit\v07033-authenticode.json"
```

두 공급자 모두 SHA-256 파일 다이제스트와 SHA-256 RFC 3161 타임스탬프를 사용한다.
타임스탬프 URL은 `http://timestamp.acs.microsoft.com/`로 고정한다. 서명 후에는 반드시
`signtool verify /pa /all /v`와 PowerShell `Get-AuthenticodeSignature`의 `Valid`, 예상
게시자, 타임스탬프 인증서를 모두 확인한다. 감사 JSON에는 대상의 절대 경로와 서명 전후
SHA-256이 남는다.

`ExpectedPublisher`는 짧은 CN이 아니라 서명 인증서의 전체 X.500 Subject를 정확히
입력한다. Artifact Signing에서는 `PublicTrust` profile만 사용한다. `PublicTrustTest`와
`PrivateTrust` profile은 운영판에서 금지한다. `Get-AzArtifactSigningCertificateRoot`로
해당 profile의 루트를 내려받아 별도 승인한 뒤 그 지문을 전달한다. 루트가 교체되면 자동
허용하지 말고 Microsoft 공지와 새 체인을 검토한 뒤 allowlist를 갱신한다.

## v0.7.0.33 공개 순서

1. `v0.7.0.32` 파일, feed, immutable URL을 수정하거나 덮어쓰지 않는다.
2. 새 `v0.7.0.33` 앱을 임시 release staging 폴더에 빌드하고 테스트한다.
3. `byeollog.exe`의 **최종 바이트**를 먼저 Authenticode 서명한다.
4. 감사 JSON의 `SIGNED_VERIFIED`와 `productionEligible: true`를 확인한다.
5. 서명으로 파일 해시가 바뀌므로, 서명 완료 후 `New-ReleaseManifest.ps1`을 실행한다.
6. 첫 서명판인 `v0.7.0.33`의 manifest는 `v0.7.0.32` 자동 업데이트 엔진과 호환되도록
   `trusted_channel_internal / package_integrity_only`를 유지한다. EXE 자체의 공개
   Authenticode 서명은 그대로 포함되며, RSA 서명 catalog와 SHA-256이 전송 경로를 인증한다.
7. 그 뒤에만 ZIP을 만들고 ZIP·manifest 전체 검증을 실행한다. manifest나 ZIP 생성 뒤
   EXE를 다시 서명하면 해시가 깨지므로 금지한다.
8. 서명된 payload로 NSIS 2-pass Setup을 빌드한다. 첫 pass가 내보낸 `Uninstall.exe`를
   서명·검증하고 두 번째 pass가 그 바이트를 Setup에 넣은 뒤, 마지막으로 외부
   `Setup.exe`를 서명·검증한다. 두 파일 중 하나라도 `Valid`가 아니면 빌드를 실패시킨다.
9. Setup 해시 sidecar는 외부 Setup 서명까지 끝난 뒤 생성한다. 실제 설치 후 설치된
   `byeollog.exe`와 `Uninstall.exe`도 `signtool verify /pa /all /v`로 다시 확인한다.
10. 새 불변 `v0.7.0.33` URL과 해시로 자동 업데이트 catalog를 오프라인 RSA 키로 서명한다.
11. Vercel Preview에서 설치, Authenticode, catalog, ZIP 왕복을 확인한 뒤 같은 Preview를
   Production으로 승격한다.

`v0.7.0.32`의 `trusted_channel_internal / package_integrity_only`는 과거 bootstrap을 위한
정상 호환 모드로 그대로 둔다. 현재 v32 updater와 catalog 생성기는
`authenticode_pinned / executable_publisher_and_package_integrity`를 거부하므로 v33에서
그 모드를 사용하면 자동 업데이트가 실패한다. v33 코드와 catalog 생성기에 두 모드
호환을 먼저 추가하고 회귀시험한 뒤에만 v34부터 pinned 모드로 전환할 수 있다. 공급망
RSA 서명과 Windows Authenticode를 계속 독립된 검증층으로 유지하는 선택도 가능하다.
어느 경우든 v32를 다시 서명하거나 다시 ZIP으로 만들 필요가 없고, 해서는 안 된다.

## 실패 정책과 개발용 생략

`Policy=Required` 또는 `ReleaseChannel=Production`에서는 SignTool, dlib, 계정 인증,
인증서, 공개 신뢰 체인, 게시자, 타임스탬프, 검증 중 하나라도 없으면 즉시 실패한다.
서명되지 않은 결과를 Production으로 표기할 수 없다.

로컬 UI 개발에서 서명을 생략해야 할 때만 아래처럼 세 조건을 모두 명시한다.

```powershell
.\Signing\Invoke-ByeollogAuthenticodeSigning.ps1 `
  -Provider CertificateStore `
  -TargetPath "C:\dev\byeollog.exe" `
  -Policy Development `
  -ReleaseChannel Development `
  -ReleaseVersion 0.7.0.33-dev `
  -SkipSigning `
  -AuditReportPath "C:\dev\authenticode-development.json"
```

이 결과는 `DEVELOPMENT_UNSIGNED`, `productionEligible: false`로만 기록된다. SmartScreen
평판은 공개 서명과 별개의 누적 신뢰이므로, 정상 서명 직후 모든 경고가 즉시 사라진다고
보장하지 않는다. 게시자 일관성, 다운로드 도메인 일관성, 서명된 설치 프로그램 배포를
계속 유지해야 한다.
