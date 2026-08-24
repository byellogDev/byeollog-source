import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name) => readFile(new URL(`../Installer/${name}`, import.meta.url), "utf8");

test("official installer is a fixed per-user NSIS Modern UI setup with no visible CMD entrypoint", async () => {
  const setup = await source("ByeollogAgentSetup.nsi");

  assert.match(setup, /!include "MUI2\.nsh"/);
  assert.match(setup, /RequestExecutionLevel user/);
  assert.match(setup, /InstallDir "\$LOCALAPPDATA\\Programs\\ByeollogCollector"/);
  assert.doesNotMatch(setup, /MUI_PAGE_DIRECTORY|RequestExecutionLevel admin|UAC::/);
  assert.match(setup, /nsExec::ExecToStack[^\n]+-WindowStyle Hidden[^\n]+Invoke-OfficialInstall\.ps1/);
  assert.doesNotMatch(setup, /CreateShortCut[^\n]+\.cmd"/i);
  assert.match(setup, /CreateShortCut "\$SMPROGRAMS\\별록\.lnk"[^\n]+byeollog\.exe/);
  assert.match(setup, /CreateShortCut "\$SMPROGRAMS\\별록 최신\.lnk"[^\n]+byeollog\.exe/);
  assert.doesNotMatch(setup, /CreateShortCut[^\n]+powershell\.exe/i);
  assert.match(setup, /Function LaunchByeollog[\s\S]+Exec '\"\$INSTDIR\\versions\\\$InstalledVersion\\byeollog\.exe\"'[\s\S]+FunctionEnd/);
  assert.doesNotMatch(setup.match(/Function LaunchByeollog[\s\S]+?FunctionEnd/)?.[0] ?? "", /powershell|\.cmd/i);
  assert.match(setup, /IfFileExists "\$SMPROGRAMS\\별록\.lnk" start_menu_preferred_exists/);
  assert.match(setup, /IfFileExists "\$SMPROGRAMS\\별록 최신\.lnk" start_menu_shortcut_ready/);
  assert.match(setup, /Section \/o "바탕 화면 바로가기"/);
  assert.match(setup, /WriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ByeollogAgent"/);
  assert.match(setup, /QuietUninstallString/);
  assert.match(setup, /IfSilent silent_unsupported_x64 unsupported_x64/);
});

test("official install driver verifies the sealed payload and preserves a newer current version", async () => {
  const [driver, build] = await Promise.all([
    source("Invoke-OfficialInstall.ps1"),
    source("Build-Setup.ps1")
  ]);

  assert.match(driver, /\[version\]\$currentVersion -gt \[version\]\$EmbeddedVersion/);
  assert.match(driver, /-ExitCode 10 -Code "newer_version_preserved"/);
  assert.match(driver, /& \$embeddedEngine -Mode Verify/);
  assert.ok(
    driver.indexOf("[version]$currentVersion -gt [version]$EmbeddedVersion") <
      driver.indexOf("& $embeddedEngine -Mode Install"),
    "newer-version protection must run before the embedded installer"
  );
  assert.match(driver, /Get-Process -Name "byeollog"/);
  assert.match(driver, /\[IO\.FileShare\]::None/);
  assert.match(driver, /concurrent_newer_version_restored/);
  assert.match(driver, /& \$embeddedEngine -Mode Rollback/);
  assert.doesNotMatch(driver, /Stop-Process|taskkill|Kill\(/i);

  assert.match(build, /\[string\]\$PayloadPath/);
  assert.match(build, /\[string\]\$MakeNsisPath/);
  assert.match(build, /\[hashtable\]\$NsisProperties/);
  assert.match(build, /-Mode VerifyPackage/);
  assert.match(build, /packageLayout -ne "flat_v1"/);
  assert.match(build, /manifest\.version -ne \$EmbeddedVersion/);
  assert.match(build, /\[string\]\$SignCommandPath/);
  assert.match(build, /\[string\]\$UninstallerSignCommandPath/);
  assert.match(build, /EXPORT_UNINSTALLER/);
  assert.match(build, /IMPORT_UNINSTALLER/);
  assert.match(build, /Public signing must sign both the embedded Uninstall\.exe and the outer Setup\.exe/);
  assert.match(build, /Authenticode verification is not Valid/);
  assert.doesNotMatch(build, /BEGIN (?:RSA )?PRIVATE KEY|Export-PfxCertificate|\.pfx|certificatePassword/i);
});

test("uninstall is non-destructive to user data and both silent paths have stable logging and exits", async () => {
  const [setup, helper] = await Promise.all([
    source("ByeollogAgentSetup.nsi"),
    source("Invoke-OfficialUninstall.ps1")
  ]);
  const uninstall = setup.slice(setup.indexOf('Section "Uninstall"'));

  assert.match(uninstall, /Invoke-OfficialUninstall\.ps1/);
  assert.match(helper, /Get-Process -Name "byeollog"/);
  assert.match(helper, /\[IO\.FileShare\]::Delete/);
  assert.match(helper, /\.ByeollogCollector\.uninstall-/);
  assert.match(helper, /Move-Item -LiteralPath \$expectedRoot/);
  assert.match(helper, /Remove-Item -LiteralPath \$quarantine -Recurse -Force/);
  assert.doesNotMatch(uninstall, /Stop-Process|taskkill|Kill\(/i);
  assert.doesNotMatch(uninstall, /Delete "\$(?:SMPROGRAMS|DESKTOP)\\별록(?: 최신| 에이전트)?\.lnk"/);
  assert.match(helper, /function Remove-OwnedShortcut/);
  assert.match(helper, /별록\.lnk/);
  assert.match(helper, /별록 최신\.lnk/);
  assert.match(helper, /별록 에이전트\.lnk/);
  assert.match(helper, /StartsWith\(\$rootPrefix, \[StringComparison\]::OrdinalIgnoreCase\)/);
  assert.doesNotMatch(`${uninstall}\n${helper}`, /(?:RMDir \/r|Remove-Item[^\n]+) "?\$?(?:LOCALAPPDATA|env:LOCALAPPDATA)\\(?:ByeollogAgent|HurogiCollector)/i);
  assert.match(setup, /!uninstfinalize/);
  assert.match(setup, /SIGNED_UNINSTALLER_PATH/);
  assert.match(setup, /preserve_newer_uninstaller/);
  assert.match(setup, /ByeollogAgent-Setup\.log/);
  assert.match(setup, /SetErrorLevel 1618/);
  assert.match(setup, /SetErrorLevel 1603/);
  assert.match(setup, /SetErrorLevel 1633/);
  assert.match(setup, /SetErrorLevel 0/);
});
