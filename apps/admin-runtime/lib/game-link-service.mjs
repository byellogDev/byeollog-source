import {
  createPkcePair,
  decodeDataKey,
  decryptShortLivedSecret,
  encryptShortLivedSecret,
  randomToken,
  safeEqual,
  sha256,
} from "./game-link-security.mjs";
import { GameLinkConflictError } from "./game-link-store.mjs";
import { clearOtherSoopFlowCookie } from "./soop-flow-cookies.mjs";

const COOKIE_NAME = "byeollog_game_link";
const SESSION_TTL_SECONDS = 15 * 60;

function cookiesOf(req) {
  const result = new Map();
  const duplicates = new Set();
  for (const item of String(req.headers?.cookie || "").split(";")) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf("=");
    const rawKey = index < 0 ? trimmed : trimmed.slice(0, index);
    const rawValue = index < 0 ? "" : trimmed.slice(index + 1);
    let key = rawKey;
    let value = rawValue;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      // Keep undecoded values so malformed unrelated cookies cannot break auth.
    }
    if (result.has(key)) duplicates.add(key);
    result.set(key, value);
  }
  return { result, duplicates };
}

function sessionToken(req) {
  const { result, duplicates } = cookiesOf(req);
  if (duplicates.has(COOKIE_NAME)) return "";
  const token = String(result.get(COOKIE_NAME) || "");
  return /^[A-Za-z0-9_-]{40,200}$/.test(token) ? token : "";
}

function appendSetCookie(res, value) {
  const current = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : null;
  if (Array.isArray(current)) res.setHeader("Set-Cookie", [...current, value]);
  else if (current) res.setHeader("Set-Cookie", [String(current), value]);
  else res.setHeader("Set-Cookie", value);
}

function setSessionCookie(res, token, secure, maxAge = SESSION_TTL_SECONDS) {
  appendSetCookie(
    res,
    `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api; HttpOnly; ` +
      `${secure ? "Secure; " : ""}SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function hasGameLinkSessionCookie(req) {
  return Boolean(sessionToken(req));
}

function clearSessionCookie(res, secure) {
  setSessionCookie(res, "", secure, 0);
}

function queryOf(req) {
  const url = new URL(req.url || "/", "http://game-link.local");
  const query = Object.fromEntries(url.searchParams.entries());
  if (req.query && typeof req.query === "object") Object.assign(query, req.query);
  return { url, query };
}

function operationOf(req) {
  const { url, query } = queryOf(req);
  if (query.operation) return String(query.operation);
  const path = url.pathname.replace(/\/$/, "");
  const routes = new Map([
    ["/api/game-link/soop/start", "soop-start"],
    ["/api/game-link/soop/callback", "soop-callback"],
    ["/api/game-link/microsoft/callback", "microsoft-callback"],
    ["/api/game-link/status", "status"],
    ["/api/game-link/health", "health"],
  ]);
  return routes.get(path) || "unknown";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function resultPage({ title, message, success = false }) {
  const accent = success ? "#56d364" : "#ff6b6b";
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>별록 X 마인크래프트 계정 연동</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#071a38;color:#f7f9ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(620px,100%);padding:36px;border:1px solid #29456d;border-radius:24px;background:#0b2144;box-shadow:0 20px 60px #0005}.eyebrow{color:${accent};font-weight:900;letter-spacing:.08em}.title{font-size:clamp(28px,6vw,42px);line-height:1.2}.message{color:#c8d5eb;font-size:17px;line-height:1.7}.home{display:inline-block;margin-top:22px;padding:12px 18px;border-radius:12px;background:#ffc44d;color:#071a38;font-weight:900;text-decoration:none}</style></head><body><main class="card"><p class="eyebrow">별록 X 마인크래프트</p><h1 class="title">${escapeHtml(title)}</h1><p class="message">${escapeHtml(message)}</p><a class="home" href="/game-link.html">연동 화면으로 돌아가기</a></main></body></html>`;
}

function sendHtml(res, status, html) {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader("x-robots-tag", "noindex, noarchive");
  return res.status(status).send(html);
}

function errorCode(error) {
  return String(error?.code || error?.message || "game_link_failed").slice(0, 100);
}

export function createGameLinkHandler({
  store,
  oauth,
  env = process.env,
  now = () => new Date(),
} = {}) {
  if (!store || !oauth) throw new Error("store and oauth are required");
  const dataKey = decodeDataKey(env.GAME_LINK_DATA_KEY);
  const secureCookie = String(env.GAME_LINK_COOKIE_SECURE || "true").toLowerCase() !== "false";

  return async function gameLinkHandler(req, res) {
    res.setHeader("cache-control", "no-store, private");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    const operation = operationOf(req);
    const { query } = queryOf(req);

    try {
      if (operation === "health") {
        if (req.method !== "GET") return res.status(405).json({ code: "method_not_allowed" });
        return res.status(200).json({ ok: true, service: "byeollog-game-link", version: 1 });
      }

      if (operation === "soop-start") {
        if (req.method !== "GET") return res.status(405).json({ code: "method_not_allowed" });
        if (String(req.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
          return res.status(403).json({ code: 'request_origin_invalid' });
        }
        const token = randomToken();
        const state = randomToken();
        const startedAt = now();
        await store.createSession({
          tokenHash: sha256(token),
          soopStateHash: sha256(state),
          expiresAt: new Date(startedAt.getTime() + SESSION_TTL_SECONDS * 1000),
          now: startedAt,
        });
        setSessionCookie(res, token, secureCookie);
        clearOtherSoopFlowCookie(res, 'game', {secure: secureCookie});
        res.setHeader("location", oauth.buildSoopAuthorizationUrl({ state }));
        return res.status(302).end();
      }

      if (operation === "soop-callback") {
        if (req.method !== "GET") return res.status(405).json({ code: "method_not_allowed" });
        const token = sessionToken(req);
        const tokenHash = sha256(token);
        const session = token ? await store.getSession(tokenHash) : null;
        if (!session || session.status !== "soop_pending" || Date.parse(session.expires_at) <= now().getTime()) {
          clearSessionCookie(res, secureCookie);
          return sendHtml(
            res,
            400,
            resultPage({ title: "연동 요청이 만료되었습니다", message: "처음부터 다시 시작해주세요." }),
          );
        }
        if (query.error) {
          clearSessionCookie(res, secureCookie);
          return sendHtml(
            res,
            400,
            resultPage({ title: "SOOP 로그인이 취소되었습니다", message: "원할 때 다시 연동할 수 있습니다." }),
          );
        }
        const returnedState = String(query.state || "");
        if (
          (!returnedState && !oauth.allowMissingSoopState) ||
          (returnedState && !safeEqual(sha256(returnedState), session.soop_oauth_state_hash))
        ) {
          clearSessionCookie(res, secureCookie);
          return sendHtml(
            res,
            400,
            resultPage({ title: "SOOP 로그인 검증에 실패했습니다", message: "보안을 위해 연동을 중단했습니다." }),
          );
        }
        if (query.authCode && query.code && !safeEqual(String(query.authCode), String(query.code))) {
          return sendHtml(res, 400, resultPage({ title: "SOOP 로그인 검증에 실패했습니다", message: "처음부터 다시 시도해주세요." }));
        }
        const code = String(query.authCode || query.code || "");
        if (!code) {
          return sendHtml(
            res,
            400,
            resultPage({ title: "SOOP 인증 코드가 없습니다", message: "처음부터 다시 시도해주세요." }),
          );
        }
        const identity = await oauth.verifySoopCallback({ code });
        await store.recordSoopIdentity({
          tokenHash,
          stateHash: session.soop_oauth_state_hash,
          soopId: identity.soopId,
          now: now(),
        });

        const existingBinding = await store.getActiveBindingBySoop(identity.soopId);
        if (existingBinding) {
          clearSessionCookie(res, secureCookie);
          return sendHtml(
            res,
            200,
            resultPage({
              title: `${existingBinding.soop_user_id}님 계정은 이미 연동된 Minecraft 계정이 있습니다`,
              message: `연동된 Minecraft 계정: ${existingBinding.minecraft_name}`,
              success: true,
            }),
          );
        }

        const microsoftState = randomToken();
        const pkce = createPkcePair();
        await store.prepareMicrosoft({
          tokenHash,
          microsoftStateHash: sha256(microsoftState),
          pkceVerifierCiphertext: encryptShortLivedSecret(pkce.verifier, dataKey),
          now: now(),
        });
        res.setHeader(
          "location",
          oauth.buildMicrosoftAuthorizationUrl({
            state: microsoftState,
            challenge: pkce.challenge,
          }),
        );
        return res.status(302).end();
      }

      if (operation === "microsoft-callback") {
        if (req.method !== "GET") return res.status(405).json({ code: "method_not_allowed" });
        const token = sessionToken(req);
        const tokenHash = sha256(token);
        const session = token ? await store.getSession(tokenHash) : null;
        const returnedStateHash = sha256(String(query.state || ""));
        if (
          !session ||
          session.status !== "microsoft_pending" ||
          Date.parse(session.expires_at) <= now().getTime() ||
          !query.state ||
          !safeEqual(returnedStateHash, session.microsoft_oauth_state_hash)
        ) {
          clearSessionCookie(res, secureCookie);
          return sendHtml(
            res,
            400,
            resultPage({ title: "Microsoft 로그인 검증에 실패했습니다", message: "처음부터 다시 시도해주세요." }),
          );
        }
        if (query.error) {
          clearSessionCookie(res, secureCookie);
          return sendHtml(
            res,
            400,
            resultPage({ title: "Microsoft 로그인이 취소되었습니다", message: "원할 때 다시 연동할 수 있습니다." }),
          );
        }
        const code = String(query.code || "");
        if (!code) {
          return sendHtml(
            res,
            400,
            resultPage({ title: "Microsoft 인증 코드가 없습니다", message: "처음부터 다시 시도해주세요." }),
          );
        }
        const verifier = decryptShortLivedSecret(session.pkce_verifier_ciphertext, dataKey);
        const minecraft = await oauth.verifyMinecraftCallback({ code, verifier });
        const binding = await store.completeSession({
          tokenHash,
          microsoftStateHash: returnedStateHash,
          minecraftUuid: minecraft.minecraftUuid,
          minecraftName: minecraft.minecraftName,
          entitlementCount: minecraft.entitlementCount,
          now: now(),
        });
        clearSessionCookie(res, secureCookie);
        return sendHtml(
          res,
          200,
          resultPage({
            title: "계정 연동이 완료되었습니다",
            message: `SOOP ${binding.soop_user_id} 계정과 Minecraft ${binding.minecraft_name} 계정을 연결했습니다.`,
            success: true,
          }),
        );
      }

      if (operation === "status") {
        if (req.method !== "GET") return res.status(405).json({ code: "method_not_allowed" });
        const token = sessionToken(req);
        const session = token ? await store.getSession(sha256(token)) : null;
        if (!session) return res.status(200).json({ active: false, status: "not_started" });
        return res.status(200).json({
          active: Date.parse(session.expires_at) > now().getTime(),
          status: session.status,
        });
      }

      return res.status(404).json({ code: "not_found" });
    } catch (error) {
      const code = errorCode(error);
      console.error("[game-link] request failed", { operation, code });
      if (error instanceof GameLinkConflictError) {
        clearSessionCookie(res, secureCookie);
        return sendHtml(
          res,
          error.status,
          resultPage({ title: error.code === 'game_link_suspended' ? "정지된 계정 연동입니다" : "이미 다른 계정과 연결되어 있습니다", message: error.message }),
        );
      }
      const status = Number(error?.status || 500);
      if (operation.endsWith("callback")) {
        return sendHtml(
          res,
          status >= 400 && status < 600 ? status : 500,
          resultPage({
            title: "계정 연동을 완료하지 못했습니다",
            message: "잠시 후 처음부터 다시 시도해주세요. 문제가 계속되면 운영진에게 오류 코드를 알려주세요: " + code,
          }),
        );
      }
      return res.status(status >= 400 && status < 600 ? status : 500).json({ code });
    }
  };
}

export function gameLinkConfigFromEnv(env = process.env) {
  return {
    dataKey: decodeDataKey(env.GAME_LINK_DATA_KEY),
    secureCookie: String(env.GAME_LINK_COOKIE_SECURE || "true").toLowerCase() !== "false",
  };
}
