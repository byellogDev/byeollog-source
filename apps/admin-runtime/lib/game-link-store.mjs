import crypto from "node:crypto";

export class GameLinkConflictError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "GameLinkConflictError";
    this.code = code;
    this.status = 409;
  }
}

function assertActive(session, expectedStatus, now) {
  if (!session) throw new Error("game_link_session_not_found");
  if (session.status !== expectedStatus) throw new Error("game_link_session_stage_invalid");
  if (Date.parse(session.expires_at) <= now.getTime()) throw new Error("game_link_session_expired");
}

export class MemoryGameLinkStore {
  constructor() {
    this.sessions = new Map();
    this.bindingsBySoop = new Map();
    this.bindingsByMinecraft = new Map();
    this.audit = [];
  }

  async createSession({ tokenHash, soopStateHash, expiresAt, now = new Date() }) {
    const session = {
      id: crypto.randomUUID(),
      browser_token_hash: tokenHash,
      status: "soop_pending",
      soop_oauth_state_hash: soopStateHash,
      microsoft_oauth_state_hash: null,
      pkce_verifier_ciphertext: null,
      soop_user_id: null,
      expires_at: expiresAt.toISOString(),
      completed_at: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    this.sessions.set(tokenHash, session);
    return { ...session };
  }

  async getSession(tokenHash) {
    const session = this.sessions.get(tokenHash);
    return session ? { ...session } : null;
  }

  async getActiveBindingBySoop(soopId) {
    const binding = this.bindingsBySoop.get(String(soopId || "").trim().toLowerCase());
    return binding?.status === "active" ? { ...binding } : null;
  }

  async recordSoopIdentity({ tokenHash, stateHash, soopId, now = new Date() }) {
    const session = this.sessions.get(tokenHash);
    assertActive(session, "soop_pending", now);
    if (session.soop_oauth_state_hash !== stateHash) throw new Error("soop_oauth_state_invalid");
    session.status = "soop_verified";
    session.soop_user_id = soopId;
    session.soop_oauth_state_hash = null;
    session.updated_at = now.toISOString();
    return { ...session };
  }

  async prepareMicrosoft({
    tokenHash,
    microsoftStateHash,
    pkceVerifierCiphertext,
    now = new Date(),
  }) {
    const session = this.sessions.get(tokenHash);
    assertActive(session, "soop_verified", now);
    session.status = "microsoft_pending";
    session.microsoft_oauth_state_hash = microsoftStateHash;
    session.pkce_verifier_ciphertext = pkceVerifierCiphertext;
    session.updated_at = now.toISOString();
    return { ...session };
  }

  async completeSession({
    tokenHash,
    microsoftStateHash,
    minecraftUuid,
    minecraftName,
    entitlementCount = 0,
    now = new Date(),
  }) {
    const session = this.sessions.get(tokenHash);
    assertActive(session, "microsoft_pending", now);
    if (session.microsoft_oauth_state_hash !== microsoftStateHash) {
      throw new Error("microsoft_oauth_state_invalid");
    }

    const soopExisting = this.bindingsBySoop.get(session.soop_user_id);
    const minecraftExisting = this.bindingsByMinecraft.get(minecraftUuid);
    if (soopExisting?.status === "suspended" || minecraftExisting?.status === "suspended") {
      throw new GameLinkConflictError("정지된 계정 연동입니다. 운영진에게 문의해주세요.", "game_link_suspended");
    }
    if (soopExisting && soopExisting.minecraft_uuid !== minecraftUuid) {
      throw new GameLinkConflictError(
        "이 SOOP 계정은 다른 Minecraft 계정과 이미 연결되어 있습니다.",
        "game_link_soop_conflict",
      );
    }
    if (minecraftExisting && minecraftExisting.soop_user_id !== session.soop_user_id) {
      throw new GameLinkConflictError(
        "이 Minecraft 계정은 다른 SOOP 계정과 이미 연결되어 있습니다.",
        "game_link_minecraft_conflict",
      );
    }

    const binding = soopExisting || minecraftExisting || {
      id: crypto.randomUUID(),
      soop_user_id: session.soop_user_id,
      minecraft_uuid: minecraftUuid,
      byeollog_user_id: null,
      workspace_id: null,
      linked_at: now.toISOString(),
    };
    binding.minecraft_name = minecraftName;
    binding.status = "active";
    binding.verified_at = now.toISOString();
    binding.updated_at = now.toISOString();
    this.bindingsBySoop.set(binding.soop_user_id, binding);
    this.bindingsByMinecraft.set(binding.minecraft_uuid, binding);

    session.status = "completed";
    session.microsoft_oauth_state_hash = null;
    session.pkce_verifier_ciphertext = null;
    session.completed_at = now.toISOString();
    session.updated_at = now.toISOString();
    this.audit.push({
      event_type: "game_link_completed",
      binding_id: binding.id,
      soop_user_id: binding.soop_user_id,
      minecraft_uuid: binding.minecraft_uuid,
      details: { minecraft_name: minecraftName, entitlement_count: entitlementCount },
      created_at: now.toISOString(),
    });
    return { ...binding };
  }

  async attachByeollogAccount({ soopId, userId, workspaceId, now = new Date() }) {
    const binding = this.bindingsBySoop.get(String(soopId).trim().toLowerCase());
    if (!binding) return null;
    if (binding.byeollog_user_id === userId && binding.workspace_id === workspaceId) {
      return { ...binding };
    }
    binding.byeollog_user_id = userId;
    binding.workspace_id = workspaceId;
    binding.updated_at = now.toISOString();
    this.audit.push({
      event_type: "game_link_byeollog_account_attached",
      binding_id: binding.id,
      soop_user_id: binding.soop_user_id,
      minecraft_uuid: binding.minecraft_uuid,
      details: { byeollog_user_id: userId, workspace_id: workspaceId },
      created_at: now.toISOString(),
    });
    return { ...binding };
  }
}

async function readResponse(response) {
  const raw = await response.text();
  const body = raw ? JSON.parse(raw) : null;
  if (!response.ok) {
    const message = body?.message || body?.hint || `Supabase HTTP ${response.status}`;
    if (message.includes("game_link_suspended")) {
      throw new GameLinkConflictError("정지된 계정 연동입니다. 운영진에게 문의해주세요.", "game_link_suspended");
    }
    if (message.includes("game_link_soop_conflict")) {
      throw new GameLinkConflictError(
        "이 SOOP 계정은 다른 Minecraft 계정과 이미 연결되어 있습니다.",
        "game_link_soop_conflict",
      );
    }
    if (message.includes("game_link_minecraft_conflict")) {
      throw new GameLinkConflictError(
        "이 Minecraft 계정은 다른 SOOP 계정과 이미 연결되어 있습니다.",
        "game_link_minecraft_conflict",
      );
    }
    throw new Error(message);
  }
  return body;
}

export class SupabaseGameLinkStore {
  constructor({ url, serviceRoleKey, fetchImpl = fetch }) {
    this.url = String(url || "").replace(/\/$/, "");
    this.serviceRoleKey = String(serviceRoleKey || "");
    this.fetchImpl = fetchImpl;
    if (!this.url || !this.serviceRoleKey) {
      throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
    }
  }

  async request(path, { method = "GET", body, prefer } = {}) {
    const response = await this.fetchImpl(`${this.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.serviceRoleKey,
        authorization: `Bearer ${this.serviceRoleKey}`,
        "content-type": "application/json",
        ...(prefer ? { prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    return readResponse(response);
  }

  async createSession({ tokenHash, soopStateHash, expiresAt }) {
    const rows = await this.request("byeollog_game_link_sessions", {
      method: "POST",
      prefer: "return=representation",
      body: {
        browser_token_hash: tokenHash,
        status: "soop_pending",
        soop_oauth_state_hash: soopStateHash,
        expires_at: expiresAt.toISOString(),
      },
    });
    return rows?.[0] || null;
  }

  async getSession(tokenHash) {
    const rows = await this.request(
      `byeollog_game_link_sessions?select=*&browser_token_hash=eq.${encodeURIComponent(tokenHash)}&limit=1`,
    );
    return rows?.[0] || null;
  }

  async getActiveBindingBySoop(soopId) {
    const normalized = String(soopId || "").trim().toLowerCase();
    const rows = await this.request(
      `byeollog_game_identity_bindings?select=id,soop_user_id,minecraft_uuid,minecraft_name,status` +
        `&soop_user_id=eq.${encodeURIComponent(normalized)}&status=eq.active&limit=1`,
    );
    return rows?.[0] || null;
  }

  async recordSoopIdentity({ tokenHash, stateHash, soopId, now = new Date() }) {
    const rows = await this.request(
      `byeollog_game_link_sessions?browser_token_hash=eq.${encodeURIComponent(tokenHash)}` +
        `&status=eq.soop_pending&soop_oauth_state_hash=eq.${encodeURIComponent(stateHash)}` +
        `&expires_at=gt.${encodeURIComponent(now.toISOString())}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: {
          status: "soop_verified",
          soop_user_id: soopId,
          soop_oauth_state_hash: null,
          updated_at: now.toISOString(),
        },
      },
    );
    if (!rows?.[0]) throw new Error("soop_oauth_state_invalid");
    return rows[0];
  }

  async prepareMicrosoft({
    tokenHash,
    microsoftStateHash,
    pkceVerifierCiphertext,
    now = new Date(),
  }) {
    const rows = await this.request(
      `byeollog_game_link_sessions?browser_token_hash=eq.${encodeURIComponent(tokenHash)}` +
        `&status=eq.soop_verified&expires_at=gt.${encodeURIComponent(now.toISOString())}`,
      {
        method: "PATCH",
        prefer: "return=representation",
        body: {
          status: "microsoft_pending",
          microsoft_oauth_state_hash: microsoftStateHash,
          pkce_verifier_ciphertext: pkceVerifierCiphertext,
          updated_at: now.toISOString(),
        },
      },
    );
    if (!rows?.[0]) throw new Error("game_link_session_stage_invalid");
    return rows[0];
  }

  async completeSession({
    tokenHash,
    microsoftStateHash,
    minecraftUuid,
    minecraftName,
    entitlementCount,
  }) {
    const rows = await this.request("rpc/byeollog_complete_game_link", {
      method: "POST",
      body: {
        p_session_token_hash: tokenHash,
        p_microsoft_state_hash: microsoftStateHash,
        p_minecraft_uuid: minecraftUuid,
        p_minecraft_name: minecraftName,
        p_entitlement_count: entitlementCount,
      },
    });
    return rows?.[0] || rows;
  }
}

export function createStoreFromEnv(env = process.env) {
  return new SupabaseGameLinkStore({
    url: env.SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  });
}
