import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import assert from "node:assert/strict";
import { createHash, createPublicKey, constants, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const keyId = "rsa3072-cc1fb719f3a63774";
const modulus = "xh6UD7hSfTLd9lWkerCb3yrGY9hAur3s8maFJYlcdsCZu-YSUsGkKFonG8RPHXDeabmXXrsAAxl9oacxFdtfpxq0zAvyWXbv7VdKB9izi0kooBAPTs1kUe87pcbvTunj_7uPfTolcnT7wC5mlzoxlZQ8H-dyCWha1bKwOJYIgEPPbSqx-1lc8baeO4PTUZ3Cl_jCVX1VlqgKLFvaPjTOLiUtS6e4Wyv1S9r83N7EdHA8xiSKc89e-GEUHJzWjKdgCfmGPtNN4JJHH-6j-_npmSEdQb8SQ9_Bj3N2ETiM-hBL4mJko9mXyNCZG9ZlY5U1kPk9DBnmb2biNuF7xvhJ2UjpdxBeFJ20DJgtWCM30o_x8mNVViGEErvEIlmZKatPShB-ExAhrpx9cJRoccWtpMjvbejLbv6gKehfYhZ-Xc0q6e3_D-_MWGcCiVNYhBidoHB8TCvsSwza0_-ZmB1z6hBrKnJIVksUYTvOZzcNeqPmC7vah0USWrMyua_mQpxh";
const exponent = "AQAB";
const expectedVersion = "1.0.0.54";
const expectedPackageName = "byeollog_wallpaper_v10054_WIN_X64.zip";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("stable Windows Agent update feed is pinned, signed, and matches its immutable package", async () => {
  const feedBytes = await readFile(auditURL("../agent-updates/stable/win-x64.json", import.meta.url));
  assert.ok(feedBytes.length > 0 && feedBytes.length <= 64 * 1024);
  const envelope = JSON.parse(feedBytes.toString("utf8"));
  assert.deepEqual(Object.keys(envelope).sort(), ["payload", "schemaVersion", "signature"]);
  assert.equal(envelope.schemaVersion, 1);
  assert.deepEqual(Object.keys(envelope.signature).sort(), ["algorithm", "keyId", "value"]);
  assert.equal(envelope.signature.algorithm, "rsa-pss-sha256");
  assert.equal(envelope.signature.keyId, keyId);

  const payloadBytes = Buffer.from(envelope.payload, "base64");
  const publicKey = createPublicKey({
    key: { kty: "RSA", n: modulus, e: exponent },
    format: "jwk"
  });
  assert.equal(publicKey.asymmetricKeyDetails?.modulusLength, 3072);
  assert.equal(verify("sha256", payloadBytes, {
    key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }, Buffer.from(envelope.signature.value, "base64")), true);

  const payload = JSON.parse(payloadBytes.toString("utf8"));
  assert.deepEqual(Object.keys(payload).sort(), [
    "channel", "displayVersion", "expiresAtUtc", "mandatory", "minimumUpdaterProtocol",
    "package", "platform", "product", "publishedAtUtc", "releaseSequence", "schemaVersion",
    "summary", "version"
  ]);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.product, "byeollog-collector");
  assert.equal(payload.channel, "stable");
  assert.equal(payload.platform, "win-x64");
  assert.equal(payload.version, expectedVersion);
  assert.equal(payload.releaseSequence, 10054);
  assert.equal(payload.minimumUpdaterProtocol, 1);
  assert.equal(payload.mandatory, false);
  assert.ok(Date.parse(payload.expiresAtUtc) > Date.parse(payload.publishedAtUtc));
  assert.deepEqual(Object.keys(payload.package).sort(), ["byteSize", "innerManifestSha256", "sha256", "url"]);
  assert.equal(
    payload.package.url,
    `https://byeollog.com/agent-updates/releases/${expectedVersion}/${expectedPackageName}`
  );
  assert.match(payload.package.sha256, /^[0-9a-f]{64}$/);
  assert.match(payload.package.innerManifestSha256, /^[0-9a-f]{64}$/);

  const provenance = JSON.parse(await readFile(
    auditURL(`../agent-updates/releases/${expectedVersion}/update-provenance.json`, import.meta.url),
    "utf8"
  ));
  assert.deepEqual(provenance, {
    schemaVersion: 1,
    version: expectedVersion,
    packageName: expectedPackageName,
    byteSize: payload.package.byteSize,
    sha256: payload.package.sha256,
    innerManifestSha256: payload.package.innerManifestSha256
  });

  // Local release workspaces and Vercel deployments include the immutable ZIP.
  // Source-control CI intentionally stores only signed provenance, so the
  // full byte check is conditional while the feed signature remains mandatory.
  try {
    const packageBytes = await readFile(auditURL(
      `../agent-updates/releases/${expectedVersion}/${expectedPackageName}`,
      import.meta.url
    ));
    assert.equal(packageBytes.length, payload.package.byteSize);
    assert.equal(sha256(packageBytes), payload.package.sha256);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const tamperedPayload = Buffer.from(payloadBytes);
  tamperedPayload[0] ^= 1;
  assert.equal(verify("sha256", tamperedPayload, {
    key: publicKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: 32
  }, Buffer.from(envelope.signature.value, "base64")), false);
});

test("the current stable package uses the pinned GitHub Release compatibility bridge", async () => {
  const ignore = await readFile(auditURL("../.vercelignore", import.meta.url), "utf8");
  assert.match(ignore, /^downloads\s*$/m);
  assert.match(ignore, /^agent-updates\/releases\s*$/m);
  assert.doesNotMatch(ignore, /^!agent-updates\/releases\//m);

  const vercel = JSON.parse(await readFile(auditURL("../vercel.json", import.meta.url), "utf8"));
  assert.ok((vercel.redirects || []).some((route) =>
    route.source === "/agent-updates/releases/:version/:filename([^/]+\\.zip)" &&
    route.destination === "https://github.com/byellogDev/byeollog-releases/releases/download/agent-v:version/:filename" &&
    route.permanent === false));
});
