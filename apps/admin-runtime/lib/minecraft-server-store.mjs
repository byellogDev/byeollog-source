export class MinecraftServerStoreError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.name = "MinecraftServerStoreError";
    this.code = message;
    this.status = status;
  }
}

async function readResponse(response) {
  const raw = await response.text();
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message = String(body?.message || body?.hint || "minecraft_server_store_failed");
    const known = [
      "minecraft_server_auth_invalid",
      "minecraft_server_request_expired",
      "minecraft_server_request_replayed",
      "minecraft_server_request_invalid",
    ].find((code) => message.includes(code));
    if (known) {
      const status = known === "minecraft_server_auth_invalid" ? 401 : 400;
      throw new MinecraftServerStoreError(known, status);
    }
    throw new MinecraftServerStoreError("minecraft_server_store_failed", 503);
  }
  return body;
}

export class SupabaseMinecraftServerStore {
  constructor({ url, serviceRoleKey, fetchImpl = fetch }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.serviceRoleKey = String(serviceRoleKey || "");
    this.fetchImpl = fetchImpl;
    if (!this.url || !this.serviceRoleKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
  }

  async authorizePlayer({
    serverId,
    apiKeyHash,
    requestIdHash,
    requestedAt,
    minecraftUuid,
  }) {
    const response = await this.fetchImpl(
      `${this.url}/rest/v1/rpc/byeollog_authorize_minecraft_server_player`,
      {
        method: "POST",
        headers: {
          apikey: this.serviceRoleKey,
          authorization: `Bearer ${this.serviceRoleKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          p_server_id: serverId,
          p_api_key_hash: apiKeyHash,
          p_request_id_hash: requestIdHash,
          p_requested_at: requestedAt.toISOString(),
          p_minecraft_uuid: minecraftUuid,
        }),
        cache: "no-store",
      },
    );
    const rows = await readResponse(response);
    return rows?.[0] || null;
  }
}

export function createMinecraftServerStoreFromEnv(env = process.env) {
  return new SupabaseMinecraftServerStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
}

