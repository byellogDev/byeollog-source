import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");

test("managed launch follows only the fixed ByeollogCollector pointer after manifest and SHA verification", async () => {
  const [bridge, program] = await Promise.all([
    source("ManagedInstallLaunchBridge.cs"),
    source("Program.cs")
  ]);

  assert.match(bridge, /"Programs", "ByeollogCollector"/);
  assert.match(bridge, /if \(!running\.StartsWith\(versionsRoot, StringComparison\.OrdinalIgnoreCase\)\) return null/);
  assert.match(bridge, /RequiredString\(root, "product"\) != "byeollog-collector"/);
  assert.match(bridge, /RequiredString\(root, "version"\) != version/);
  assert.match(bridge, /SHA256\.HashData\(stream\)/);
  assert.match(bridge, /CryptographicOperations\.FixedTimeEquals/);
  assert.match(bridge, /FileAttributes\.ReparsePoint/);
  assert.doesNotMatch(bridge, /ByeollogVNextCollector|뉴별록 Collector DEV/);
  assert.ok(
    program.indexOf("ManagedInstallLaunchBridge.ContinueCurrentProcessOrRelaunch(out isCurrentManagedProcess)") <
      program.indexOf("new Mutex("),
    "a stale version must hand off before acquiring the shared application mutex"
  );
});

test("shortcut repair never overwrites or deletes another installation's entry", async () => {
  const [bridge, setup, uninstall] = await Promise.all([
    source("ManagedInstallLaunchBridge.cs"),
    source("Installer/ByeollogAgentSetup.nsi"),
    source("Installer/Invoke-OfficialUninstall.ps1")
  ]);

  assert.match(bridge, /ChooseManagedShortcutPath/);
  assert.match(bridge, /ShortcutBelongsToInstall\(preferred, installRoot\)/);
  assert.match(bridge, /ShortcutBelongsToInstall\(alternate, installRoot\)/);
  assert.match(bridge, /RepairExistingManagedShortcut/);
  assert.match(bridge, /Path\.Combine\(startMenuPrograms, "별록 에이전트\.lnk"\)/);
  assert.match(bridge, /RepairExistingManagedShortcut\(legacyNamedDesktopShortcut/);
  assert.match(bridge, /if \(!File\.Exists\(shortcutPath\) \|\| !ShortcutBelongsToInstall\(shortcutPath, installRoot\)\) return/);
  assert.match(bridge, /UseShellExecute = false/);
  assert.match(bridge, /CreateNoWindow = true/);
  assert.match(bridge, /WorkingDirectory/);
  assert.match(bridge, /IconLocation/);
  assert.match(bridge, /normalizedWorkingDirectory\.StartsWith\(normalizedRoot/);
  assert.match(bridge, /normalizedIconPath\.StartsWith\(normalizedRoot/);
  assert.match(bridge, /return null/);
  assert.match(bridge, /"별록\.lnk"/);
  assert.match(bridge, /"별록 최신\.lnk"/);
  assert.doesNotMatch(bridge, /File\.Delete|Directory\.Delete/);

  assert.match(setup, /IfFileExists "\$SMPROGRAMS\\별록\.lnk" start_menu_preferred_exists/);
  assert.match(setup, /IfFileExists "\$SMPROGRAMS\\별록 최신\.lnk" start_menu_shortcut_ready/);
  assert.match(uninstall, /Remove-OwnedShortcut/);
  assert.match(uninstall, /별록 에이전트\.lnk/);
  assert.doesNotMatch(uninstall, /Remove-Item[^\n]+ByeollogVNextCollector/);
});
