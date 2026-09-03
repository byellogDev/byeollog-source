import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import https from "node:https";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const releaseRoot = join(projectRoot, "agent-updates", "releases");
const storageConfig = JSON.parse(
  readFileSync(join(projectRoot, "agent-updates", "release-asset-storage.json"), "utf8")
);

function optionValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : fallback;
}

const requestedVersion = optionValue("--version");
const uploadAll = process.argv.includes("--all");
const concurrency = Number.parseInt(optionValue("--concurrency", "2"), 10);
if (Boolean(requestedVersion) === uploadAll) {
  throw new Error("specify exactly one of --version <version> or --all");
}
if (requestedVersion && !/^\d+\.\d+\.\d+\.\d+$/.test(requestedVersion)) {
  throw new Error("--version must use the numeric a.b.c.d format");
}
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) {
  throw new Error("--concurrency must be an integer from 1 through 4");
}
if (storageConfig.allowOverwrite !== false) {
  throw new Error("release asset storage must prohibit overwrites");
}

function readGitHubToken() {
  const fromEnvironment = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (fromEnvironment) return fromEnvironment;

  const output = execFileSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"]
  });
  const passwordLine = output.split(/\r?\n/).find((line) => line.startsWith("password="));
  return passwordLine?.slice("password=".length).trim() || "";
}

const githubToken = readGitHubToken();
if (!githubToken) {
  throw new Error("GitHub credential is missing; sign in through Git Credential Manager or set GITHUB_TOKEN");
}

const [repositoryOwner, repositoryName] = String(storageConfig.repository).split("/");
if (!repositoryOwner || !repositoryName) throw new Error("storage repository must use owner/name format");

const apiHeaders = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${githubToken}`,
  "User-Agent": "byeollog-agent-release-publisher",
  "X-GitHub-Api-Version": "2022-11-28"
};

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function githubJson(path, { method = "GET", body, allow404 = false } = {}) {
  let response;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: body ? { ...apiHeaders, "Content-Type": "application/json" } : apiHeaders,
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store"
    });
    if (allow404 && response.status === 404) return null;
    if (response.ok) return response.status === 204 ? null : response.json();
    if (![403, 429, 500, 502, 503, 504].includes(response.status)) break;
    const retryAfter = Number.parseInt(response.headers.get("retry-after") || "0", 10);
    await sleep(Math.max(retryAfter * 1_000, 1_000 * (attempt + 1)));
  }
  const detail = (await response?.text())?.slice(0, 500);
  throw new Error(`GitHub API ${method} ${path} failed: HTTP ${response?.status ?? "unknown"} ${detail}`);
}

async function ensureRelease(version) {
  const tag = `${storageConfig.tagPrefix}${version}`;
  const encodedTag = encodeURIComponent(tag);
  const existing = await githubJson(
    `/repos/${repositoryOwner}/${repositoryName}/releases/tags/${encodedTag}`,
    { allow404: true }
  );
  if (existing) return existing;
  return githubJson(`/repos/${repositoryOwner}/${repositoryName}/releases`, {
    method: "POST",
    body: {
      tag_name: tag,
      name: `Byeollog Agent ${version}`,
      body: "Immutable Windows x64 auto-update package for Byeollog Agent.",
      draft: false,
      prerelease: false,
      generate_release_notes: false,
      make_latest: "legacy"
    }
  });
}

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function sha256Remote(url, expectedBytes) {
  let response;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    response = await fetch(url, { cache: "no-store", redirect: "follow" });
    if (response.ok) break;
    if (response.status !== 404 && response.status < 500) break;
    await sleep(Math.min(3_000, 500 * (attempt + 1)));
  }
  if (!response?.ok || !response.body) {
    throw new Error(`remote verification failed: HTTP ${response?.status ?? "unknown"} ${url}`);
  }
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    received += chunk.length;
    hash.update(chunk);
  }
  if (received !== expectedBytes) {
    throw new Error(`remote stream size mismatch: expected ${expectedBytes}, got ${received} (${url})`);
  }
  return hash.digest("hex");
}

function uploadAsset(releaseId, filePath, fileName, bytes) {
  const url = new URL(
    `https://uploads.github.com/repos/${repositoryOwner}/${repositoryName}/releases/${releaseId}/assets`
  );
  url.searchParams.set("name", fileName);

  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.request(url, {
      method: "POST",
      headers: {
        ...apiHeaders,
        "Content-Type": fileName.toLowerCase().endsWith(".exe")
          ? "application/vnd.microsoft.portable-executable"
          : "application/zip",
        "Content-Length": bytes
      }
    });
    let responseBody = "";
    request.on("response", (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => {
        if (response.statusCode === 201) {
          resolvePromise(JSON.parse(responseBody));
          return;
        }
        rejectPromise(new Error(
          `GitHub asset upload failed: HTTP ${response.statusCode} ${responseBody.slice(0, 500)}`
        ));
      });
    });
    request.on("error", rejectPromise);
    createReadStream(filePath).on("error", rejectPromise).pipe(request);
  });
}

function publicAssetUrl(version, fileName) {
  const tag = `${storageConfig.tagPrefix}${version}`;
  return `https://github.com/${repositoryOwner}/${repositoryName}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(fileName)}`;
}

const allFiles = (await collectFiles(releaseRoot))
  .filter((filePath) => /\.(?:zip|exe)$/i.test(filePath))
  .filter((filePath) => uploadAll || relative(releaseRoot, filePath).split(sep)[0] === requestedVersion)
  .sort((left, right) => left.localeCompare(right, "en"));
if (allFiles.length === 0) {
  throw new Error(requestedVersion ? `no release asset found for ${requestedVersion}` : "no release assets found");
}

let cursor = 0;
let uploaded = 0;
let verified = 0;
let totalBytes = 0;
const results = [];

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= allFiles.length) return;
    const filePath = allFiles[index];
    const releaseRelative = relative(releaseRoot, filePath).split(sep);
    const version = releaseRelative[0];
    const fileName = releaseRelative.at(-1);
    if (releaseRelative.length !== 2 || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
      throw new Error(`unexpected release asset path: ${relative(releaseRoot, filePath)}`);
    }

    const info = await stat(filePath);
    const localSha256 = await sha256File(filePath);
    let release = await ensureRelease(version);
    let asset = release.assets.find((candidate) => candidate.name === fileName);
    if (asset) {
      if (asset.size !== info.size) {
        throw new Error(`immutable GitHub release collision for ${version}/${fileName}: local=${info.size}, remote=${asset.size}`);
      }
    } else {
      try {
        asset = await uploadAsset(release.id, filePath, fileName, info.size);
        uploaded += 1;
      } catch (error) {
        release = await githubJson(
          `/repos/${repositoryOwner}/${repositoryName}/releases/tags/${encodeURIComponent(`${storageConfig.tagPrefix}${version}`)}`
        );
        asset = release.assets.find((candidate) => candidate.name === fileName);
        if (!asset || asset.size !== info.size) throw error;
      }
    }

    const url = publicAssetUrl(version, fileName);
    const remoteSha256 = await sha256Remote(url, info.size);
    if (remoteSha256 !== localSha256) {
      throw new Error(`immutable GitHub release SHA-256 mismatch for ${version}/${fileName}`);
    }
    totalBytes += info.size;
    verified += 1;
    results.push({ version, fileName, bytes: info.size, sha256: localSha256, url });
    process.stdout.write(`[verified ${verified}/${allFiles.length}] ${version}/${fileName} ${info.size} ${localSha256}\n`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, allFiles.length) }, () => worker()));
results.sort((left, right) => `${left.version}/${left.fileName}`.localeCompare(`${right.version}/${right.fileName}`, "en"));
process.stdout.write(`${JSON.stringify({
  repository: storageConfig.repository,
  files: results.length,
  uploaded,
  verified,
  totalBytes
}, null, 2)}\n`);
