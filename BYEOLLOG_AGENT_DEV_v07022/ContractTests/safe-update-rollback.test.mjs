import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

function between(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `missing section: ${start}`);
  assert.notEqual(to, -1, `missing section end: ${end}`);
  return source.slice(from, to);
}

test("Collector state is snapshotted and validated before storage opens", async () => {
  const [lifecycle, program, storage, tests] = await Promise.all([
    readFile(new URL("CollectorStateLifecycle.cs", root), "utf8"),
    readFile(new URL("Program.cs", root), "utf8"),
    readFile(new URL("CollectorStorage.cs", root), "utf8"),
    readFile(new URL("AgentStoreTests/Program.cs", root), "utf8")
  ]);

  assert.ok(
    program.indexOf("CollectorStateLifecycle.Prepare") < program.indexOf("new CollectorStorage()"),
    "state guard must run before CollectorStorage reads or writes user data"
  );
  assert.match(lifecycle, /CreateSnapshotOnce/);
  assert.match(lifecycle, /snapshot-manifest\.json/);
  assert.match(lifecycle, /SHA256\.HashData/);
  assert.match(lifecycle, /state-schema\.json/);
  assert.match(lifecycle, /installedSchema > CurrentSchemaVersion/);
  assert.match(lifecycle, /PreserveCorruptAndRestore/);
  assert.match(lifecycle, /\.corrupt-/);
  assert.match(storage, /CollectorStateLifecycle\.AtomicWriteText\(_configPath/);
  assert.match(storage, /CollectorStateLifecycle\.AtomicWriteText\(_obsSettingsPath/);
  assert.match(storage, /CollectorStateLifecycle\.AtomicWriteText\(_sessionPath/);
  assert.match(tests, /same version does not overwrite its pre-start snapshot/);
  assert.match(tests, /older binaries fail closed on a newer state schema/);
});

test("installer verifies a complete manifest v2 package before switching the current version", async () => {
  const [installer, launcher, publisher, manifestBuilder] = await Promise.all([
    readFile(new URL("Install-Byeollog.ps1", root), "utf8"),
    readFile(new URL("Byeollog-Launcher.ps1", root), "utf8"),
    readFile(new URL("02_PUBLISH.cmd", root), "utf8"),
    readFile(new URL("New-ReleaseManifest.ps1", root), "utf8")
  ]);

  assert.match(installer, /\$allowedPackageFiles = \[ordered\]@\{/);
  assert.match(installer, /Test-PackageRelease -Root \$PSScriptRoot/);
  assert.match(installer, /Test-ChecksumIndex/);
  assert.match(installer, /Tester package contains an unexpected file/);
  assert.match(installer, /\.staging-/);
  assert.ok(
    installer.indexOf("Test-InstalledRelease -Root $staging") < installer.indexOf("Write-PointerVersion -Name \"current.json\""),
    "staged bytes must be verified before the current pointer changes"
  );
  assert.ok(
    installer.indexOf("Test-PackageRelease -Root $PSScriptRoot") < installer.indexOf("New-Item -ItemType Directory -Force -Path $installRoot"),
    "package validation must finish before the install root or lock is created"
  );
  assert.match(installer, /FileShare\]::None/);
  assert.match(installer, /Assert-CollectorStopped/);
  assert.match(installer, /Write-PointerVersion -Name "previous\.json"/);
  assert.match(launcher, /Get-FileHash -Algorithm SHA256/);
  assert.match(launcher, /Start-Process -FilePath \$exe/);
  assert.match(manifestBuilder, /schemaVersion = 2/);
  assert.match(manifestBuilder, /product = "byeollog-collector"/);
  assert.match(manifestBuilder, /role = "install_root"/);
  assert.match(manifestBuilder, /trusted_channel_internal/);
  assert.match(manifestBuilder, /authenticode_pinned/);
  assert.match(publisher, /New-ReleaseManifest\.ps1/);
  assert.match(publisher, /-Mode VerifyPackage/);
  assert.match(publisher, /INSTALL_OR_UPDATE\.cmd/);
  assert.match(publisher, /ROLLBACK_LAST_VERSION\.cmd/);
  assert.match(publisher, /RESTORE_PREUPDATE_STATE\.cmd/);
});

test("protocol v1 auto-update package changes only the application executable", async () => {
  const builder = await readFile(new URL("Build-v07040-AutoUpdate.ps1", root), "utf8");

  assert.match(builder, /sealed v0\.7\.0\.32 protocol baseline/);
  assert.match(builder, /Copy-Item -LiteralPath \$publishedExe -Destination \(Join-Path \$staging 'byeollog\.exe'\)/);
  assert.doesNotMatch(builder, /Copy-Item[^\r\n]+Install-Byeollog\.ps1[^\r\n]+\$staging/);
  assert.doesNotMatch(builder, /Name -in @\('byeollog\.exe',\s*'Install-Byeollog\.ps1'\)/);
  assert.match(builder, /Protocol v1 install-root file count drift/);
  assert.match(builder, /Protocol v1 baseline drift/);
});

test("app rollback blocks the bad version while state restore remains separately confirmed", async () => {
  const installer = await readFile(new URL("Install-Byeollog.ps1", root), "utf8");
  const installSection = between(installer, "function Install-Release", "function Switch-ToPreviousRelease");
  const rollbackSection = between(installer, "function Switch-ToPreviousRelease", "function Verify-CurrentRelease");
  const restoreSection = between(installer, "function Restore-StateSnapshot", "# VerifyPackage and the pre-install validation");

  assert.doesNotMatch(installSection, /Remove-Item[^\n]*\$dataRoot|Move-Item[^\n]*\$dataRoot/);
  assert.doesNotMatch(rollbackSection, /\$dataRoot/);
  assert.match(rollbackSection, /-cne "ROLLBACK"/);
  assert.match(rollbackSection, /current\.json/);
  assert.match(rollbackSection, /previous\.json/);
  assert.match(rollbackSection, /Write-RollbackUpdateBlock -Version \$current/);
  assert.match(installer, /blockedVersion = \$Version/);
  assert.match(installer, /manual_rollback_blocked_version/);
  assert.match(restoreSection, /-cne "RESTORE"/);
  assert.match(restoreSection, /emergency-before-restore-/);
  assert.ok(
    restoreSection.indexOf("emergency-before-restore-") < restoreSection.indexOf("Move-Item -LiteralPath $temporary -Destination $destination -Force"),
    "current state must be backed up before snapshot files replace it"
  );
});
