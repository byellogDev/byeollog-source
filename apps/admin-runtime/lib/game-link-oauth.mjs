import {
  normalizeMinecraftName,
  normalizeMinecraftUuid,
  normalizeSoopId,
} from "./game-link-security.mjs";

const SOOP_AUTHORIZATION_URL = "https://openapi.sooplive.com/auth/code";
const SOOP_TOKEN_URL = "https://openapi.sooplive.com/auth/token";
const SOOP_IDENTITY_URL = "https://openapi.sooplive.com/validate/live/status";
const MICROSOFT_AUTHORIZATION_URL =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
const MICROSOFT_TOKEN_URL =
  "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const XBOX_USER_AUTH_URL = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL = "https://xsts.auth.xboxlive.com/xsts/authorize";
const MINECRAFT_LOGIN_URL =
  "https://api.minecraftservices.com/authentication/login_with_xbox";
const MINECRAFT_ENTITLEMENTS_URL =
  "https://api.minecraftservices.com/entitlements/mcstore";
const MINECRAFT_PROFILE_URL =
  "https://api.minecraftservices.com/minecraft/profile";

export class GameLinkOAuthError extends Error {
  constructor(message, code, status = 502, details = {}) {
    super(message);
    this.name = "GameLinkOAuthError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function required(env, name, minLength = 1) {
  const value = String(env[name] || "").trim();
  if (value.length < minLength) {
    throw new GameLinkOAuthError(
      `${name} is not configured`,
      "game_link_config_missing",
      503,
      { name },
    );
  }
  return value;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new GameLinkOAuthError(
        "인증 서버 응답 시간이 초과되었습니다.",
        "oauth_timeout",
        504,
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function readJson(response, code) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new GameLinkOAuthError(
      body.error_description || body.message || body.error || `HTTP ${response.status}`,
      code,
      502,
      { upstreamStatus: response.status, xErr: body.XErr },
    );
  }
  return body;
}

export function createProductionOAuth({ env = process.env, fetchImpl = fetch } = {}) {
  const soopClientId = required(env, "SOOP_CLIENT_ID", 16);
  const soopClientSecret = required(env, "SOOP_CLIENT_SECRET", 24);
  const soopRedirectUri = required(env, "SOOP_REDIRECT_URI", 10);
  const microsoftClientId =
    String(env.BYEOLLOG_CONNECT_CLIENT_ID || "").trim() ||
    "f2bdae87-6a5e-49e1-8bb7-1da5e10c47a6";
  const microsoftClientSecret = required(env, "BYEOLLOG_CONNECT_CLIENT_SECRET", 8);
  const microsoftRedirectUri = required(env, "MICROSOFT_REDIRECT_URI", 10);
  const allowMissingSoopState =
    String(env.SOOP_ALLOW_MISSING_STATE || "false").toLowerCase() === "true";

  new URL(soopRedirectUri);
  new URL(microsoftRedirectUri);

  return {
    allowMissingSoopState,

    buildSoopAuthorizationUrl({ state }) {
      const url = new URL(SOOP_AUTHORIZATION_URL);
      url.searchParams.set("client_id", soopClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("state", state);
      return url.toString();
    },

    async verifySoopCallback({ code }) {
      const tokenResponse = await fetchWithTimeout(fetchImpl, SOOP_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: soopClientId,
          client_secret: soopClientSecret,
        }),
        cache: "no-store",
      });
      const token = await readJson(tokenResponse, "soop_token_exchange_failed");
      if (!token.access_token) {
        throw new GameLinkOAuthError(
          "SOOP access token이 없습니다.",
          "soop_token_exchange_failed",
        );
      }

      const identityResponse = await fetchWithTimeout(fetchImpl, SOOP_IDENTITY_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
        body: new URLSearchParams({ access_token: String(token.access_token) }),
        cache: "no-store",
      });
      const identity = await readJson(
        identityResponse,
        "soop_identity_verification_failed",
      );
      const officialId = String(identity?.data?.user_id || "").trim();
      const legacyId = String(identity?.data?.broad_no || "").trim();
      const soopId = officialId || (!/^\d+$/.test(legacyId) ? legacyId : "");
      return { soopId: normalizeSoopId(soopId) };
    },

    buildMicrosoftAuthorizationUrl({ state, challenge }) {
      const url = new URL(MICROSOFT_AUTHORIZATION_URL);
      url.searchParams.set("client_id", microsoftClientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("redirect_uri", microsoftRedirectUri);
      url.searchParams.set("response_mode", "query");
      url.searchParams.set("scope", "XboxLive.signin");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", challenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("prompt", "select_account");
      return url.toString();
    },

    async verifyMinecraftCallback({ code, verifier }) {
      const microsoftResponse = await fetchWithTimeout(fetchImpl, MICROSOFT_TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: microsoftClientId,
          client_secret: microsoftClientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: microsoftRedirectUri,
          scope: "XboxLive.signin",
          code_verifier: verifier,
        }),
        cache: "no-store",
      });
      const microsoft = await readJson(
        microsoftResponse,
        "microsoft_token_exchange_failed",
      );
      if (!microsoft.access_token) {
        throw new GameLinkOAuthError(
          "Microsoft access token이 없습니다.",
          "microsoft_token_exchange_failed",
        );
      }

      const xboxResponse = await fetchWithTimeout(fetchImpl, XBOX_USER_AUTH_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xbl-contract-version": "1",
        },
        body: JSON.stringify({
          Properties: {
            AuthMethod: "RPS",
            SiteName: "user.auth.xboxlive.com",
            RpsTicket: `d=${microsoft.access_token}`,
          },
          RelyingParty: "http://auth.xboxlive.com",
          TokenType: "JWT",
        }),
        cache: "no-store",
      });
      const xbox = await readJson(xboxResponse, "xbox_user_token_failed");

      const xstsResponse = await fetchWithTimeout(fetchImpl, XSTS_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xbl-contract-version": "1",
        },
        body: JSON.stringify({
          Properties: { SandboxId: "RETAIL", UserTokens: [xbox.Token] },
          RelyingParty: "rp://api.minecraftservices.com/",
          TokenType: "JWT",
        }),
        cache: "no-store",
      });
      const xsts = await readJson(xstsResponse, "xsts_token_failed");
      const userHash = xsts?.DisplayClaims?.xui?.[0]?.uhs;
      if (!xsts.Token || !userHash) {
        throw new GameLinkOAuthError("XSTS 응답이 올바르지 않습니다.", "xsts_token_failed");
      }

      const minecraftResponse = await fetchWithTimeout(fetchImpl, MINECRAFT_LOGIN_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identityToken: `XBL3.0 x=${userHash};${xsts.Token}` }),
        cache: "no-store",
      });
      const minecraft = await readJson(
        minecraftResponse,
        "minecraft_token_exchange_failed",
      );
      if (!minecraft.access_token) {
        throw new GameLinkOAuthError(
          "Minecraft Services access token이 없습니다.",
          "minecraft_token_exchange_failed",
        );
      }

      const [entitlementsResponse, profileResponse] = await Promise.all([
        fetchWithTimeout(fetchImpl, MINECRAFT_ENTITLEMENTS_URL, {
          headers: { authorization: `Bearer ${minecraft.access_token}` },
          cache: "no-store",
        }),
        fetchWithTimeout(fetchImpl, MINECRAFT_PROFILE_URL, {
          headers: { authorization: `Bearer ${minecraft.access_token}` },
          cache: "no-store",
        }),
      ]);
      const entitlements = await readJson(
        entitlementsResponse,
        "minecraft_entitlements_failed",
      );
      const profile = await readJson(profileResponse, "minecraft_profile_failed");

      return {
        minecraftUuid: normalizeMinecraftUuid(profile.id),
        minecraftName: normalizeMinecraftName(profile.name),
        entitlementCount: Array.isArray(entitlements.items)
          ? entitlements.items.length
          : 0,
      };
    },
  };
}
