#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const VERSION = "0.7.0.32";
const VERSION_TAG = "v07032";
const INFORMATIONAL_VERSION = "0.7.0-public.30";
// Keep the installed/release wire identity stable. "별록 에이전트" is the
// user-facing name, not a new internal product identifier.
const PRODUCT = "byeollog-collector";
const TESTER_NAME = "byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64.zip";
const VNEXT_SOURCE_NAME = "BYEOLLOG_VNEXT_v0.30.1_ACTIVITY_PRIVACY_SOURCE.zip";
const VNEXT_CHECKPOINT_NAME = "BYEOLLOG_VNEXT_v0300_85PCT_ISOLATED_SOURCE_CHECKPOINT.zip";
const STABLE_SOURCE_NAME = "byeollog_collector_v0518_STABLE_SESSION_WEFLAB_HOTFIX_Source.zip";
const HANDOFF_NAME = "BYEOLLOG_AGENT_v07032_CONTINUATION_HANDOFF_20260823_KO.md";
const SOURCE_ZIP_NAME = "BYEOLLOG_AGENT_v07032_AUTO_UPDATE_BOOTSTRAP_SOURCE_CHECKPOINT_20260823.zip";
const COMPLETE_ZIP_NAME = "BYEOLLOG_AGENT_v07032_AUTO_UPDATE_BOOTSTRAP_COMPLETE_DEVELOPMENT_KIT.zip";
const SOURCE_CHECKSUM_NAME = "SOURCE_FILE_SHA256SUMS.txt";
const COMPONENT_CHECKSUM_NAME = "COMPONENT_SHA256SUMS.txt";
const PROVENANCE_NAME = "RELEASE_PROVENANCE_v070_RC2_OFFSL_SINGLE_LOGIN.json";
const README_START_NAME = "README_START_HERE_KO.md";
const FIXED_MODE = 0o644;
const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_COMPLETE_ZIP_BYTES = 1536 * 1024 * 1024;
const MAX_COMPONENT_TOTAL_BYTES = 1280 * 1024 * 1024;

const compileFiles = [
  "AdaptiveWindowController.cs",
  "AgentUpdateCore.cs",
  "AgentDataPaths.cs",
  "BroadcastMutationGate.cs",
  "BroadcastReadiness.cs",
  "BuildInfo.cs",
  "ByeollogOverlayService.cs",
  "CollectorAcceptanceCore.cs",
  "CollectorAcceptanceRunner.cs",
  "CollectorLoginForm.cs",
  "CollectorLoginWebForm.cs",
  "CollectorPreflight.cs",
  "CollectorReplayAcceptance.cs",
  "CollectorScript.cs",
  "CollectorStateLifecycle.cs",
  "RouletteResultParser.cs",
  "CollectorStorage.cs",
  "CoreAudioCaptureAdapter.cs",
  "CoreAudioNativeApi.cs",
  "HeaderControls.cs",
  "MainForm.cs",
  "ModernDateTimeField.cs",
  "NativeSqlite.cs",
  "NativeWindowDrag.cs",
  "ObsActionAdapter.cs",
  "ObsSettingsForm.cs",
  "ObsWebSocketClient.cs",
  "OverlayAssetCache.cs",
  "Program.cs",
  "TimedMuteActionAdapter.cs",
  "TimedMuteActionCore.cs",
  "TimedMuteRecoveryStore.cs",
  "UiAssetStore.cs",
  "VNextAgentStore.cs",
  "VNextActivityClient.cs",
  "VNextActivityMonitor.cs",
  "VNextAutomationClient.cs",
  "VNextAutomationRpcContract.cs",
  "VNextAutomationSettingsForm.cs",
  "VNextDevelopmentClient.cs",
  "VNextLocalAgent.cs",
  "VNextAgentCapabilities.cs",
  "VNextOverlayAssets.cs",
  "VNextSessionVault.cs",
  "VNextSourceIdentity.cs",
  "WebViewTrustPolicy.cs",
  "WindowsCaptureSettingsForm.cs"
];

const uiFiles = [
  "Ui/agent_automation.html",
  "Ui/byeollog_logo_dark_safe.png",
  "Ui/byeollog_logo_light_safe.png",
  "Ui/byeollog_ui.html"
];

const assetFiles = [
  "Assets/byeollog_app.ico",
  "Assets/byeollog_app_icon.png",
  "Assets/byeollog_mic_off_icon.png",
  "Assets/byeollog_mic_off_badge.png",
  "Assets/byeollog_mic_off_quiet.png",
  "Assets/byeollog_mic_off_signal_panel.png",
  "Assets/byeollog_mic_off_screenprint.png",
  "Assets/byeollog_mic_off_overlay.svg",
  "Assets/byeollog_symbol.png",
  "Assets/byeollog_symbol.svg",
  "Assets/hurogi_balloon.ico",
  "Assets/hurogi_balloon.png"
];

const testFiles = [
  "AgentStoreTests/AgentStoreTests.csproj",
  "AgentStoreTests/OverlayServiceTestStorage.cs",
  "AgentStoreTests/Program.cs",
  "ContractTests/activity-notification-monitor.test.mjs",
  "ContractTests/agent-auto-update.test.mjs",
  "ContractTests/agent-product-transition.test.mjs",
  "ContractTests/abong-ux-contract.test.mjs",
  "ContractTests/auth-lifecycle.test.mjs",
  "ContractTests/automation-launch-feedback.test.mjs",
  "ContractTests/broadcast-readiness.test.mjs",
  "ContractTests/clickonce-byte-preservation.test.mjs",
  "ContractTests/release-integrity-support.test.mjs",
  "ContractTests/safe-update-rollback.test.mjs",
  "ContractTests/time-weflab-session.test.mjs",
  "ContractTests/v0518-compatibility.test.mjs",
  "ContractTests/vnext-activity-surface.test.mjs",
  "ContractTests/vnext-overlay-contract.test.mjs",
  "ContractTests/vnext-secure-session-resume.test.mjs",
  "ContractTests/vnext-source-uid.test.mjs",
  "ContractTests/webview-trust-boundary.test.mjs"
];

const testFixtureFiles = [
  "ContractTests/fixtures/v0518-compatibility.json"
];

const databaseFiles = [
  "DatabaseMigrations/20260820_add_mic_off_position_presets.sql",
  "DatabaseMigrations/20260820_allow_windows_overlay_and_custom_duration.sql",
  "DatabaseMigrations/20260820_set_donation_exact_amount.sql",
  "DatabaseMigrations/20260820_add_rule_delete_and_overlay_position.sql",
  "DatabaseMigrations/20260820_add_overlay_scale_distinct_assets_and_safe_save.sql",
  "DatabaseMigrations/20260820_remove_overlay_approval_and_save_guided_rule_v7.sql",
  "DatabaseMigrations/20260820_fix_save_guided_rule_v7_mirror_key.sql",
  "supabase/migrations/20260820034459_add_action_test_dispatch.sql",
  "supabase/migrations/20260820044525_enforce_active_manager_session.sql",
  "supabase/migrations/20260820052623_fix_save_guided_rule_v7_ambiguous_rule_id.sql"
];

const serverPatchFiles = [
  "ServerPatches/agent-runtime-g3a-v4-mic-off-presets.md"
];

const scriptFiles = [
  "00_BUILD_AND_INSTALL_PUBLIC_FIX.cmd",
  "00_BUILD_V070_RC2_ONE_CLICK.cmd",
  "00_CHECK_ENV.cmd",
  "01_INSTALL_DOTNET8_SDK.cmd",
  "02_PUBLISH.cmd",
  "Byeollog-Launcher.ps1",
  "Build-ClickOnceBeta.ps1",
  "CREATE_SUPPORT_BUNDLE.cmd",
  "Collect-SupportBundle.ps1",
  "INSTALL_AND_CHECK.cmd",
  "INSTALL_OR_UPDATE.cmd",
  "Install-Byeollog.ps1",
  "LAUNCH_BYEOLLOG.cmd",
  "New-ReleaseManifest.ps1",
  "New-AgentUpdateCatalog.ps1",
  "RESTORE_PREUPDATE_STATE.cmd",
  "ROLLBACK_LAST_VERSION.cmd",
  "RUN_G4_CANARY_PREP.cmd",
  "RUN_REPLAY_CANDIDATE_CHECK.cmd",
  "RUN_TESTER_READINESS.cmd",
  "Seal-TesterZip.ps1",
  "Sign-PublicRelease.ps1",
  "Test-TesterEnvironment.ps1",
  "Verify-ClickOnceBeta.ps1",
  "VERIFY_INSTALL.cmd"
];

const documentationFiles = [
  "PUBLIC_PATH_FIX_0704_KO.txt",
  "BYEOLLOG_AGENT_v0704_PUBLIC_PATH_FIX_HANDOFF_KO.md",
  "README_TESTER_v070_RC2_KO.txt",
  "G4_CANARY_v070_RC2_KO.md",
  "RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt",
  "VALIDATION_v070_RC2_OFFSL_SINGLE_LOGIN_KO.txt",
  "BUILD_SOURCE_v070_RC2_KO.txt",
  "CLICKONCE_BETA_RELEASE_v070_RC2_KO.md",
  "OFFSL_VNEXT_MIGRATION_PLAN_v070_RC2_KO.md"
];

const configurationFiles = [
  ".config/dotnet-tools.json",
  "global.json",
  "Properties/PublishProfiles/ByeollogBetaClickOnce.pubxml"
];

const toolingFiles = [
  "tools/package-tester-linux.mjs",
  "tools/package-complete-release-linux.mjs"
];

const sourceDefinitions = [
  ...compileFiles.map((path) => ({ path, role: "compile" })),
  { path: "HurogiCollector.csproj", role: "compile" },
  ...uiFiles.map((path) => ({ path, role: "ui" })),
  ...assetFiles.map((path) => ({ path, role: "asset" })),
  ...testFiles.map((path) => ({ path, role: "test" })),
  ...testFixtureFiles.map((path) => ({ path, role: "test-fixture" })),
  ...databaseFiles.map((path) => ({ path, role: "database-migration" })),
  ...serverPatchFiles.map((path) => ({ path, role: "server-patch" })),
  ...scriptFiles.map((path) => ({ path, role: "script" })),
  ...documentationFiles.map((path) => ({ path, role: "documentation" })),
  ...configurationFiles.map((path) => ({ path, role: "configuration" })),
  ...toolingFiles.map((path) => ({ path, role: "tooling" }))
].map((entry) => Object.freeze({ ...entry, maxBytes: MAX_SOURCE_FILE_BYTES }));

const exactDirectoryInventories = [
  { directory: "Ui", expected: uiFiles.map((path) => basename(path)), filter: () => true },
  { directory: "Assets", expected: assetFiles.map((path) => basename(path)), filter: () => true },
  {
    directory: "AgentStoreTests",
    expected: testFiles.filter((path) => path.startsWith("AgentStoreTests/")).map((path) => basename(path)),
    filter: (name) => name.endsWith(".cs") || name.endsWith(".csproj")
  },
  {
    directory: "ContractTests",
    expected: testFiles.filter((path) => path.startsWith("ContractTests/")).map((path) => basename(path)),
    filter: (name) => name.endsWith(".test.mjs")
  },
  {
    directory: "DatabaseMigrations",
    expected: databaseFiles
      .filter((path) => path.startsWith("DatabaseMigrations/"))
      .map((path) => basename(path)),
    filter: (name) => name.endsWith(".sql")
  },
  {
    directory: "supabase/migrations",
    expected: databaseFiles
      .filter((path) => path.startsWith("supabase/migrations/"))
      .map((path) => basename(path)),
    filter: (name) => name.endsWith(".sql")
  },
  {
    directory: "ServerPatches",
    expected: serverPatchFiles.map((path) => basename(path)),
    filter: (name) => name.endsWith(".md")
  },
  {
    directory: "tools",
    expected: toolingFiles.map((path) => basename(path)),
    filter: (name) => name.startsWith("package-") && name.endsWith(".mjs")
  },
  {
    directory: ".config",
    expected: ["dotnet-tools.json"],
    filter: () => true
  },
  {
    directory: "Properties/PublishProfiles",
    expected: ["ByeollogBetaClickOnce.pubxml"],
    filter: () => true
  }
];

function usage() {
  return `Usage:
  node tools/package-complete-release-linux.mjs \\
    --source-only \\
    --project-root <work/v070_RC2/agent> \\
    --output-root <release/v070_RC2_source> \\
    --handoff <release/v070_RC2_inputs/${HANDOFF_NAME}> [--dry-run]

  node tools/package-complete-release-linux.mjs \\
    --project-root <work/v070_RC2/agent> \\
    --output-root <release/v070_RC2_final> \\
    --final-exe <release/v070_RC2_inputs/byeollog_agent_v070_RC2_OFFSL_SINGLE_LOGIN.exe> \\
    --tester-zip <release/v070_RC2_inputs/${TESTER_NAME}> \\
    --vnext-source <release/v070_RC2_inputs/${VNEXT_SOURCE_NAME}> \\
    --vnext-checkpoint <source/${VNEXT_CHECKPOINT_NAME}> \\
    --stable-source <source/${STABLE_SOURCE_NAME}> \\
    --handoff <release/v070_RC2_inputs/${HANDOFF_NAME}> [--dry-run]

The output directory must already exist. Source-only mode creates only the
curated source ZIP and sidecar and does not require an EXE or Tester ZIP.
--dry-run performs the applicable input, inventory, and safety checks without
writing artifacts.`;
}

function parseArgs(argv) {
  const valueFlags = new Set([
    "--project-root",
    "--output-root",
    "--final-exe",
    "--tester-zip",
    "--vnext-source",
    "--vnext-checkpoint",
    "--stable-source",
    "--handoff"
  ]);
  const values = new Map();
  let dryRun = false;
  let sourceOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--dry-run") {
      if (dryRun) throw new Error("Duplicate argument: --dry-run");
      dryRun = true;
      continue;
    }
    if (argument === "--source-only") {
      if (sourceOnly) throw new Error("Duplicate argument: --source-only");
      sourceOnly = true;
      continue;
    }
    if (!valueFlags.has(argument)) throw new Error(`Unknown argument: ${argument}`);
    if (values.has(argument)) throw new Error(`Duplicate argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
    values.set(argument, resolve(value));
    index += 1;
  }
  const requiredFlags = sourceOnly
    ? new Set(["--project-root", "--output-root", "--handoff"])
    : valueFlags;
  for (const name of requiredFlags) {
    if (!values.has(name)) throw new Error(`Missing required argument: ${name}`);
  }
  if (sourceOnly) {
    for (const name of ["--final-exe", "--tester-zip", "--vnext-source", "--vnext-checkpoint", "--stable-source"]) {
      if (values.has(name)) throw new Error(`${name} is not accepted with --source-only.`);
    }
  }
  return {
    help: false,
    dryRun,
    sourceOnly,
    projectRoot: values.get("--project-root"),
    outputRoot: values.get("--output-root"),
    finalExe: values.get("--final-exe"),
    testerZip: values.get("--tester-zip"),
    vnextSource: values.get("--vnext-source"),
    vnextCheckpoint: values.get("--vnext-checkpoint"),
    stableSource: values.get("--stable-source"),
    handoff: values.get("--handoff")
  };
}

function compareNames(left, right) {
  return left.localeCompare(right, "en");
}

function sameList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertSafeRelativePath(value, { allowDirectory = false } = {}) {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0") || value.includes("\\")) {
    throw new Error("Archive path is empty or uses an unsafe separator.");
  }
  const directory = value.endsWith("/");
  if (directory && !allowDirectory) throw new Error(`Unexpected directory entry: ${value}`);
  const core = directory ? value.slice(0, -1) : value;
  if (!core || core.startsWith("/") || /^[A-Za-z]:/u.test(core)) {
    throw new Error(`Absolute archive path is forbidden: ${value}`);
  }
  const segments = core.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Archive path traversal is forbidden: ${value}`);
  }
  if (posix.normalize(core) !== core) throw new Error(`Archive path is not normalized: ${value}`);
  return value;
}

function assertSafeFlatName(value, label) {
  assertSafeRelativePath(value);
  if (value.includes("/")) throw new Error(`${label} must be a flat archive name.`);
  return value;
}

function assertExpectedBasename(path, expected, label) {
  if (basename(path) !== expected) {
    throw new Error(`${label} filename must be exactly ${expected}.`);
  }
}

function assertContained(root, path, label) {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const relation = relative(normalizedRoot, normalizedPath);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`) || relation.startsWith(sep)) {
    throw new Error(`${label} must be a child of its declared root.`);
  }
  return normalizedPath;
}

async function assertDirectory(path, label) {
  const item = await lstat(path);
  if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`${label} is not a real directory.`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} traverses a symbolic link.`);
}

async function assertRegularFile(path, label, maximumBytes) {
  const item = await lstat(path);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error(`${label} is not a regular file.`);
  if (item.size < 1 || item.size > maximumBytes) throw new Error(`${label} size is outside its boundary.`);
  if (await realpath(path) !== resolve(path)) throw new Error(`${label} traverses a symbolic link.`);
  return item;
}

async function assertProjectFile(projectRoot, relativePath, label, maximumBytes) {
  assertSafeRelativePath(relativePath);
  const absolutePath = assertContained(projectRoot, join(projectRoot, relativePath), label);
  let current = projectRoot;
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = join(current, segments[index]);
    const item = await lstat(current);
    if (item.isSymbolicLink()) throw new Error(`${label} traverses a symbolic link.`);
    if (index < segments.length - 1 && !item.isDirectory()) throw new Error(`${label} parent is not a directory.`);
    if (index === segments.length - 1) {
      if (!item.isFile() || item.size < 1 || item.size > maximumBytes) {
        throw new Error(`${label} is not a bounded regular file.`);
      }
      return { absolutePath, item };
    }
  }
  throw new Error(`${label} could not be resolved.`);
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" }
  });
  if (result.error) throw new Error(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : "."}`);
  }
  return result.stdout;
}

let archiveToolset = null;

function requireArchiveTools() {
  const infoZipTools = [["zip", ["-v"]], ["unzip", ["-v"]], ["zipinfo", ["-h"]]];
  const infoZipReady = infoZipTools.every(([command, args]) => {
    const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    return !result.error && result.status === 0;
  });
  if (infoZipReady) {
    archiveToolset = "infozip";
    return;
  }
  const tar = spawnSync("tar", ["--version"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (!tar.error && tar.status === 0) {
    archiveToolset = "bsdtar";
    return;
  }
  throw new Error("Required archive tools are unavailable: Info-ZIP or bsdtar is required.");
}

function listZipEntries(path) {
  const output = archiveToolset === "infozip"
    ? run("unzip", ["-Z1", path], dirname(path))
    : run("tar", ["-tf", path], dirname(path));
  return output.split(/\r?\n/u).filter(Boolean);
}

function zipTypeRows(path) {
  const output = archiveToolset === "infozip"
    ? run("zipinfo", ["-l", path], dirname(path))
    : run("tar", ["-tvf", path], dirname(path));
  return output.split(/\r?\n/u).filter((line) => /^[dhlpscb-][rwxStTs-]{9}\s/u.test(line));
}

function createZip(path, entries, cwd) {
  if (archiveToolset === "infozip") run("zip", ["-q", "-X", "-9", path, ...entries], cwd);
  else run("tar", ["-a", "-cf", path, ...entries], cwd);
}

async function validateZip(path, label, maximumBytes, expectedEntries = null) {
  await assertRegularFile(path, label, maximumBytes);
  if (archiveToolset === "infozip") run("unzip", ["-tqq", path], dirname(path));
  const rawEntries = listZipEntries(path);
  if (rawEntries.length < 1) throw new Error(`${label} is empty.`);
  const seen = new Set();
  const seenWindowsKeys = new Set();
  for (const entry of rawEntries) {
    assertSafeRelativePath(entry, { allowDirectory: true });
    if (!seen.add(entry)) throw new Error(`${label} contains a duplicate archive entry: ${entry}`);
    const core = entry.endsWith("/") ? entry.slice(0, -1) : entry;
    const windowsKey = core.toLowerCase();
    if (!seenWindowsKeys.add(windowsKey)) {
      throw new Error(`${label} contains a case-insensitive or file/directory path collision: ${entry}`);
    }
  }
  const typedRows = zipTypeRows(path);
  if (typedRows.length !== rawEntries.length) throw new Error(`${label} entry types could not be verified.`);
  if (typedRows.some((line) => line[0] !== "-" && line[0] !== "d")) {
    throw new Error(`${label} contains a symbolic link or unsupported archive entry.`);
  }
  const fileKeys = new Set();
  for (let index = 0; index < rawEntries.length; index += 1) {
    const entry = rawEntries[index];
    const metadataDirectory = typedRows[index][0] === "d";
    if (metadataDirectory !== entry.endsWith("/")) {
      throw new Error(`${label} has inconsistent file/directory metadata: ${entry}`);
    }
    if (!metadataDirectory) fileKeys.add(entry.toLowerCase());
  }
  for (const entry of rawEntries) {
    const core = (entry.endsWith("/") ? entry.slice(0, -1) : entry).toLowerCase();
    const segments = core.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (fileKeys.has(ancestor)) {
        throw new Error(`${label} contains a file used as an ancestor directory: ${entry}`);
      }
    }
  }
  const sorted = [...rawEntries].sort(compareNames);
  if (expectedEntries !== null) {
    const expected = [...expectedEntries].sort(compareNames);
    if (!sameList(sorted, expected)) throw new Error(`${label} inventory does not match the sealed inventory.`);
  }
  return rawEntries;
}

function parseChecksumText(text, label) {
  if (typeof text !== "string" || !text.endsWith("\n")) throw new Error(`${label} must end with one newline.`);
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 1 || lines.some((line) => line.includes("\r"))) throw new Error(`${label} format is invalid.`);
  const result = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  (.+)$/u.exec(line);
    if (!match) throw new Error(`${label} contains an invalid checksum line.`);
    const name = assertSafeRelativePath(match[2]);
    if (result.has(name)) throw new Error(`${label} contains a duplicate path: ${name}`);
    result.set(name, match[1]);
  }
  return result;
}

async function validateSidecar(componentPath, label) {
  const sidecarPath = `${componentPath}.sha256.txt`;
  await assertRegularFile(sidecarPath, `${label} SHA-256 sidecar`, 1024 * 1024);
  const checksums = parseChecksumText(await readFile(sidecarPath, "ascii"), `${label} SHA-256 sidecar`);
  if (checksums.size !== 1 || checksums.get(basename(componentPath)) !== await sha256(componentPath)) {
    throw new Error(`${label} SHA-256 sidecar does not match its component.`);
  }
  return sidecarPath;
}

async function assertExactDirectoryInventory(projectRoot, definition) {
  const directoryPath = join(projectRoot, definition.directory);
  const entries = await readdir(directoryPath, { withFileTypes: true });
  const actual = [];
  for (const entry of entries) {
    if (!definition.filter(entry.name)) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`${definition.directory}/${entry.name} is not a regular curated file.`);
    }
    actual.push(entry.name);
  }
  actual.sort(compareNames);
  const expected = [...definition.expected].sort(compareNames);
  if (!sameList(actual, expected)) {
    throw new Error(`${definition.directory} curated inventory drifted. Expected [${expected.join(", ")}], found [${actual.join(", ")}].`);
  }
}

async function validateSourceInventory(projectRoot) {
  const seen = new Set();
  const excludedSegments = new Set(["bin", "obj", "DIST", "Archive"]);
  for (const definition of sourceDefinitions) {
    assertSafeRelativePath(definition.path);
    if (definition.path.split("/").some((segment) => excludedSegments.has(segment))) {
      throw new Error(`Excluded source path entered the curated inventory: ${definition.path}`);
    }
    if (!seen.add(definition.path)) throw new Error(`Duplicate curated source path: ${definition.path}`);
    await assertProjectFile(projectRoot, definition.path, definition.path, definition.maxBytes);
  }
  const rootEntries = await readdir(projectRoot, { withFileTypes: true });
  const actualCompile = rootEntries
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".cs"))
    .map((entry) => entry.name).sort(compareNames);
  const expectedCompile = [...compileFiles].sort(compareNames);
  if (!sameList(actualCompile, expectedCompile)) {
    throw new Error(`Root compile inventory drifted. Expected [${expectedCompile.join(", ")}], found [${actualCompile.join(", ")}].`);
  }
  for (const definition of exactDirectoryInventories) {
    await assertExactDirectoryInventory(projectRoot, definition);
  }
  return [...sourceDefinitions].sort((left, right) => compareNames(left.path, right.path));
}

async function safeOutputTargets(outputRoot, sourceOnly = false) {
  const names = sourceOnly ? [
    SOURCE_ZIP_NAME,
    `${SOURCE_ZIP_NAME}.sha256.txt`
  ] : [
    SOURCE_ZIP_NAME,
    `${SOURCE_ZIP_NAME}.sha256.txt`,
    COMPLETE_ZIP_NAME,
    `${COMPLETE_ZIP_NAME}.sha256.txt`
  ];
  for (const name of names) {
    assertSafeFlatName(name, "Output name");
    const path = join(outputRoot, name);
    try {
      await lstat(path);
      throw new Error(`immutable-output-conflict: ${name} already exists; release outputs are append-only.`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return names;
}

async function copyStableFile(source, destination, expectedHash, generatedAt) {
  const before = await lstat(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await chmod(destination, FIXED_MODE);
  await utimes(destination, generatedAt, generatedAt);
  const after = await lstat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error(`Input changed while it was copied: ${basename(source)}`);
  }
  const copiedHash = await sha256(destination);
  if (copiedHash !== expectedHash || copiedHash !== await sha256(source)) {
    throw new Error(`Copied bytes do not match the validated input: ${basename(source)}`);
  }
}

async function extractZip(zipPath, destination) {
  await mkdir(destination, { recursive: true });
  if (archiveToolset === "infozip") run("unzip", ["-qq", zipPath, "-d", destination], dirname(zipPath));
  else run("tar", ["-xf", zipPath, "-C", destination], dirname(zipPath));
}

async function verifyExtractedTree(root, expectedFileEntries) {
  const found = [];
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const archiveName = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeRelativePath(archiveName, { allowDirectory: entry.isDirectory() });
      const path = join(directory, entry.name);
      const item = await lstat(path);
      if (item.isSymbolicLink()) throw new Error(`Round-trip extraction created a symbolic link: ${archiveName}`);
      if (item.isDirectory()) await visit(path, archiveName);
      else if (item.isFile()) found.push(archiveName);
      else throw new Error(`Round-trip extraction created an unsupported entry: ${archiveName}`);
    }
  }
  await visit(root, "");
  found.sort(compareNames);
  const expected = [...expectedFileEntries].sort(compareNames);
  if (!sameList(found, expected)) throw new Error("Round-trip extracted inventory does not match the sealed inventory.");
}

async function createSourceArchive(projectRoot, handoffPath, tempRoot, generatedAt) {
  const definitions = await validateSourceInventory(projectRoot);
  const stageRoot = join(tempRoot, "source-stage");
  await mkdir(stageRoot, { recursive: true });
  const checksums = new Map();
  let totalBytes = 0;
  for (const definition of definitions) {
    const source = join(projectRoot, definition.path);
    const item = await lstat(source);
    totalBytes += item.size;
    if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw new Error("Curated source inventory exceeds its total size boundary.");
    const hash = await sha256(source);
    await copyStableFile(source, join(stageRoot, definition.path), hash, generatedAt);
    checksums.set(definition.path, hash);
  }
  if (checksums.has(HANDOFF_NAME) || checksums.has(README_START_NAME) || checksums.has(SOURCE_CHECKSUM_NAME)) {
    throw new Error("Reserved SOURCE_ONLY archive name entered the curated project inventory.");
  }
  const handoffItem = await assertRegularFile(handoffPath, "SOURCE_ONLY handoff", 4 * 1024 * 1024);
  // Keep the canonical handoff name because the Windows source-contract suite
  // reads it directly. README_START_HERE_KO.md is a byte-identical convenience
  // copy for humans opening the archive.
  totalBytes += handoffItem.size * 2;
  if (totalBytes > MAX_SOURCE_TOTAL_BYTES) throw new Error("Curated source inventory exceeds its total size boundary.");
  const handoffHash = await sha256(handoffPath);
  await copyStableFile(handoffPath, join(stageRoot, HANDOFF_NAME), handoffHash, generatedAt);
  checksums.set(HANDOFF_NAME, handoffHash);
  await copyStableFile(handoffPath, join(stageRoot, README_START_NAME), handoffHash, generatedAt);
  checksums.set(README_START_NAME, handoffHash);
  const checksumText = `${[...checksums.entries()]
    .sort(([left], [right]) => compareNames(left, right))
    .map(([name, hash]) => `${hash}  ${name}`).join("\n")}\n`;
  const checksumPath = join(stageRoot, SOURCE_CHECKSUM_NAME);
  await writeFile(checksumPath, checksumText, { encoding: "ascii", flag: "wx", mode: FIXED_MODE });
  await utimes(checksumPath, generatedAt, generatedAt);

  const archiveEntries = [
    ...definitions.map((entry) => entry.path),
    HANDOFF_NAME,
    README_START_NAME,
    SOURCE_CHECKSUM_NAME
  ].sort(compareNames);
  const zipPath = join(tempRoot, SOURCE_ZIP_NAME);
  createZip(zipPath, archiveEntries, stageRoot);
  await validateZip(zipPath, "SOURCE_ONLY ZIP", MAX_SOURCE_ZIP_BYTES, archiveEntries);

  const roundTripRoot = join(tempRoot, "source-roundtrip");
  await extractZip(zipPath, roundTripRoot);
  await verifyExtractedTree(roundTripRoot, archiveEntries);
  const parsed = parseChecksumText(
    await readFile(join(roundTripRoot, SOURCE_CHECKSUM_NAME), "ascii"),
    SOURCE_CHECKSUM_NAME);
  if (parsed.size !== checksums.size) throw new Error("SOURCE_ONLY checksum inventory size changed after round-trip.");
  for (const [name, hash] of checksums) {
    if (parsed.get(name) !== hash || await sha256(join(roundTripRoot, name)) !== hash) {
      throw new Error(`SOURCE_ONLY round-trip checksum mismatch: ${name}`);
    }
  }
  return {
    path: zipPath,
    byteSize: (await stat(zipPath)).size,
    sha256: await sha256(zipPath),
    sourceFileCount: checksums.size,
    sourceTotalBytes: totalBytes,
    readmeSha256: handoffHash
  };
}

function canonicalSidecar(hash, archiveName) {
  assertSafeFlatName(archiveName, "Checksum target");
  return `${hash}  ${archiveName}\n`;
}

async function validateFinalInputs(options) {
  assertExpectedBasename(options.finalExe, `byeollog_agent_${VERSION_TAG}_OFFSL_SINGLE_LOGIN.exe`, "Final EXE");
  assertExpectedBasename(options.testerZip, TESTER_NAME, "Tester ZIP");
  assertExpectedBasename(options.vnextSource, VNEXT_SOURCE_NAME, "vNext final source");
  assertExpectedBasename(options.vnextCheckpoint, VNEXT_CHECKPOINT_NAME, "vNext isolated source checkpoint");
  assertExpectedBasename(options.stableSource, STABLE_SOURCE_NAME, "Stable original source");
  assertExpectedBasename(options.handoff, HANDOFF_NAME, "Handoff");

  const distinctInputs = [
    options.finalExe,
    options.testerZip,
    options.vnextSource,
    options.vnextCheckpoint,
    options.stableSource,
    options.handoff
  ]
    .map((path) => resolve(path));
  if (new Set(distinctInputs).size !== distinctInputs.length) throw new Error("Final inputs must be distinct files.");

  const exeItem = await assertRegularFile(options.finalExe, "Final EXE", 512 * 1024 * 1024);
  const signature = Buffer.alloc(2);
  const exeHandle = await open(options.finalExe, "r");
  try {
    const read = await exeHandle.read(signature, 0, signature.length, 0);
    if (read.bytesRead !== signature.length) throw new Error("Final EXE header is truncated.");
  } finally {
    await exeHandle.close();
  }
  if (signature.length !== 2 || signature[0] !== 0x4d || signature[1] !== 0x5a) throw new Error("Final EXE is not a Windows PE file.");
  const exeSidecar = await validateSidecar(options.finalExe, "Final EXE");
  const exeHash = await sha256(options.finalExe);

  await validateZip(options.testerZip, "Tester ZIP", 768 * 1024 * 1024);
  const testerEntries = listZipEntries(options.testerZip);
  if (testerEntries.filter((entry) => entry === "byeollog.exe").length !== 1) {
    throw new Error("Tester ZIP must contain exactly one flat byeollog.exe.");
  }
  const testerSidecar = await validateSidecar(options.testerZip, "Tester ZIP");

  await validateZip(options.vnextSource, "vNext final source", 256 * 1024 * 1024);
  const vnextSidecar = await validateSidecar(options.vnextSource, "vNext final source");
  await validateZip(options.vnextCheckpoint, "vNext isolated source checkpoint", 256 * 1024 * 1024);
  const vnextItem = await lstat(options.vnextSource);
  const checkpointItem = await lstat(options.vnextCheckpoint);
  if (vnextItem.dev === checkpointItem.dev && vnextItem.ino === checkpointItem.ino) {
    throw new Error("vNext final source and isolated checkpoint must be separate files.");
  }
  await validateZip(options.stableSource, "Stable original source", 256 * 1024 * 1024);
  await assertRegularFile(options.handoff, "Handoff", 4 * 1024 * 1024);

  const temp = await mkdtemp(join(tmpdir(), "byeollog-v070_RC2-exe-compare-"));
  try {
    if (archiveToolset === "infozip")
      run("unzip", ["-qq", options.testerZip, "byeollog.exe", "-d", temp], dirname(options.testerZip));
    else
      run("tar", ["-xf", options.testerZip, "-C", temp, "byeollog.exe"], dirname(options.testerZip));
    const testerExe = join(temp, "byeollog.exe");
    const testerExeItem = await assertRegularFile(testerExe, "Tester embedded EXE", 512 * 1024 * 1024);
    if (testerExeItem.size !== exeItem.size || await sha256(testerExe) !== exeHash) {
      throw new Error("Final EXE does not match the EXE sealed inside the Tester ZIP.");
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }

  return {
    exeSidecar,
    testerSidecar,
    vnextSidecar
  };
}

async function writeCanonicalFile(path, content, generatedAt) {
  await writeFile(path, content, { encoding: "utf8", flag: "wx", mode: FIXED_MODE });
  await utimes(path, generatedAt, generatedAt);
}

async function createCompleteKit(options, tempRoot, sourceArchive, generatedAt, validatedInputs) {
  const kitRoot = join(tempRoot, "complete-kit-stage");
  await mkdir(kitRoot, { recursive: true });
  const primary = [
    { archiveName: SOURCE_ZIP_NAME, sourceKind: "generated_source_archive", sourcePath: sourceArchive.path, maxBytes: MAX_SOURCE_ZIP_BYTES },
    { archiveName: "byeollog.exe", sourceKind: "final_executable", sourcePath: options.finalExe, maxBytes: 512 * 1024 * 1024 },
    { archiveName: TESTER_NAME, sourceKind: "tester_archive", sourcePath: options.testerZip, maxBytes: 768 * 1024 * 1024 },
    { archiveName: VNEXT_SOURCE_NAME, sourceKind: "vnext_final_source", sourcePath: options.vnextSource, maxBytes: 256 * 1024 * 1024 },
    { archiveName: VNEXT_CHECKPOINT_NAME, sourceKind: "vnext_isolated_source_checkpoint", sourcePath: options.vnextCheckpoint, maxBytes: 256 * 1024 * 1024 },
    { archiveName: STABLE_SOURCE_NAME, sourceKind: "stable_original_source", sourcePath: options.stableSource, maxBytes: 256 * 1024 * 1024 },
    ...documentationFiles.map((archiveName) => ({
      archiveName,
      sourceKind: "release_documentation",
      sourcePath: join(options.projectRoot, archiveName),
      maxBytes: 4 * 1024 * 1024
    })),
    { archiveName: README_START_NAME, sourceKind: "handoff", sourcePath: options.handoff, maxBytes: 4 * 1024 * 1024 }
  ];
  const names = new Set();
  const records = [];
  let totalBytes = 0;
  for (const component of primary) {
    assertSafeFlatName(component.archiveName, "Complete-kit component");
    if (!names.add(component.archiveName)) throw new Error(`Duplicate complete-kit archive name: ${component.archiveName}`);
    const item = await assertRegularFile(component.sourcePath, component.archiveName, component.maxBytes);
    const hash = await sha256(component.sourcePath);
    await copyStableFile(component.sourcePath, join(kitRoot, component.archiveName), hash, generatedAt);
    totalBytes += item.size;
    records.push({
      archiveName: component.archiveName,
      sourceKind: component.sourceKind,
      byteSize: item.size,
      sha256: hash
    });
  }

  const sidecars = [
    { target: SOURCE_ZIP_NAME, inputSidecar: null },
    { target: "byeollog.exe", inputSidecar: validatedInputs.exeSidecar },
    { target: TESTER_NAME, inputSidecar: validatedInputs.testerSidecar },
    { target: VNEXT_SOURCE_NAME, inputSidecar: validatedInputs.vnextSidecar }
  ];
  for (const sidecar of sidecars) {
    const target = records.find((record) => record.archiveName === sidecar.target);
    if (!target) throw new Error(`Checksum target is missing from complete kit: ${sidecar.target}`);
    if (sidecar.inputSidecar !== null) {
      const inputMap = parseChecksumText(await readFile(sidecar.inputSidecar, "ascii"), basename(sidecar.inputSidecar));
      const expectedInputName = sidecar.target === "byeollog.exe" ? basename(options.finalExe) : sidecar.target;
      if (inputMap.size !== 1 || inputMap.get(expectedInputName) !== target.sha256) {
        throw new Error(`Validated sidecar changed before complete-kit assembly: ${sidecar.target}`);
      }
    }
    const archiveName = `${sidecar.target}.sha256.txt`;
    if (!names.add(archiveName)) throw new Error(`Duplicate complete-kit archive name: ${archiveName}`);
    const content = canonicalSidecar(target.sha256, sidecar.target);
    const path = join(kitRoot, archiveName);
    await writeCanonicalFile(path, content, generatedAt);
    const item = await stat(path);
    totalBytes += item.size;
    records.push({ archiveName, sourceKind: "sha256_sidecar", byteSize: item.size, sha256: await sha256(path) });
  }
  if (totalBytes > MAX_COMPONENT_TOTAL_BYTES) throw new Error("Complete-kit components exceed their total size boundary.");

  records.sort((left, right) => compareNames(left.archiveName, right.archiveName));
  const provenance = {
    schemaVersion: 1,
    product: PRODUCT,
    version: VERSION,
    informationalVersion: INFORMATIONAL_VERSION,
    generatedAtUtc: generatedAt.toISOString(),
    inputs: records.map((record) => ({
      archiveName: record.archiveName,
      sourceKind: record.sourceKind,
      byteSize: record.byteSize,
      sha256: record.sha256
    }))
  };
  const provenanceText = `${JSON.stringify(provenance, null, 2)}\n`;
  if (/\/(?:home|root|workspace)\/|[A-Za-z]:\\|service[_-]?role|access[_-]?token|refresh[_-]?token|device[_-]?secret/iu.test(provenanceText)) {
    throw new Error("Generated provenance contains an absolute path or secret-shaped field.");
  }
  const provenancePath = join(kitRoot, PROVENANCE_NAME);
  await writeCanonicalFile(provenancePath, provenanceText, generatedAt);
  const provenanceItem = await stat(provenancePath);
  const provenanceRecord = {
    archiveName: PROVENANCE_NAME,
    sourceKind: "generated_provenance",
    byteSize: provenanceItem.size,
    sha256: await sha256(provenancePath)
  };
  if (!names.add(PROVENANCE_NAME)) throw new Error(`Duplicate complete-kit archive name: ${PROVENANCE_NAME}`);
  records.push(provenanceRecord);
  records.sort((left, right) => compareNames(left.archiveName, right.archiveName));

  const componentText = `${records.map((record) => `${record.sha256}  ${record.archiveName}`).join("\n")}\n`;
  const componentPath = join(kitRoot, COMPONENT_CHECKSUM_NAME);
  await writeCanonicalFile(componentPath, componentText, generatedAt);
  if (!names.add(COMPONENT_CHECKSUM_NAME)) throw new Error(`Duplicate complete-kit archive name: ${COMPONENT_CHECKSUM_NAME}`);

  const archiveEntries = [...names].sort(compareNames);
  const zipPath = join(tempRoot, COMPLETE_ZIP_NAME);
  createZip(zipPath, archiveEntries, kitRoot);
  await validateZip(zipPath, "COMPLETE DEVELOPMENT KIT ZIP", MAX_COMPLETE_ZIP_BYTES, archiveEntries);

  const roundTripRoot = join(tempRoot, "complete-kit-roundtrip");
  await extractZip(zipPath, roundTripRoot);
  await verifyExtractedTree(roundTripRoot, archiveEntries);
  const componentChecksums = parseChecksumText(
    await readFile(join(roundTripRoot, COMPONENT_CHECKSUM_NAME), "ascii"),
    COMPONENT_CHECKSUM_NAME);
  if (componentChecksums.size !== records.length) throw new Error("Component checksum inventory is incomplete.");
  for (const record of records) {
    if (componentChecksums.get(record.archiveName) !== record.sha256
      || await sha256(join(roundTripRoot, record.archiveName)) !== record.sha256) {
      throw new Error(`Complete-kit round-trip checksum mismatch: ${record.archiveName}`);
    }
  }
  const roundTripProvenance = JSON.parse(await readFile(join(roundTripRoot, PROVENANCE_NAME), "utf8"));
  const topLevelKeys = Object.keys(roundTripProvenance).sort(compareNames);
  const expectedTopLevelKeys = ["generatedAtUtc", "informationalVersion", "inputs", "product", "schemaVersion", "version"].sort(compareNames);
  if (!sameList(topLevelKeys, expectedTopLevelKeys)
    || roundTripProvenance.schemaVersion !== 1
    || roundTripProvenance.product !== PRODUCT
    || roundTripProvenance.version !== VERSION
    || roundTripProvenance.informationalVersion !== INFORMATIONAL_VERSION
    || roundTripProvenance.generatedAtUtc !== generatedAt.toISOString()
    || !Array.isArray(roundTripProvenance.inputs)
    || roundTripProvenance.inputs.length !== provenance.inputs.length) {
    throw new Error("Round-trip provenance header or input count is invalid.");
  }
  for (const input of roundTripProvenance.inputs) {
    const keys = Object.keys(input).sort(compareNames);
    const expectedKeys = ["archiveName", "byteSize", "sha256", "sourceKind"].sort(compareNames);
    if (!sameList(keys, expectedKeys)) throw new Error("Round-trip provenance contains an unexpected input field.");
    const record = records.find((candidate) => candidate.archiveName === input.archiveName);
    if (!record
      || record.sourceKind !== input.sourceKind
      || record.byteSize !== input.byteSize
      || record.sha256 !== input.sha256
      || componentChecksums.get(input.archiveName) !== input.sha256) {
      throw new Error(`Provenance and component checksums disagree: ${input.archiveName}`);
    }
  }
  const completeReadmeHash = await sha256(join(roundTripRoot, README_START_NAME));
  if (completeReadmeHash !== sourceArchive.readmeSha256
    || completeReadmeHash !== await sha256(options.handoff)) {
    throw new Error("README_START_HERE_KO.md is not a byte-copy of the handoff document.");
  }
  return {
    path: zipPath,
    byteSize: (await stat(zipPath)).size,
    sha256: await sha256(zipPath),
    componentCount: archiveEntries.length,
    provenanceInputCount: provenance.inputs.length
  };
}

async function writeOuterSidecar(path, archiveName, hash, generatedAt) {
  await writeCanonicalFile(path, canonicalSidecar(hash, archiveName), generatedAt);
  const parsed = parseChecksumText(await readFile(path, "ascii"), basename(path));
  if (parsed.size !== 1 || parsed.get(archiveName) !== hash) throw new Error(`Outer sidecar verification failed: ${archiveName}`);
}

async function publishAtomicallyNoReplace(tempPath, finalPath) {
  const item = await lstat(tempPath);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error(`Atomic publish input is invalid: ${basename(tempPath)}`);
  try {
    await link(tempPath, finalPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`immutable-output-conflict: ${basename(finalPath)} already exists; release outputs are append-only.`);
    }
    throw error;
  }
  const published = await lstat(finalPath);
  if (!published.isFile() || published.isSymbolicLink()
    || published.dev !== item.dev || published.ino !== item.ino || published.size !== item.size) {
    throw new Error(`Atomic no-replace publish verification failed: ${basename(finalPath)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  requireArchiveTools();
  await assertDirectory(options.projectRoot, "Project root");
  await assertDirectory(options.outputRoot, "Output root");
  if (options.outputRoot === options.projectRoot
    || relative(options.projectRoot, options.outputRoot) === ""
    || !relative(options.projectRoot, options.outputRoot).startsWith("..")) {
    throw new Error("Output root must not be the project root or a child of it.");
  }
  await safeOutputTargets(options.outputRoot, options.sourceOnly);
  await validateSourceInventory(options.projectRoot);
  assertExpectedBasename(options.handoff, HANDOFF_NAME, "Handoff");
  if (options.sourceOnly) {
    await assertRegularFile(options.handoff, "Handoff", 4 * 1024 * 1024);
    if (options.dryRun) {
      console.log(JSON.stringify({
        dryRun: true,
        ready: true,
        sourceOnly: true,
        version: VERSION,
        informationalVersion: INFORMATIONAL_VERSION,
        sourceInventory: sourceDefinitions.length + 2,
        plannedOutputs: [SOURCE_ZIP_NAME, `${SOURCE_ZIP_NAME}.sha256.txt`]
      }, null, 2));
      return;
    }

    const generatedAt = new Date();
    const tempRoot = await mkdtemp(join(options.outputRoot, ".byeollog-v070_RC2-source-"));
    try {
      const sourceArchive = await createSourceArchive(
        options.projectRoot,
        options.handoff,
        tempRoot,
        generatedAt);
      const sourceSidecar = join(tempRoot, `${SOURCE_ZIP_NAME}.sha256.txt`);
      await writeOuterSidecar(sourceSidecar, SOURCE_ZIP_NAME, sourceArchive.sha256, generatedAt);
      await safeOutputTargets(options.outputRoot, true);
      const publishPlan = [
        [sourceArchive.path, join(options.outputRoot, SOURCE_ZIP_NAME)],
        [sourceSidecar, join(options.outputRoot, `${SOURCE_ZIP_NAME}.sha256.txt`)]
      ];
      for (const [temporary, final] of publishPlan)
        await publishAtomicallyNoReplace(temporary, final);
      if (await sha256(join(options.outputRoot, SOURCE_ZIP_NAME)) !== sourceArchive.sha256)
        throw new Error("Published SOURCE_ONLY ZIP changed during atomic publication.");
      console.log(JSON.stringify({
        dryRun: false,
        sourceOnly: true,
        version: VERSION,
        generatedAtUtc: generatedAt.toISOString(),
        source: {
          archiveName: SOURCE_ZIP_NAME,
          byteSize: sourceArchive.byteSize,
          sha256: sourceArchive.sha256,
          sourceFileCount: sourceArchive.sourceFileCount
        }
      }, null, 2));
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
    return;
  }
  const validatedInputs = await validateFinalInputs(options);

  if (options.dryRun) {
    console.log(JSON.stringify({
      dryRun: true,
      ready: true,
      version: VERSION,
      informationalVersion: INFORMATIONAL_VERSION,
      sourceInventory: sourceDefinitions.length + 2,
      plannedOutputs: [
        SOURCE_ZIP_NAME,
        `${SOURCE_ZIP_NAME}.sha256.txt`,
        COMPLETE_ZIP_NAME,
        `${COMPLETE_ZIP_NAME}.sha256.txt`
      ],
      completeKitRequiredComponents: 6 + documentationFiles.length + 1 + 4 + 2
    }, null, 2));
    return;
  }

  const generatedAt = new Date();
  if (!Number.isFinite(generatedAt.getTime())) throw new Error("Release generation time is invalid.");
  const tempRoot = await mkdtemp(join(options.outputRoot, ".byeollog-v070_RC2-complete-"));
  try {
    const sourceArchive = await createSourceArchive(options.projectRoot, options.handoff, tempRoot, generatedAt);
    const completeKit = await createCompleteKit(options, tempRoot, sourceArchive, generatedAt, validatedInputs);
    const sourceSidecar = join(tempRoot, `${SOURCE_ZIP_NAME}.sha256.txt`);
    const completeSidecar = join(tempRoot, `${COMPLETE_ZIP_NAME}.sha256.txt`);
    await writeOuterSidecar(sourceSidecar, SOURCE_ZIP_NAME, sourceArchive.sha256, generatedAt);
    await writeOuterSidecar(completeSidecar, COMPLETE_ZIP_NAME, completeKit.sha256, generatedAt);

    const publishPlan = [
      [sourceArchive.path, join(options.outputRoot, SOURCE_ZIP_NAME)],
      [sourceSidecar, join(options.outputRoot, `${SOURCE_ZIP_NAME}.sha256.txt`)],
      [completeKit.path, join(options.outputRoot, COMPLETE_ZIP_NAME)],
      [completeSidecar, join(options.outputRoot, `${COMPLETE_ZIP_NAME}.sha256.txt`)]
    ];
    // Recheck immediately before publication. Hard-link creation is the Linux
    // no-replace primitive: unlike rename(2), it can never clobber an existing
    // immutable release target, while the complete file becomes visible atomically.
    await safeOutputTargets(options.outputRoot, false);
    for (const [temporary, final] of publishPlan) await publishAtomicallyNoReplace(temporary, final);

    for (const [temporary, final] of publishPlan) {
      if (temporary.endsWith(".zip") && await sha256(final) !== (final.endsWith(SOURCE_ZIP_NAME) ? sourceArchive.sha256 : completeKit.sha256)) {
        throw new Error(`Published ZIP changed during atomic no-replace publication: ${basename(final)}`);
      }
    }
    console.log(JSON.stringify({
      dryRun: false,
      version: VERSION,
      generatedAtUtc: generatedAt.toISOString(),
      source: {
        archiveName: SOURCE_ZIP_NAME,
        byteSize: sourceArchive.byteSize,
        sha256: sourceArchive.sha256,
        sourceFileCount: sourceArchive.sourceFileCount
      },
      completeKit: {
        archiveName: COMPLETE_ZIP_NAME,
        byteSize: completeKit.byteSize,
        sha256: completeKit.sha256,
        componentCount: completeKit.componentCount,
        provenanceInputCount: completeKit.provenanceInputCount
      }
    }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`package-complete-release-linux: ${message}`);
  process.exitCode = 1;
}
