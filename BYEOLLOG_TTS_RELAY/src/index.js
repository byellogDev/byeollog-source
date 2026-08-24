const CONFIG_KEY = "active-origin-v1";
const ADMIN_PATH = "/__byeollog/admin/origin";
const META_PATH = "/__byeollog/relay/meta";
const MAX_ADMIN_BODY_BYTES = 1024;
const MAX_CLOCK_SKEW_SECONDS = 300;
const NONCE_TTL_SECONDS = 600;
const ORIGIN_HEALTH_TIMEOUT_MS = 8000;
const ORIGIN_HOST = /^[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com$/;
const NONCE = /^[A-Za-z0-9_-]{24,128}$/;
const HEX_SHA256 = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function parseAllowedOrigin(value) {
  if (typeof value !== "string" || value.length > 180) return null;
  if (!/^https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\/?$/.test(value)) {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !ORIGIN_HOST.test(url.hostname)
  ) {
    return null;
  }
  return url.origin;
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, textEncoder.encode(message)),
  );
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function verifyAdminRequest(request, env, bodyText) {
  if (typeof env.ADMIN_SECRET !== "string" || env.ADMIN_SECRET.length < 32) {
    return { ok: false, status: 503, code: "relay_secret_unavailable" };
  }

  const timestampText = request.headers.get("x-byeollog-timestamp") || "";
  const nonce = request.headers.get("x-byeollog-nonce") || "";
  const signature = (request.headers.get("x-byeollog-signature") || "").toLowerCase();
  const timestamp = Number(timestampText);
  const now = Math.floor(Date.now() / 1000);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(now - timestamp) > MAX_CLOCK_SKEW_SECONDS ||
    !NONCE.test(nonce) ||
    !HEX_SHA256.test(signature)
  ) {
    return { ok: false, status: 401, code: "invalid_admin_proof" };
  }

  const expected = await hmacHex(
    env.ADMIN_SECRET,
    `${timestampText}\n${nonce}\n${bodyText}`,
  );
  if (!timingSafeEqual(signature, expected)) {
    return { ok: false, status: 401, code: "invalid_admin_proof" };
  }

  const nonceKey = `nonce:${nonce}`;
  if (await env.ROUTING.get(nonceKey)) {
    return { ok: false, status: 409, code: "replayed_admin_request" };
  }
  await env.ROUTING.put(nonceKey, "1", { expirationTtl: NONCE_TTL_SECONDS });
  return { ok: true };
}

async function verifyOriginHealth(origin) {
  let response;
  try {
    response = await fetch(`${origin}/healthz`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(ORIGIN_HEALTH_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "origin_unreachable" };
  }
  if (!response.ok) return { ok: false, code: "origin_unhealthy" };
  try {
    const body = await response.json();
    if (body?.healthy !== true) return { ok: false, code: "origin_unhealthy" };
    return {
      ok: true,
      voiceVersion: typeof body.version === "string" ? body.version.slice(0, 100) : "",
    };
  } catch {
    return { ok: false, code: "origin_invalid_health" };
  }
}

async function updateOrigin(request, env) {
  if (request.method !== "POST") {
    return json({ ok: false, code: "method_not_allowed" }, 405, { allow: "POST" });
  }
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > MAX_ADMIN_BODY_BYTES) {
    return json({ ok: false, code: "request_too_large" }, 413);
  }
  const bodyText = await request.text();
  if (textEncoder.encode(bodyText).byteLength > MAX_ADMIN_BODY_BYTES) {
    return json({ ok: false, code: "request_too_large" }, 413);
  }

  const proof = await verifyAdminRequest(request, env, bodyText);
  if (!proof.ok) return json({ ok: false, code: proof.code }, proof.status);

  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json({ ok: false, code: "invalid_json" }, 400);
  }
  const origin = parseAllowedOrigin(body?.origin);
  if (!origin) return json({ ok: false, code: "invalid_origin" }, 400);

  const health = await verifyOriginHealth(origin);
  if (!health.ok) return json({ ok: false, code: health.code }, 502);

  const record = {
    schemaVersion: 1,
    origin,
    updatedAt: new Date().toISOString(),
    voiceVersion: health.voiceVersion,
  };
  await env.ROUTING.put(CONFIG_KEY, JSON.stringify(record));
  return json({
    ok: true,
    updatedAt: record.updatedAt,
    voiceVersion: record.voiceVersion,
  });
}

async function readConfig(env) {
  const record = await env.ROUTING.get(CONFIG_KEY, "json");
  const origin = parseAllowedOrigin(record?.origin);
  return origin
    ? { origin, updatedAt: record.updatedAt || null, voiceVersion: record.voiceVersion || "" }
    : null;
}

async function proxyRequest(request, env) {
  const config = await readConfig(env);
  if (!config) return json({ healthy: false, code: "relay_origin_not_configured" }, 503);

  const incoming = new URL(request.url);
  const target = new URL(config.origin);
  target.pathname = incoming.pathname;
  target.search = incoming.search;

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-proto");
  headers.set("x-byeollog-relay", "workers-v1");

  let upstream;
  try {
    upstream = await fetch(new Request(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    }));
  } catch {
    return json({ healthy: false, code: "relay_origin_unreachable" }, 502);
  }

  const responseHeaders = new Headers(upstream.headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-byeollog-relay", "workers-v1");
  responseHeaders.set("x-byeollog-origin-updated-at", config.updatedAt || "unknown");
  responseHeaders.delete("server");
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === ADMIN_PATH) return updateOrigin(request, env);
    if (url.pathname === META_PATH) {
      const config = await readConfig(env);
      return json({
        healthy: Boolean(config),
        relayVersion: "workers-v1",
        updatedAt: config?.updatedAt || null,
        voiceVersion: config?.voiceVersion || "",
      }, config ? 200 : 503);
    }
    return proxyRequest(request, env);
  },
};

export const __test = {
  parseAllowedOrigin,
  timingSafeEqual,
  hmacHex,
};
