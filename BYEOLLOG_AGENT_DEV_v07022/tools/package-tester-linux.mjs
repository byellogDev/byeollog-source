#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const VERSION = "0.7.0.32";
const PACKAGE_NAME = "byeollog_agent_v07032_AUTO_UPDATE_BOOTSTRAP_WIN_X64";
const MANIFEST_NAME = "release-manifest.json";
const CHECKSUMS_NAME = "SHA256SUMS.txt";
const MAX_PACKAGE_BYTES = 768 * 1024 * 1024;

const definitions = [
  ["byeollog.exe", "app", true, 512 * 1024 * 1024],
  ["WebView2Loader.dll", "app", false, 32 * 1024 * 1024],
  ["LAUNCH_BYEOLLOG.cmd", "install_root", true, 1024 * 1024],
  ["Byeollog-Launcher.ps1", "install_root", true, 1024 * 1024],
  ["Install-Byeollog.ps1", "install_root", true, 4 * 1024 * 1024],
  ["ROLLBACK_LAST_VERSION.cmd", "install_root", true, 1024 * 1024],
  ["VERIFY_INSTALL.cmd", "install_root", true, 1024 * 1024],
  ["RESTORE_PREUPDATE_STATE.cmd", "install_root", true, 1024 * 1024],
  ["CREATE_SUPPORT_BUNDLE.cmd", "install_root", true, 1024 * 1024],
  ["RUN_REPLAY_CANDIDATE_CHECK.cmd", "install_root", true, 1024 * 1024],
  ["Collect-SupportBundle.ps1", "install_root", true, 4 * 1024 * 1024],
  ["INSTALL_OR_UPDATE.cmd", "package_tool", true, 1024 * 1024],
  ["INSTALL_AND_CHECK.cmd", "package_tool", true, 1024 * 1024],
  ["RUN_G4_CANARY_PREP.cmd", "package_tool", true, 1024 * 1024],
  ["RUN_TESTER_READINESS.cmd", "package_tool", true, 1024 * 1024],
  ["Test-TesterEnvironment.ps1", "package_tool", true, 4 * 1024 * 1024],
  ["README_TESTER_v070_RC2_KO.txt", "documentation", true, 4 * 1024 * 1024],
  ["G4_CANARY_v070_RC2_KO.md", "documentation", true, 4 * 1024 * 1024],
  ["RELEASE_v07032_AUTO_UPDATE_BOOTSTRAP_KO.txt", "documentation", true, 4 * 1024 * 1024]
].map(([path, role, required, maxBytes]) => ({ path, role, required, maxBytes }));

function readArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return resolve(process.argv[index + 1]);
}

function assertSafeOutputRoot(path) {
  if (path === "/" || path.length < 8 || basename(path) === "..") {
    throw new Error("Unsafe output directory.");
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function assertRegularFile(path, label, maximumBytes) {
  const item = await lstat(path);
  if (!item.isFile() || item.isSymbolicLink()) throw new Error(`${label} is not a regular file.`);
  if (item.size < 1 || item.size > maximumBytes) throw new Error(`${label} size is invalid.`);
  return item.size;
}

async function assertOutputAbsent(path) {
  try {
    await lstat(path);
    throw new Error(`immutable-output-conflict: ${basename(path)} already exists.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${details ? `: ${details}` : "."}`);
  }
  return result.stdout;
}

async function main() {
  const projectRoot = readArg("--project-root");
  const publishRoot = readArg("--publish-root");
  const outputRoot = readArg("--output-root");
  assertSafeOutputRoot(outputRoot);

  const packageRoot = join(outputRoot, PACKAGE_NAME);
  const zipPath = join(outputRoot, `${PACKAGE_NAME}.zip`);
  const zipHashPath = `${zipPath}.sha256.txt`;
  await assertOutputAbsent(packageRoot);
  await assertOutputAbsent(zipPath);
  await assertOutputAbsent(zipHashPath);
  await mkdir(packageRoot);

  for (const definition of definitions) {
    let source = definition.path === "byeollog.exe"
      ? join(publishRoot, definition.path)
      : join(projectRoot, definition.path);
    if (definition.path === "WebView2Loader.dll") {
      const candidates = [
        join(publishRoot, definition.path),
        join(publishRoot, "runtimes", "win-x64", "native", definition.path)
      ];
      source = null;
      for (const candidate of candidates) {
        try {
          await assertRegularFile(candidate, definition.path, definition.maxBytes);
          source = candidate;
          break;
        } catch {
          // Optional loader is already bundled by the single-file publisher.
        }
      }
      if (source === null) continue;
    }
    try {
      await assertRegularFile(source, definition.path, definition.maxBytes);
    } catch (error) {
      if (!definition.required) continue;
      throw error;
    }
    await copyFile(source, join(packageRoot, definition.path));
  }

  const payloadNames = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
  const allowed = new Set(definitions.map((definition) => definition.path));
  if (payloadNames.some((name) => !allowed.has(name))) throw new Error("Package contains an unapproved file.");

  const files = [];
  let totalByteSize = 0;
  for (const definition of definitions) {
    if (!payloadNames.includes(definition.path)) {
      if (definition.required) throw new Error(`Required package file is missing: ${definition.path}`);
      continue;
    }
    const path = join(packageRoot, definition.path);
    const byteSize = await assertRegularFile(path, definition.path, definition.maxBytes);
    totalByteSize += byteSize;
    if (totalByteSize > MAX_PACKAGE_BYTES) throw new Error("Package exceeds the 768 MiB limit.");
    files.push({
      path: definition.path,
      role: definition.role,
      byteSize,
      sha256: await sha256(path)
    });
  }

  const manifest = {
    schemaVersion: 2,
    product: "byeollog-collector",
    version: VERSION,
    platform: "win-x64",
    packageLayout: "flat_v1",
    generatedAtUtc: new Date().toISOString(),
    fileCount: files.length,
    totalByteSize,
    authenticity: {
      mode: "trusted_channel_internal",
      scope: "package_integrity_only",
      signerThumbprint: null
    },
    files
  };
  await writeFile(join(packageRoot, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");

  const checksumNames = [...files.map((entry) => entry.path), MANIFEST_NAME]
    .sort((left, right) => left.localeCompare(right, "en"));
  const checksumLines = [];
  for (const name of checksumNames) {
    checksumLines.push(`${await sha256(join(packageRoot, name))}  ${name}`);
  }
  await writeFile(join(packageRoot, CHECKSUMS_NAME), `${checksumLines.join("\n")}\n`, "ascii");

  const finalNames = (await readdir(packageRoot)).sort((left, right) => left.localeCompare(right, "en"));
  const expectedFinal = [...checksumNames, CHECKSUMS_NAME].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(finalNames) !== JSON.stringify(expectedFinal)) {
    throw new Error("Sealed package file set is incomplete or contains an unexpected item.");
  }

  for (const entry of files) {
    const path = join(packageRoot, entry.path);
    if ((await stat(path)).size !== entry.byteSize || await sha256(path) !== entry.sha256) {
      throw new Error(`Manifest verification failed: ${entry.path}`);
    }
  }
  for (const line of checksumLines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9_.-]+)$/.exec(line);
    if (!match || await sha256(join(packageRoot, match[2])) !== match[1]) {
      throw new Error("Checksum index verification failed.");
    }
  }

  run("zip", ["-X", "-9", "-j", zipPath, ...finalNames], packageRoot);
  run("unzip", ["-tqq", zipPath], outputRoot);
  const archiveEntries = run("unzip", ["-Z1", zipPath], outputRoot)
    .trim().split(/\r?\n/).filter(Boolean).sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(archiveEntries) !== JSON.stringify(finalNames)) {
    throw new Error("ZIP file set does not match the sealed package.");
  }

  const zipSha256 = await sha256(zipPath);
  await writeFile(zipHashPath, `${zipSha256}  ${basename(zipPath)}\n`, "ascii");
  console.log(JSON.stringify({
    packageRoot,
    zipPath,
    zipHashPath,
    fileCount: files.length,
    totalByteSize,
    zipBytes: (await stat(zipPath)).size,
    zipSha256
  }, null, 2));
}

await main();
