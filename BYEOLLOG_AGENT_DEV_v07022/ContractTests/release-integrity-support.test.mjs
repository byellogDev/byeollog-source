import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

function between(contents, start, end) {
  const from = contents.indexOf(start);
  const to = contents.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return contents.slice(from, to);
}

test("manifest v2 seals every tester-facing role and rejects package ambiguity", async () => {
  const [builder, installer, launcher] = await Promise.all([
    source("New-ReleaseManifest.ps1"),
    source("Install-Byeollog.ps1"),
    source("Byeollog-Launcher.ps1")
  ]);

  assert.match(builder, /schemaVersion = 2/);
  assert.match(builder, /packageLayout = "flat_v1"/);
  for (const role of ["app", "install_root", "package_tool", "documentation"]) {
    assert.match(builder, new RegExp(`role = "${role}"`));
  }
  for (const name of [
    "byeollog.exe",
    "Install-Byeollog.ps1",
    "Byeollog-Launcher.ps1",
    "INSTALL_AND_CHECK.cmd",
    "Test-TesterEnvironment.ps1",
    "Collect-SupportBundle.ps1",
    "RUN_REPLAY_CANDIDATE_CHECK.cmd",
    "README_TESTER_v070_RC2_KO.txt",
    "G4_CANARY_v070_RC2_KO.md",
    "RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt"
  ]) {
    assert.match(builder, new RegExp(name.replaceAll(".", "\\.")));
    assert.match(installer, new RegExp(name.replaceAll(".", "\\.")));
  }
  assert.match(builder, /cannot contain directories/);
  assert.match(builder, /cannot contain reparse points/);
  assert.match(builder, /contains an unapproved file/);
  assert.match(builder, /805306368/);
  assert.match(installer, /Tester package file set is incomplete/);
  assert.match(installer, /SHA256SUMS\.txt does not cover the complete package/);
  assert.match(installer, /Test-ManifestAuthenticity/);
  assert.match(launcher, /Test-Entry -Root \$versionRoot/);
  assert.match(launcher, /installation folder has unexpected|설치 폴더에 예상하지 못한 파일/);
});

test("new packages require v2 while rollback can read a verified legacy installed release", async () => {
  const [installer, launcher] = await Promise.all([
    source("Install-Byeollog.ps1"),
    source("Byeollog-Launcher.ps1")
  ]);

  const packageFunction = installer.slice(
    installer.indexOf("function Test-PackageRelease"),
    installer.indexOf("function Test-LegacyInstalledRelease")
  );
  assert.match(packageFunction, /Read-PackageV2Manifest/);
  assert.doesNotMatch(packageFunction, /Test-LegacyInstalledRelease/);
  assert.match(installer, /if \(\[int\]\$rawManifest\.schemaVersion -eq 1\)/);
  assert.match(installer, /Legacy installed release/);
  assert.match(launcher, /Read-only compatibility for a previously installed/);
  assert.match(launcher, /elseif \(\$schemaVersion -eq 2\)/);
});

test("installed v2 rollback accepts historical manifests while new v0.7.0.2 packages keep a strict allowlist", async () => {
  const installer = await source("Install-Byeollog.ps1");
  const packageReader = between(
    installer,
    "function Read-PackageV2Manifest",
    "function Read-CompatibleInstalledV2Manifest"
  );
  const installedReader = between(
    installer,
    "function Read-CompatibleInstalledV2Manifest",
    "function Test-ChecksumIndex"
  );
  const installedRelease = between(
    installer,
    "function Test-InstalledRelease",
    "function Assert-ImmutableVersionMatchesPackage"
  );

  assert.match(packageReader, /\$allowedPackageFiles/);
  assert.match(packageReader, /\$requiredPackageFiles/);
  assert.match(packageReader, /entries\.Count -lt 18/);
  assert.match(packageReader, /entries\.Count -gt 19/);
  assert.doesNotMatch(installedReader, /\$allowedPackageFiles|\$requiredPackageFiles|README_TESTER_v070_RC2/);
  assert.match(installedReader, /historical v2 install/);
  assert.match(installedReader, /"app", "install_root", "package_tool", "documentation"/);
  assert.match(installedReader, /"byeollog\.exe", "WebView2Loader\.dll"/);
  assert.match(installedReader, /\$entries\.Count -gt 256/);
  assert.match(installedRelease, /Read-CompatibleInstalledV2Manifest -Root \$Root/);
  assert.doesNotMatch(installedRelease, /Read-PackageV2Manifest/);
});

test("same-version reinstall reuses only byte-identical app payloads", async () => {
  const installer = await source("Install-Byeollog.ps1");
  const immutableCheck = between(
    installer,
    "function Assert-ImmutableVersionMatchesPackage",
    "function Write-JsonAtomic"
  );
  const install = between(installer, "function Install-Release", "function Switch-ToPreviousRelease");

  assert.match(immutableCheck, /Where-Object \{ \[string\]\$_\.role -eq "app" \}/);
  assert.match(
    immutableCheck,
    /\$installedEntries\s*=\s*@\(\s*if \(\[int\]\$installedManifest\.schemaVersion/s,
    "the complete schema conditional must be array-wrapped so a one-file release stays countable under StrictMode"
  );
  assert.match(immutableCheck, /installedEntries\.Count -ne \$incomingEntries\.Count/);
  assert.match(immutableCheck, /installedEntry\.byteSize -ne \[int64\]\$incomingEntry\.byteSize/);
  assert.match(immutableCheck, /installedEntry\.sha256/);
  assert.match(immutableCheck, /incomingEntry\.sha256/);
  assert.match(immutableCheck, /immutable-version-conflict/);
  assert.match(immutableCheck, /Use a new version number/);
  assert.ok(
    install.indexOf("Test-InstalledRelease -Root $target") <
      install.indexOf("Assert-ImmutableVersionMatchesPackage -Root $target"),
    "an existing immutable version must validate itself before comparison with the incoming package"
  );
  assert.doesNotMatch(install, /Remove-Item[^\n]+\$target|Move-Item[^\n]+-Destination \$target -Force/);
});

test("support bundle exports only allowlisted metadata and category counts", async () => {
  const [support, wrapper, readme] = await Promise.all([
    source("Collect-SupportBundle.ps1"),
    source("CREATE_SUPPORT_BUNDLE.cmd"),
    source("README_TESTER_v070_RC2_KO.txt")
  ]);

  assert.match(support, /allowlisted_metadata_only_no_raw_logs/);
  assert.match(support, /Get-Content[^\n]+-Tail 5000/);
  assert.match(support, /Get-SafeLogCategoryCounts/);
  assert.match(support, /Privacy scan rejected generated support content/);
  assert.match(support, /support-summary\.json/);
  assert.match(support, /PRIVACY_NOTICE_KO\.txt/);
  assert.match(support, /support-manifest\.json/);
  assert.match(support, /ReparsePoint/);
  assert.match(
    support,
    /\$appEntries\s*=\s*@\(\s*if \(\$schema -eq 1\)/s,
    "support integrity must preserve one app entry as an array under StrictMode"
  );
  assert.doesNotMatch(support, /Copy-Item[^\n]+(?:collector\.log|\.sqlite|credentials\.json)/i);
  assert.doesNotMatch(support, /Compress-Archive[^\n]+\$dataRoot/);
  assert.match(wrapper, /Collect-SupportBundle\.ps1/);
  assert.match(readme, /원문 로그/);
  assert.match(readme, /trusted_channel_internal/);
});

test("readiness uses official WebView2 detection and leaves the sealed package unchanged", async () => {
  const [readiness, run, combined] = await Promise.all([
    source("Test-TesterEnvironment.ps1"),
    source("RUN_TESTER_READINESS.cmd"),
    source("INSTALL_AND_CHECK.cmd")
  ]);

  assert.match(readiness, /F3017226-FE2A-4295-8BDF-00C3A9A7E4C5/);
  assert.match(readiness, /Get-ItemPropertyValue[^\n]+"pv"/);
  assert.match(readiness, /0\.0\.0\.0/);
  assert.match(readiness, /-Mode VerifyPackage/);
  assert.match(readiness, /\$package = \$PSScriptRoot/);
  assert.match(readiness, /ByeollogAgent\\tester-readiness/);
  assert.doesNotMatch(readiness, /WriteAllText\([^\n]+\$package/);
  assert.match(readiness, /TcpListener[^\n]+43120/);
  assert.match(readiness, /obs_websocket" "warning"/);
  assert.doesNotMatch(readiness, /Invoke-WebRequest|Invoke-RestMethod|Start-BitsTransfer/);
  assert.match(run, /--no-pause/);
  assert.doesNotMatch(run, /TESTER_READINESS_REPORT\.json"/);
  assert.match(combined, /RUN_TESTER_READINESS\.cmd" --no-pause/);
  assert.ok(
    combined.indexOf("RUN_TESTER_READINESS.cmd") < combined.indexOf("INSTALL_OR_UPDATE.cmd"),
    "readiness must pass before installation starts"
  );
  assert.match(combined, /INSTALL_OR_UPDATE\.cmd" --no-pause/);
  assert.match(combined, /VERIFY_INSTALL\.cmd" --no-pause/);
});

test("one-click build verifies the sealed folder before zip and emits an outer digest", async () => {
  const [publish, build, sealer, manifest] = await Promise.all([
    source("02_PUBLISH.cmd"),
    source("00_BUILD_V070_RC2_ONE_CLICK.cmd"),
    source("Seal-TesterZip.ps1"),
    source("New-ReleaseManifest.ps1")
  ]);

  assert.match(build, /Microsoft\.DotNet\.SDK\.8/);
  assert.match(build, /REQUIRED_SDK=8\.0\.424/);
  assert.match(build, /dotnet --list-sdks/);
  assert.match(build, /--version %REQUIRED_SDK%/);
  assert.match(publish, /New-ReleaseManifest\.ps1/);
  assert.doesNotMatch(publish, /Sign-PublicRelease\.ps1|trusted-code-signing-certificate-required/);
  assert.match(manifest, /ExpectedSignerThumbprint = ""/);
  assert.match(manifest, /mode = "trusted_channel_internal"/);
  assert.match(manifest, /mode = "authenticode_pinned"/);
  assert.match(publish, /-Mode VerifyPackage/);
  assert.ok(
    publish.indexOf("-Mode VerifyPackage") < publish.indexOf("Seal-TesterZip.ps1"),
    "the folder must pass package verification before zip creation"
  );
  assert.match(publish, /ZIP_HASH=%ZIP%\.sha256\.txt/);
  assert.match(sealer, /Compress-Archive/);
  assert.match(sealer, /Get-FileHash -Algorithm SHA256/);
  assert.match(publish, /immutable-output-conflict/);
  assert.doesNotMatch(publish, /rmdir \/s \/q "%DIST%"/i);
  assert.match(sealer, /FileMode\]::CreateNew/);
  assert.doesNotMatch(sealer, /Remove-Item[^\n]+\$ZipPath/);
  for (const file of [
    "INSTALL_AND_CHECK.cmd",
    "RUN_G4_CANARY_PREP.cmd",
    "RUN_TESTER_READINESS.cmd",
    "RUN_REPLAY_CANDIDATE_CHECK.cmd",
    "CREATE_SUPPORT_BUNDLE.cmd",
    "Collect-SupportBundle.ps1"
  ]) {
    assert.match(publish, new RegExp(file.replaceAll(".", "\\.")));
  }
});

test("release inputs pin the SDK and keep pre-build records out of the Tester ZIP", async () => {
  const [globalJson, publish, manifest, installer, testerPackager, completePackager, canary, validation, handoff] = await Promise.all([
    source("global.json"),
    source("02_PUBLISH.cmd"),
    source("New-ReleaseManifest.ps1"),
    source("Install-Byeollog.ps1"),
    source("tools/package-tester-linux.mjs"),
    source("tools/package-complete-release-linux.mjs"),
    source("G4_CANARY_v070_RC2_KO.md"),
    source("VALIDATION_v070_RC2_OFFSL_SINGLE_LOGIN_KO.txt"),
    source("BYEOLLOG_AGENT_v0704_PUBLIC_PATH_FIX_HANDOFF_KO.md")
  ]);

  const sdk = JSON.parse(globalJson).sdk;
  assert.equal(sdk.version, "8.0.424");
  assert.equal(sdk.rollForward, "latestPatch");
  assert.equal(sdk.allowPrerelease, false);
  assert.match(publish, /dotnet --version/);
  assert.match(completePackager, /"global\.json"/);
  assert.match(completePackager, /assertExpectedBasename\(options\.handoff, HANDOFF_NAME, "Handoff"\)/);
  assert.match(completePackager, /join\(stageRoot, HANDOFF_NAME\)/);
  assert.match(completePackager, /checksums\.set\(HANDOFF_NAME, handoffHash\)/);
  assert.match(completePackager, /HANDOFF_NAME,\s*README_START_NAME,\s*SOURCE_CHECKSUM_NAME/s);

  for (const surface of [publish, manifest, installer, testerPackager]) {
    assert.doesNotMatch(surface, /VALIDATION_v070_RC2_OFFSL_SINGLE_LOGIN_KO\.txt/);
    assert.doesNotMatch(surface, /BUILD_SOURCE_v070_RC2_KO\.txt/);
  }
  for (const document of [canary, validation, handoff]) {
    assert.doesNotMatch(document, /PENDING_WINDOWS_BUILD|WINDOWS_BUILD_PENDING/);
  }
});

test("tester packagers reject same-version output replacement", async () => {
  const [publish, manifest, sealer, testerPackager, completePackager] = await Promise.all([
    source("02_PUBLISH.cmd"),
    source("New-ReleaseManifest.ps1"),
    source("Seal-TesterZip.ps1"),
    source("tools/package-tester-linux.mjs"),
    source("tools/package-complete-release-linux.mjs")
  ]);
  for (const surface of [publish, manifest, sealer, testerPackager, completePackager]) {
    assert.match(surface, /immutable-output-conflict/);
  }
  assert.doesNotMatch(testerPackager, /rm\(packageRoot|rm\(zipPath|rm\(zipHashPath/);
});

test("release tooling accepts the Collector four-part version consistently", async () => {
  const [manifest, installer, publish] = await Promise.all([
    source("New-ReleaseManifest.ps1"),
    source("Install-Byeollog.ps1"),
    source("02_PUBLISH.cmd")
  ]);
  const fourPartPattern = /\^\\d\+\\\.\\d\+\\\.\\d\+\\\.\\d\+\$/;
  assert.match(manifest, fourPartPattern);
  assert.match(installer, fourPartPattern);
  assert.match(publish, /-Version "0\.7\.0\.32"/);
});

test("G4 preparation performs only sealed checks before the one live canary", async () => {
  const [runner, publish, manifest, installer, testerPackager, completePackager] = await Promise.all([
    source("RUN_G4_CANARY_PREP.cmd"),
    source("02_PUBLISH.cmd"),
    source("New-ReleaseManifest.ps1"),
    source("Install-Byeollog.ps1"),
    source("tools/package-tester-linux.mjs"),
    source("tools/package-complete-release-linux.mjs")
  ]);

  const installAt = runner.indexOf("INSTALL_AND_CHECK.cmd");
  const replayAt = runner.indexOf("RUN_REPLAY_CANDIDATE_CHECK.cmd");
  const launchAt = runner.indexOf("LAUNCH_BYEOLLOG.cmd");
  assert.ok(installAt >= 0 && installAt < replayAt && replayAt < launchAt);
  assert.match(runner, /PREPARATION PASSED\. NO LIVE EVENT WAS USED\./);
  assert.match(runner, /actual event once/);
  assert.doesNotMatch(runner, /아봉10초|collector-process|event-runtime|Invoke-RestMethod|curl/i);
  for (const surface of [publish, manifest, installer, testerPackager, completePackager]) {
    assert.match(surface, /RUN_G4_CANARY_PREP\.cmd/);
  }
});

test("launcher resolves zero, one, empty, and many arguments without nullable ArgumentList binding", async () => {
  const launcher = await source("Byeollog-Launcher.ps1");
  assert.match(launcher, /function Resolve-CollectorLaunchMode/);
  assert.match(launcher, /\[System\.Collections\.Generic\.List\[string\]\]::new\(\)/);
  assert.match(launcher, /if \(\$null -ne \$Arguments\)/);
  assert.match(launcher, /foreach \(\$argument in \$Arguments\)/);
  assert.match(launcher, /if \(\$values\.Count -eq 0\) \{ return "normal" \}/);
  assert.match(launcher, /if \(\$values\.Count -eq 1[\s\S]+return "replay_candidate_check"/);
  assert.match(launcher, /function Assert-LauncherArgumentContract/);
  assert.match(launcher, /Resolve-CollectorLaunchMode -Arguments \$null/);
  assert.match(launcher, /Resolve-CollectorLaunchMode -Arguments @\("--replay-candidate-check"\)/);
  assert.match(launcher, /Resolve-CollectorLaunchMode -Arguments @\("one", "two"\)/);
  assert.match(launcher, /Resolve-CollectorLaunchMode -Arguments @\(" "\)/);
  assert.match(launcher, /Assert-LauncherArgumentContract\s+\$launchMode = Resolve-CollectorLaunchMode -Arguments \$CollectorArgs/);
  assert.doesNotMatch(launcher, /\$CollectorArgs\s*\[/);
  assert.doesNotMatch(launcher, /-ArgumentList\s+\$/);
  assert.match(launcher, /Start-Process[^\n]+-ArgumentList "--replay-candidate-check" -Wait -PassThru/);
  assert.match(launcher, /else \{[\s\S]+Start-Process -FilePath \$exe -WorkingDirectory \$versionRoot/);
  assert.match(launcher, /Start-Process[^\n]+-ArgumentList "--update-check" -WindowStyle Hidden/);
});

test("every installed launcher process start has an exact Windows PowerShell 5.1 argument shape", async () => {
  const launcher = await source("Byeollog-Launcher.ps1");
  const starts = launcher.split(/\r?\n/u).filter((line) => line.trimStart().startsWith("Start-Process ") || line.includes("= Start-Process "));
  assert.equal(starts.length, 3);
  assert.match(starts[0], /-ArgumentList "--replay-candidate-check" -Wait -PassThru$/);
  assert.doesNotMatch(starts[0], /-ArgumentList\s+\$/);
  assert.match(starts[1], /Start-Process -FilePath \$exe -WorkingDirectory \$versionRoot$/);
  assert.doesNotMatch(starts[1], /-ArgumentList/);
  assert.match(starts[2], /-ArgumentList "--update-check" -WindowStyle Hidden \| Out-Null$/);
});

test("installed collector runs the built-in replay candidate synchronously without login or a live event", async () => {
  const [program, replay, launcher, wrapper, installer, publish] = await Promise.all([
    source("Program.cs"),
    source("CollectorReplayAcceptance.cs"),
    source("Byeollog-Launcher.ps1"),
    source("RUN_REPLAY_CANDIDATE_CHECK.cmd"),
    source("Install-Byeollog.ps1"),
    source("02_PUBLISH.cmd")
  ]);

  const replayBranch = program.indexOf('args[0], "--replay-candidate-check"');
  const uiInitialization = program.indexOf("ApplicationConfiguration.Initialize()");
  assert.ok(replayBranch >= 0 && replayBranch < uiInitialization, "replay must run before UI, state, and login initialization");
  assert.match(program, /EvaluateBuiltInCandidate/);
  assert.match(program, /tester-results[\s\S]+v070_RC2/);
  assert.match(wrapper, /tester-results\\v070_RC2/);
  assert.match(program, /report\.LiveEventUsed/);
  assert.match(replay, /LiveEventUsed/);
  assert.match(replay, /false/);
  assert.match(replay, /recorded-success/);
  assert.match(replay, /restore-failure/);
  assert.match(replay, /Unknown replay field/);
  assert.match(launcher, /--replay-candidate-check/);
  assert.match(launcher, /Start-Process[^\n]+-Wait -PassThru/);
  assert.match(wrapper, /--replay-candidate-check/);
  assert.match(wrapper, /NO LIVE EVENT WAS USED/);
  assert.match(installer, /RUN_REPLAY_CANDIDATE_CHECK\.cmd/);
  assert.match(publish, /RUN_REPLAY_CANDIDATE_CHECK\.cmd/);
});
