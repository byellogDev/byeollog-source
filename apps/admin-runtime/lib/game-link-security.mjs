import crypto from "node:crypto";

const PKCE_VERIFIER_BYTES = 64;

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
}

export function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createPkcePair() {
  const verifier = randomToken(PKCE_VERIFIER_BYTES);
  const challenge = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return { verifier, challenge };
}

export function decodeDataKey(value) {
  const raw = String(value || "").trim();
  let key;
  try {
    key = Buffer.from(raw, "base64");
  } catch {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    throw new Error("GAME_LINK_DATA_KEY must be exactly 32 bytes encoded as base64");
  }
  return key;
}

export function encryptShortLivedSecret(value, key, aad = "byeollog:game-link:pkce:v1") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(String(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`;
}

export function decryptShortLivedSecret(value, key, aad = "byeollog:game-link:pkce:v1") {
  const [version, ivText, tagText, cipherText, extra] = String(value || "").split(".");
  if (version !== "v1" || !ivText || !tagText || !cipherText || extra !== undefined) {
    throw new Error("Invalid encrypted game-link secret");
  }
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(ivText, "base64url"),
    );
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(Buffer.from(tagText, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(cipherText, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("Encrypted game-link secret could not be decrypted");
  }
}

export function normalizeSoopId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9_.-]{2,80}$/.test(normalized)) {
    throw new Error("Invalid SOOP user ID");
  }
  return normalized;
}

export function normalizeMinecraftUuid(value) {
  const normalized = String(value || "").replaceAll("-", "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) {
    throw new Error("Invalid Minecraft UUID");
  }
  return normalized;
}

export function normalizeMinecraftName(value) {
  const normalized = String(value || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(normalized)) {
    throw new Error("Invalid Minecraft Java profile name");
  }
  return normalized;
}
