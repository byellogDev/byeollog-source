import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("a managed launch applies an update and continues directly in the new version", async () => {
  const [launcher, updater, program] = await Promise.all([
    source("Byeollog-Launcher.ps1"),
    source("AgentUpdateCore.cs"),
    source("Program.cs")
  ]);

  assert.match(launcher, /ArgumentList "--update-check"/);
  assert.match(updater, /Always check the tiny signed catalog once\s*\/\/ per launch/);
  assert.doesNotMatch(updater, /state\.NextCheckAtUtc[^\n]+return 0/);
  assert.equal((updater.match(/NextCheckAtUtc = null/g) ?? []).length, 4);
  assert.match(updater, /AcquireInstallLockAsync/);
  assert.match(updater, /UpdateInstalledExitCode = 10/);
  assert.match(updater, /return UpdateInstalledExitCode/);
  assert.match(updater, /return 0; \/\/ Update failures must never block the currently installed Agent\./);
  assert.match(program, /ContinueCurrentProcessOrRelaunch\(out isCurrentManagedProcess\)/);
  assert.match(program, /await RunUpdateCheckBeforeStartupAsync\(splash\.CancellationToken\)/);
  assert.match(program, /StartCurrentAfterProcessExit\(Environment\.ProcessId\)/);
  assert.match(program, /--continue-after-update/);
  assert.match(program, /WaitForPreviousProcessExit/);
  assert.match(program, /start\.ArgumentList\.Add\("--update-check"\)/);
  assert.match(program, /UseShellExecute = false/);
  assert.match(program, /CreateNoWindow = true/);
  assert.ok(
    program.indexOf("await Task.Yield()") <
      program.indexOf("await RunUpdateCheckBeforeStartupAsync(splash.CancellationToken)"),
    "the native splash must get a paint turn before starting the background update process"
  );
});
