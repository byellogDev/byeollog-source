import { normalizeMinecraftUuid, sha256 } from "./game-link-security.mjs";
import { MinecraftServerStoreError } from "./minecraft-server-store.mjs";

const SERVER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const API_KEY_PATTERN = /^bms_[A-Za-z0-9_-]{43}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const MAX_BODY_BYTES = 4 * 1024;

function singleHeader(req, name) {
  const value = req.headers?.[name];
  if (Array.isArray(value) || value === undefined || value === null) return "";
  const normalized = String(value).trim();
  return normalized.includes(",") ? "" : normalized;
}

function bearerToken(req) {
  const authorization = singleHeader(req, "authorization");
  const match = /^Bearer ([^ ]+)$/.exec(authorization);
  return match?.[1] || "";
}

async function bodyOf(req) {
  try {
    let raw;
    if (Buffer.isBuffer(req.body)) raw = req.body;
    else if (typeof req.body === "string") raw = Buffer.from(req.body);
    else if (req.body !== undefined) raw = Buffer.from(JSON.stringify(req.body));
    else {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_BODY_BYTES) throw new Error("request_invalid");
        chunks.push(bytes);
      }
      raw = Buffer.concat(chunks);
    }
    if (raw.length > MAX_BODY_BYTES) throw new Error("request_invalid");
    const body = JSON.parse(raw.toString("utf8"));
    if (!body || Array.isArray(body) || typeof body !== "object") throw new Error("request_invalid");
    return body;
  } catch { throw new Error("request_invalid"); }
}

function operationOf(req) {
  const url = new URL(req.url || "/", "http://minecraft-server.local");
  const operation = String(req.query?.operation || url.searchParams.get("operation") || "");
  if (operation) return operation;
  return url.pathname.replace(/\/$/, "") === "/api/minecraft-server/player"
    ? "player"
    : "unknown";
}

function parseTimestamp(value) {
  if (!/^\d{10}$/.test(value)) throw new Error("request_invalid");
  const parsed = new Date(Number(value) * 1000);
  if (!Number.isFinite(parsed.getTime())) throw new Error("request_invalid");
  return parsed;
}

export function createMinecraftServerHandler({ store } = {}) {
  if (!store) throw new Error("store is required");

  return async function minecraftServerHandler(req, res) {
    res.setHeader("cache-control", "no-store, private");
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("x-content-type-options", "nosniff");

    if (operationOf(req) !== "player") {
      return res.status(404).json({ code: "not_found" });
    }
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      return res.status(405).json({ code: "method_not_allowed" });
    }

    try {
      const serverId = singleHeader(req, "x-byeollog-server-id");
      const requestId = singleHeader(req, "x-byeollog-request-id");
      const timestamp = singleHeader(req, "x-byeollog-timestamp");
      const apiKey = bearerToken(req);
      if (
        !SERVER_ID_PATTERN.test(serverId) ||
        !API_KEY_PATTERN.test(apiKey) ||
        !REQUEST_ID_PATTERN.test(requestId)
      ) {
        return res.status(401).json({ code: "server_auth_invalid" });
      }

      const requestedAt = parseTimestamp(timestamp);
      const body = await bodyOf(req);
      const minecraftUuid = normalizeMinecraftUuid(body?.minecraftUuid);
      const player = await store.authorizePlayer({
        serverId: serverId.toLowerCase(),
        apiKeyHash: sha256(apiKey),
        requestIdHash: sha256(requestId),
        requestedAt,
        minecraftUuid,
      });

      if (!player) return res.status(404).json({ code: "player_not_available" });
      return res.status(200).json({
        linked: true,
        player: {
          soopUserId: player.soop_user_id,
          minecraftUuid: player.minecraft_uuid,
          minecraftName: player.minecraft_name,
        },
      });
    } catch (error) {
      const code = String(error?.code || error?.message || "minecraft_server_failed");
      if (error instanceof MinecraftServerStoreError) {
        if (code === "minecraft_server_auth_invalid") {
          return res.status(401).json({ code: "server_auth_invalid" });
        }
        if (code === "minecraft_server_request_replayed") {
          return res.status(409).json({ code: "request_replayed" });
        }
        if (code === "minecraft_server_request_expired") {
          return res.status(400).json({ code: "request_expired" });
        }
      }
      if (code === "request_invalid" || code === "minecraft_server_request_invalid" || code.startsWith("Invalid Minecraft")) {
        return res.status(400).json({ code: "request_invalid" });
      }
      console.error("[minecraft-server] request failed", { code: code.slice(0, 100) });
      return res.status(503).json({ code: "service_unavailable" });
    }
  };
}
