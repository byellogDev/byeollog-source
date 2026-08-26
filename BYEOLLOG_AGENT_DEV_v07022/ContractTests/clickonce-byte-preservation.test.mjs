import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("manual ClickOnce packaging requires final HTTPS inputs and store-backed signing", async () => {
  const builder = await source("Build-ClickOnceBeta.ps1");

  for (const parameter of [
    "ApprovedExePath",
    "ExpectedExeSha256",
    "DeploymentBaseUrl",
    "CertificateThumbprint",
    "TimestampUrl"
  ]) {
    assert.match(
      builder,
      new RegExp(`Parameter\\(Mandatory = \\$true\\)[\\s\\S]{0,180}\\$${parameter}`),
      `${parameter} must be a required release input`
    );
  }

  assert.match(builder, /UriSchemeHttps/);
  assert.match(builder, /DeploymentBaseUrl must use HTTPS/);
  assert.match(builder, /IsLoopback/);
  assert.match(builder, /UserInfo/);
  assert.match(builder, /Query/);
  assert.match(builder, /Fragment/);
  assert.match(builder, /Cert:\\CurrentUser\\My/);
  assert.match(builder, /HasPrivateKey/);
  assert.doesNotMatch(builder, /-CertFile|-Password|\.pfx|\.p12/i);
});

test("manual ClickOnce packaging preserves and repeatedly proves approved EXE bytes", async () => {
  const builder = await source("Build-ClickOnceBeta.ps1");

  const copyPosition = builder.indexOf("Copy-Item -LiteralPath $sourceExe");
  const firstHashPosition = builder.indexOf("Get-FileHash -LiteralPath $sourceExe");
  const launcherPosition = builder.indexOf("'-AddLauncher'");
  const postLauncherHashPosition = builder.indexOf("$postLauncherHash");
  const applicationPosition = builder.indexOf("'-New', 'Application'");
  const applicationSignPosition = builder.indexOf("'ClickOnce application manifest signing'");
  const deploymentPosition = builder.indexOf("'-New', 'Deployment'");
  const deploymentSignPosition = builder.indexOf("'ClickOnce deployment manifest signing'");
  const finalHashPosition = builder.indexOf("$finalHash");
  const verifierPosition = builder.indexOf("Verify-ClickOnceBeta.ps1");

  for (const position of [
    copyPosition,
    firstHashPosition,
    launcherPosition,
    postLauncherHashPosition,
    applicationPosition,
    applicationSignPosition,
    deploymentPosition,
    deploymentSignPosition,
    finalHashPosition,
    verifierPosition
  ]) {
    assert.notEqual(position, -1);
  }

  assert.ok(firstHashPosition < copyPosition, "source bytes must be approved before copy");
  assert.ok(copyPosition < launcherPosition);
  assert.ok(launcherPosition < postLauncherHashPosition, "launcher creation must be followed by re-hashing");
  assert.ok(postLauncherHashPosition < applicationPosition);
  assert.ok(applicationPosition < applicationSignPosition);
  assert.ok(applicationSignPosition < deploymentPosition);
  assert.ok(deploymentPosition < deploymentSignPosition);
  assert.ok(deploymentSignPosition < finalHashPosition);
  assert.ok(finalHashPosition < verifierPosition);
  assert.match(builder, /immutable output already exists/);
  assert.match(builder, /APPROVED_EXE_SHA256\.txt/);
  assert.match(builder, /CLICKONCE_BUILD_METADATA\.json/);
  assert.doesNotMatch(builder, /Install-Byeollog|Byeollog-Launcher|02_PUBLISH|New-ReleaseManifest/);
});

test("ClickOnce verification gates hash, version, provider, signer, and hosted files", async () => {
  const verifier = await source("Verify-ClickOnceBeta.ps1");

  assert.match(verifier, /Get-FileHash -LiteralPath \$approvedExe -Algorithm SHA256/);
  assert.match(verifier, /Invoke-MageVerify -ManifestPath \$applicationManifest/);
  assert.match(verifier, /Invoke-MageVerify -ManifestPath \$deploymentManifest/);
  assert.match(verifier, /DtdProcessing.*Prohibit/);
  assert.match(verifier, /deploymentProvider/);
  assert.match(verifier, /dependentAssembly/);
  assert.match(verifier, /ExpectedVersion/);
  assert.match(verifier, /X509Certificate/);
  assert.match(verifier, /ExpectedCertificateThumbprint/);
  assert.match(verifier, /ProbeHostedFiles/);
  assert.match(verifier, /Method Head/);
  assert.match(verifier, /MaximumRedirection 0/);
  assert.match(verifier, /forbidden secret material/);
  assert.doesNotMatch(verifier, /Install-Byeollog|Byeollog-Launcher|02_PUBLISH|New-ReleaseManifest/);
});

test("dotnet-mage is pinned and the future SDK profile stays parameterized", async () => {
  const [toolText, profile] = await Promise.all([
    source(".config/dotnet-tools.json"),
    source("Properties/PublishProfiles/ByeollogBetaClickOnce.pubxml")
  ]);
  const toolManifest = JSON.parse(toolText);
  const mage = toolManifest.tools["microsoft.dotnet.mage"];

  assert.equal(toolManifest.isRoot, true);
  assert.equal(mage.version, "8.0.0");
  assert.deepEqual(mage.commands, ["dotnet-mage"]);
  assert.deepEqual(Object.keys(mage).sort(), ["commands", "version"]);

  assert.match(profile, /<PublishProtocol>ClickOnce<\/PublishProtocol>/);
  assert.match(profile, /<ApplicationVersion>0\.7\.0\.94<\/ApplicationVersion>/);
  assert.match(profile, /<RuntimeIdentifier>win-x64<\/RuntimeIdentifier>/);
  assert.match(profile, /<SelfContained>true<\/SelfContained>/);
  assert.match(profile, /<PublishSingleFile>true<\/PublishSingleFile>/);
  assert.match(profile, /<PublishTrimmed>false<\/PublishTrimmed>/);
  assert.match(profile, /<PublishReadyToRun>false<\/PublishReadyToRun>/);
  assert.match(profile, /<SignManifests>true<\/SignManifests>/);
  assert.match(profile, /\$\(ClickOnceBaseUrl\)/);
  assert.match(profile, /\$\(ClickOnceCertificateThumbprint\)/);
  assert.match(profile, /<ManifestTimestampUrl>\$\(ClickOnceTimestampUrl\)<\/ManifestTimestampUrl>/);
  assert.match(profile, /RequireByeollogClickOnceReleaseParameters/);
  assert.match(profile, /must use HTTPS/);
  assert.doesNotMatch(profile, /<InstallUrl>\s*https?:|<UpdateUrl>\s*https?:/i);
  assert.doesNotMatch(profile, /ManifestKeyFile|\.pfx|\.p12|Password/i);
});

test("Korean release runbook separates approved-byte and standard publish routes", async () => {
  const [runbook, sourcePackager] = await Promise.all([
    source("CLICKONCE_BETA_RELEASE_v070_RC2_KO.md"),
    source("tools/package-complete-release-linux.mjs")
  ]);

  assert.match(runbook, /승인 EXE의 SHA-256은 복사 전, 런처 생성 후, 매니페스트 서명 후/);
  assert.match(runbook, /PFX, 개인 키, 인증서 암호, 토큰/);
  assert.match(runbook, /Cert:\\CurrentUser\\My/);
  assert.match(runbook, /-ProbeHostedFiles/);
  assert.match(runbook, /application\/x-ms-application/);
  assert.match(runbook, /application\/x-ms-manifest/);
  assert.match(runbook, /기존 ZIP 설치판/);
  assert.match(runbook, /일반 사용자 로그인/);
  assert.match(runbook, /같은 버전으로 다른 바이트를 다시 배포하지/);
  assert.match(runbook, /표준 `dotnet publish`는 단일 파일 EXE 자체에 서명/);
  for (const requiredSource of [
    "Build-ClickOnceBeta.ps1",
    "Verify-ClickOnceBeta.ps1",
    ".config/dotnet-tools.json",
    "Properties/PublishProfiles/ByeollogBetaClickOnce.pubxml",
    "CLICKONCE_BETA_RELEASE_v070_RC2_KO.md",
    "OFFSL_VNEXT_MIGRATION_PLAN_v070_RC2_KO.md"
  ]) {
    assert.ok(sourcePackager.includes(`\"${requiredSource}\"`), `SOURCE_ONLY must include ${requiredSource}`);
  }
});
