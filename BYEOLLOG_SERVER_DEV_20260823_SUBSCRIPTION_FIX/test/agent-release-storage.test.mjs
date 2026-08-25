import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const readText = async (path) => readFile(new URL(path, import.meta.url), "utf8");

test("GitHub release storage keeps one direct v85 bootstrap exception for legacy updaters", async () => {
  const [storage, vercel, ignore, publisher, signedFeed] = await Promise.all([
    readJson("../agent-updates/release-asset-storage.json"),
    readJson("../vercel.json"),
    readText("../.vercelignore"),
    readText("../tools/Publish-AgentReleaseAssets.mjs"),
    readJson("../agent-updates/stable/win-x64.json")
  ]);

  assert.equal(storage.schemaVersion, 1);
  assert.equal(storage.provider, "github-releases");
  assert.equal(storage.repository, "byellogDev/byeollog-releases");
  assert.equal(storage.tagPrefix, "agent-v");
  assert.equal(storage.allowOverwrite, false);
  assert.equal(storage.onlineRetention, "all");
  assert.equal(storage.historicalArchive, "local-release-tree");
  assert.match(ignore, /^agent-updates\/releases\/\*\*\/\*\.zip\s*$/m);

  const payload = JSON.parse(Buffer.from(signedFeed.payload, "base64").toString("utf8"));
  assert.match(payload.package.url, /^https:\/\/byeollog\.com\/agent-updates\/releases\//);
  assert.doesNotMatch(payload.package.url, /github\.com/);

  const packagePath = new URL(payload.package.url).pathname.slice(1);
  const ignoreLines = ignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const genericIndex = ignoreLines.indexOf("agent-updates/releases/**/*.zip");
  const bootstrapIndex = ignoreLines.indexOf(`!${packagePath}`);
  assert.ok(genericIndex >= 0 && bootstrapIndex > genericIndex);
  assert.equal(ignoreLines.filter((line) => line.startsWith("!agent-updates/releases/")).length, 1);
  assert.equal((vercel.redirects || []).some(({ source }) =>
    source === "/agent-updates/releases/:version/:filename([^/]+\\.zip)"), false);
  assert.ok(vercel.headers.some(({ source }) =>
    source === "/agent-updates/releases/:version/:filename([^/]+\\.zip)"));

  assert.match(publisher, /specify exactly one of --version <version> or --all/);
  assert.match(publisher, /release asset storage must prohibit overwrites/);
  assert.match(publisher, /immutable GitHub release collision/);
  assert.match(publisher, /immutable GitHub release SHA-256 mismatch/);
  assert.match(publisher, /remote stream size mismatch/);
  assert.match(publisher, /git", \["credential", "fill"\]/);
  assert.doesNotMatch(publisher, /assets\/\$\{asset\.id\}/);
  assert.doesNotMatch(publisher, /method:\s*"DELETE"/);
  assert.doesNotMatch(publisher, /BLOB_READ_WRITE_TOKEN/);
});
