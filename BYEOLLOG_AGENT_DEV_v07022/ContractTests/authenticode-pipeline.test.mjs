import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const scriptUrl = new URL("../Signing/Invoke-ByeollogAuthenticodeSigning.ps1", import.meta.url);

test("public signing supports Artifact Signing and certificate-store providers with fixed SHA256 RFC3161", async () => {
  const script = await source("Signing/Invoke-ByeollogAuthenticodeSigning.ps1");

  assert.match(script, /ValidateSet\("ArtifactSigning", "CertificateStore"\)/);
  assert.match(script, /http:\/\/timestamp\.acs\.microsoft\.com\//);
  assert.match(script, /"\/fd", "SHA256"/);
  assert.match(script, /"\/tr", \$script:RequiredTimestampServer/);
  assert.match(script, /"\/td", "SHA256"/);
  assert.match(script, /"\/dlib", \$dlib\.FullName/);
  assert.match(script, /"\/dmdf", \$artifactMetadata\.FullName/);
  assert.match(script, /CodeSigningAccountName = \$AccountName/);
  assert.match(script, /CertificateProfileName = \$ProfileName/);
  assert.match(script, /"\/sha1", \$normalizedStoreThumbprint/);
  assert.match(script, /CertificateStoreLocation -eq "LocalMachine"/);
  assert.match(script, /HasPrivateKey/);
  assert.match(script, /1\.3\.6\.1\.5\.5\.7\.3\.3/);
  assert.match(script, /X509RevocationMode\]::Online/);
  assert.match(script, /self-signed certificate cannot be used for a public release/i);
  assert.match(script, /ArtifactPublicTrustEkuOid = "1\.3\.6\.1\.4\.1\.311\.97\.1\.0"/);
  assert.match(script, /Signer chain root is not in ApprovedPublicRootThumbprint/);
});

test("required signing verifies official tools, Windows publisher trust, timestamp and before-after hashes", async () => {
  const script = await source("Signing/Invoke-ByeollogAuthenticodeSigning.ps1");

  assert.match(script, /Assert-MicrosoftSignedTool -File \$candidate -Label "SignTool"/);
  assert.match(script, /Artifact Signing requires SignTool 10\.0\.2261\.755 or later/);
  assert.match(script, /Assert-MicrosoftSignedTool -File \$dlib -Label "Artifact Signing dlib"/);
  assert.match(script, /"verify", "\/pa", "\/all", "\/v"/);
  assert.match(script, /Get-AuthenticodeSignature -LiteralPath \$File\.FullName/);
  assert.match(script, /SignatureStatus\]::Valid/);
  assert.match(script, /TimeStamperCertificate/);
  assert.match(script, /Assert-ExpectedPublisher/);
  assert.match(script, /beforeSha256 = Get-Sha256Lower/);
  assert.match(script, /afterSha256 = Get-Sha256Lower/);
  assert.match(script, /productionEligible = \(\$ReleaseChannel -eq "Production" -and \$Policy -eq "Required"\)/);
  assert.match(script, /Production releases require Policy=Required/);
  assert.match(script, /Production releases require a persistent AuditReportPath/);
  assert.match(script, /Assert-ExpectedFileHash -File \$signTool/);
  assert.match(script, /Assert-ExpectedFileHash -File \$dlib/);
  assert.match(script, /Certificate\.Subject\.Trim\(\), \$Expected\.Trim\(\)/);
  assert.match(script, /Signed file certificate does not match the selected CertificateStore certificate/);
  assert.doesNotMatch(script, /Write-Verbose \(\$nativeOutput/);
  assert.doesNotMatch(script, /Export-PfxCertificate|ExportParameters\(\$true\)|BEGIN (?:RSA )?PRIVATE KEY/i);
  assert.doesNotMatch(script, /\[string\]\$(?:AccessToken|ClientSecret|Password|PrivateKey)\b/i);
});

test("PowerShell 5.1 native stderr is discarded and native exit code remains authoritative", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell 5.1 native process behavior is Windows-only");
    return;
  }

  const script = await source("Signing/Invoke-ByeollogAuthenticodeSigning.ps1");
  const functionStart = script.indexOf("function Invoke-SignTool");
  const functionEnd = script.indexOf("function Assert-ArtifactEndpoint", functionStart);
  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const powerShell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tempRoot = await mkdtemp(join(tmpdir(), "byeollog-native-runner-"));
  try {
    const successTool = join(tempRoot, "success.cmd");
    const failureTool = join(tempRoot, "failure.cmd");
    const harness = join(tempRoot, "harness.ps1");
    await writeFile(successTool, "@echo off\r\necho tenant-diagnostic 1>&2\r\nexit /b 0\r\n", "ascii");
    await writeFile(failureTool, "@echo off\r\necho credential-diagnostic 1>&2\r\nexit /b 23\r\n", "ascii");
    await writeFile(harness, [
      "$ErrorActionPreference = 'Stop'",
      script.slice(functionStart, functionEnd),
      "$tool = Get-Item -LiteralPath $args[0]",
      "Invoke-SignTool -Tool $tool -Arguments @('ignored') -Operation 'contract'",
      "'RUNNER_OK'"
    ].join("\r\n"), "utf8");

    const success = spawnSync(powerShell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, successTool
    ], { encoding: "utf8" });
    assert.equal(success.status, 0, success.stderr || success.stdout);
    assert.match(success.stdout, /RUNNER_OK/);
    assert.doesNotMatch(`${success.stdout}\n${success.stderr}`, /tenant-diagnostic/);

    const failure = spawnSync(powerShell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", harness, failureTool
    ], { encoding: "utf8" });
    assert.notEqual(failure.status, 0);
    assert.match(`${failure.stdout}\n${failure.stderr}`, /exit code 23/);
    assert.doesNotMatch(`${failure.stdout}\n${failure.stderr}`, /credential-diagnostic/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("Artifact Signing metadata contains public identifiers only", async () => {
  const script = await source("Signing/Invoke-ByeollogAuthenticodeSigning.ps1");
  const metadataStart = script.indexOf("$metadata = [ordered]@{");
  const metadataEnd = script.indexOf("$tempPath =", metadataStart);
  assert.notEqual(metadataStart, -1);
  assert.notEqual(metadataEnd, -1);
  const metadata = script.slice(metadataStart, metadataEnd);

  for (const field of ["Endpoint", "CodeSigningAccountName", "CertificateProfileName", "CorrelationId"]) {
    assert.match(metadata, new RegExp(`${field} =`));
  }
  assert.doesNotMatch(metadata, /token|password|secret|private.?key|credential/i);
});

test("development-only unsigned mode is explicit, byte-preserving and never production eligible", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Authenticode policy is Windows-only");
    return;
  }

  const powerShell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tempRoot = await mkdtemp(join(tmpdir(), "byeollog-authenticode-contract-"));
  try {
    const target = join(tempRoot, "development.exe");
    const audit = join(tempRoot, "audit.json");
    const bytes = Buffer.from("development-only-not-a-production-pe", "utf8");
    await writeFile(target, bytes);

    const result = spawnSync(powerShell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", fileURLToPath(scriptUrl),
      "-Provider", "CertificateStore",
      "-TargetPath", target,
      "-Policy", "Development",
      "-ReleaseChannel", "Development",
      "-ReleaseVersion", "0.7.0.33-dev",
      "-SkipSigning",
      "-AuditReportPath", audit
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(await readFile(target), bytes);
    const report = JSON.parse(await readFile(audit, "utf8"));
    assert.equal(report.result, "DEVELOPMENT_UNSIGNED");
    assert.equal(report.productionEligible, false);
    assert.equal(report.targets.length, 1);
    assert.equal(report.targets[0].beforeSha256, report.targets[0].afterSha256);
    assert.equal(report.targets[0].signatureStatus, "SkippedDevelopmentOnly");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("required or production policy cannot use unsigned development escape hatch", async (t) => {
  if (process.platform !== "win32") {
    t.skip("PowerShell Authenticode policy is Windows-only");
    return;
  }

  const powerShell = join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const tempRoot = await mkdtemp(join(tmpdir(), "byeollog-authenticode-negative-"));
  try {
    const target = join(tempRoot, "blocked.exe");
    await writeFile(target, Buffer.from("must-remain-unsigned", "utf8"));
    const baseArgs = [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", fileURLToPath(scriptUrl),
      "-Provider", "CertificateStore",
      "-TargetPath", target,
      "-ReleaseVersion", "0.7.0.33",
      "-SkipSigning"
    ];

    const required = spawnSync(powerShell, [
      ...baseArgs,
      "-Policy", "Required",
      "-ReleaseChannel", "Development"
    ], { encoding: "utf8" });
    assert.notEqual(required.status, 0);
    assert.match(`${required.stdout}\n${required.stderr}`, /SkipSigning is permitted only/i);

    const production = spawnSync(powerShell, [
      ...baseArgs,
      "-Policy", "Development",
      "-ReleaseChannel", "Production"
    ], { encoding: "utf8" });
    assert.notEqual(production.status, 0);
    assert.match(`${production.stdout}\n${production.stderr}`, /Production releases require Policy=Required/i);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("v33 sequence preserves immutable v32, remains updater-compatible, and signs both NSIS layers", async () => {
  const guide = await source("Signing/SIGNING_SEQUENCE_KO.md");

  assert.match(guide, /v0\.7\.0\.32.*수정하거나 덮어쓰지 않는다/);
  assert.match(guide, /trusted_channel_internal \/ package_integrity_only/);
  assert.match(guide, /authenticode_pinned \/ executable_publisher_and_package_integrity/);
  assert.match(guide, /첫 서명판인 `v0\.7\.0\.33`의 manifest[^]*trusted_channel_internal/);
  assert.match(guide, /v33에서\s+그 모드를 사용하면 자동 업데이트가 실패/);
  assert.match(guide, /v34부터 pinned 모드로 전환/);
  assert.match(guide, /NSIS 2-pass Setup/);
  assert.match(guide, /내보낸 `Uninstall\.exe`를\s+서명·검증/);
  assert.match(guide, /외부\s+`Setup\.exe`를 서명·검증/);
  assert.match(guide, /서명 완료 후 `New-ReleaseManifest\.ps1`/);
  assert.match(guide, /manifest나 ZIP 생성 뒤\s+EXE를 다시 서명하면 해시가 깨지므로 금지한다/);
  assert.match(guide, /자동 업데이트 feed의 RSA-PSS-SHA256 서명.*그대로 유지/s);
  assert.match(guide, /DEVELOPMENT_UNSIGNED/);
  assert.match(guide, /productionEligible: false/);
});
