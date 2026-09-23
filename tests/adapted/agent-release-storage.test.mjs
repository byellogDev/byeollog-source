import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(auditURL(path, import.meta.url), "utf8"));
const readText = async (path) => readFile(auditURL(path, import.meta.url), "utf8");

test("GitHub release storage keeps Vercel deployments free of release binaries", async () => {
  const [storage, vercel, ignore, publisher, signedFeed, installer, installerRunner] = await Promise.all([
    readJson("../agent-updates/release-asset-storage.json"),
    readJson("../vercel.json"),
    readText("../.vercelignore"),
    readText("../tools/Publish-AgentReleaseAssets.mjs"),
    readJson("../agent-updates/stable/win-x64.json"),
    readText("../installer/ByeollogAgentSetup.iss"),
    readText("../installer/Invoke-AgentInstall.ps1")
  ]);

  assert.equal(storage.schemaVersion, 1);
  assert.equal(storage.provider, "github-releases");
  assert.equal(storage.repository, "byellogDev/byeollog-releases");
  assert.equal(storage.tagPrefix, "agent-v");
  assert.equal(storage.allowOverwrite, false);
  assert.equal(storage.onlineRetention, "all");
  assert.equal(storage.historicalArchive, "local-release-tree");
  assert.match(ignore, /^agent-updates\/releases\s*$/m);
  assert.match(ignore, /^downloads\s*$/m);

  const payload = JSON.parse(Buffer.from(signedFeed.payload, "base64").toString("utf8"));
  assert.match(payload.package.url, /^https:\/\/byeollog\.com\/agent-updates\/releases\//);
  assert.doesNotMatch(payload.package.url, /github\.com/);

  const packagePath = auditURL(payload.package.url).pathname.slice(1);
  const ignoreLines = ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.equal(packagePath, `agent-updates/releases/1.0.0.41/byeollog_wallpaper_v10041_WIN_X64.zip`);
  assert.equal(ignoreLines.includes("agent-updates/releases"), true);
  assert.equal(ignoreLines.some((line) => line.startsWith("!agent-updates/releases/")), false);

  // Automatic and manual installation use the same sealed 41 package.
  const installVersion = '1.0.0.41';
  const installPackage = await readJson(`../agent-updates/releases/${installVersion}/release-provenance.json`);
  const installManifest = await readJson(`../agent-updates/releases/${installVersion}/installer-package-manifest.json`);
  const updateManifest = await readJson(`../agent-updates/releases/${payload.version}/update-package-manifest.json`);
  assert.equal(payload.version, '1.0.0.41');
  assert.equal(payload.releaseSequence, 10042);
  assert.equal(installPackage.version, installVersion);
  assert.equal(installManifest.version, installVersion);
  const roots = manifest => manifest.files.filter(file => file.role === 'install_root').map(({path,sha256,byteSize}) => ({path,sha256,byteSize})).sort((a,b)=>a.path.localeCompare(b.path));
  assert.equal(roots(installManifest).length, 9);
  assert.deepEqual(roots(installManifest), roots(updateManifest));
  assert.match(installer, /#define AppVersion "1\.0\.0\.41"/);
  assert.ok(installer.includes(`#define PackageUrl "https://byeollog.com/agent-updates/releases/${installVersion}/${installPackage.packageName}"`));
  assert.ok(installer.includes(`#define PackageSha256 "${installPackage.sha256}"`));
  assert.match(installer, /PrivilegesRequired=lowest/);
  assert.match(installer, /Flags: external download extractarchive ignoreversion/);
  assert.match(installer, /CompareText\(ParamStr\(Index\), '\/VERIFYONLY'\)/);
  assert.match(installer, /Parameters := Parameters \+ 'VerifyPackage'/);
  assert.match(installerRunner, /Microsoft\.PowerShell\.Utility\.psd1/);
  assert.match(installerRunner, /& \$installer -Mode \$effectiveMode/);
  assert.match(installerRunner, /\[version\]\$existing.version -gt \[version\]\$incoming.version/);
  assert.ok((vercel.redirects || []).some(({ source, destination, permanent }) =>
    source === "/agent-updates/releases/:version/:filename([^/]+\\.zip)" &&
    destination === "https://github.com/byellogDev/byeollog-releases/releases/download/agent-v:version/:filename" &&
    permanent === false));
  assert.ok(vercel.headers.some(({ source }) =>
    source === "/agent-updates/releases/:version/:filename([^/]+\\.zip)"));
  assert.ok((vercel.redirects || []).some(({ source, destination, permanent }) =>
    source === "/agent-updates/releases/:version/:filename([^/]+\\.exe)" &&
    destination === "https://github.com/byellogDev/byeollog-releases/releases/download/agent-v:version/:filename" &&
    permanent === false));
  assert.ok(vercel.headers.some(({ source }) =>
    source === "/agent-updates/releases/:version/:filename([^/]+\\.exe)"));
  assert.ok((vercel.redirects || []).some(({ source, destination, permanent }) =>
    source === "/agent/download" &&
    destination === "/agent-updates/releases/1.0.0.41/Byeollog-Wallpaper-Setup-v1.0.0.41-online.exe" &&
    permanent === false));

  assert.match(publisher, /specify exactly one of --version <version> or --all/);
  assert.match(publisher, /release asset storage must prohibit overwrites/);
  assert.match(publisher, /immutable GitHub release collision/);
  assert.match(publisher, /immutable GitHub release SHA-256 mismatch/);
  assert.match(publisher, /remote stream size mismatch/);
  assert.match(publisher, /portable-executable/);
  assert.match(publisher, /const releasePromises = new Map\(\)/);
  assert.match(publisher, /releasePromises\.set\(version, loadOrCreateRelease\(version\)/);
  assert.match(publisher, /\(\?:zip\|exe\)/);
  assert.match(publisher, /git", \["credential", "fill"\]/);
  assert.doesNotMatch(publisher, /assets\/\$\{asset\.id\}/);
  assert.doesNotMatch(publisher, /method:\s*"DELETE"/);
  assert.doesNotMatch(publisher, /BLOB_READ_WRITE_TOKEN/);
});
