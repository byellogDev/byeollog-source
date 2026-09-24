import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { createGameLinkHandler } from "../apps/admin-runtime/lib/game-link-service.mjs";
import {
  GameLinkConflictError,
  MemoryGameLinkStore,
} from "../apps/admin-runtime/lib/game-link-store.mjs";
import {
  decodeDataKey,
  decryptShortLivedSecret,
  encryptShortLivedSecret,
  sha256,
} from "../apps/admin-runtime/lib/game-link-security.mjs";

const TEST_ENV = {
  GAME_LINK_DATA_KEY: Buffer.alloc(32, 7).toString("base64"),
  GAME_LINK_COOKIE_SECURE: "false",
};

function response() {
  const headers = new Map();
  return {
    statusCode: 200,
    body: "",
    setHeader(name, value) {
      headers.set(String(name).toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(String(name).toLowerCase());
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = JSON.stringify(value);
      return this;
    },
    send(value) {
      this.body = String(value);
      return this;
    },
    end(value = "") {
      this.body = String(value);
      return this;
    },
  };
}

function request(url, cookie = "") {
  return { method: "GET", url, headers: cookie ? { cookie } : {} };
}

function cookieFrom(res) {
  const header = res.getHeader("set-cookie");
  const value = Array.isArray(header) ? header[0] : header;
  return String(value).split(";")[0];
}

function fakeOAuth() {
  return {
    allowMissingSoopState: false,
    buildSoopAuthorizationUrl({ state }) {
      return `https://soop.test/authorize?state=${encodeURIComponent(state)}`;
    },
    async verifySoopCallback({ code }) {
      assert.equal(code, "soop-code");
      return { soopId: "fixture_streamer" };
    },
    buildMicrosoftAuthorizationUrl({ state, challenge }) {
      assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
      return `https://microsoft.test/authorize?state=${encodeURIComponent(state)}`;
    },
    async verifyMinecraftCallback({ code, verifier }) {
      assert.equal(code, "microsoft-code");
      assert.match(verifier, /^[A-Za-z0-9_-]{80,100}$/);
      return {
        minecraftUuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        minecraftName: "FixturePlayer",
        entitlementCount: 4,
      };
    },
  };
}

test("encrypts and authenticates the short-lived PKCE verifier", () => {
  const key = decodeDataKey(TEST_ENV.GAME_LINK_DATA_KEY);
  const encrypted = encryptShortLivedSecret("secret-verifier", key);
  assert.equal(decryptShortLivedSecret(encrypted, key), "secret-verifier");
  const parts = encrypted.split(".");
  parts[3] = `${parts[3].slice(0, -1)}A`;
  assert.throws(() => decryptShortLivedSecret(parts.join("."), key));
});

test("links a verified SOOP identity to a verified Minecraft Java profile", async () => {
  const store = new MemoryGameLinkStore();
  const handler = createGameLinkHandler({ store, oauth: fakeOAuth(), env: TEST_ENV });

  const startRes = response();
  await handler(request("/api/game-link/soop/start"), startRes);
  assert.equal(startRes.statusCode, 302);
  const cookie = cookieFrom(startRes);
  const soopLocation = new URL(startRes.getHeader("location"));
  const soopState = soopLocation.searchParams.get("state");
  assert.ok(soopState);

  const soopRes = response();
  await handler(
    request(
      `/api/game-link/soop/callback?code=soop-code&state=${encodeURIComponent(soopState)}`,
      cookie,
    ),
    soopRes,
  );
  assert.equal(soopRes.statusCode, 302);
  const microsoftLocation = new URL(soopRes.getHeader("location"));
  const microsoftState = microsoftLocation.searchParams.get("state");
  assert.ok(microsoftState);

  const microsoftRes = response();
  await handler(
    request(
      `/api/game-link/microsoft/callback?code=microsoft-code&state=${encodeURIComponent(microsoftState)}`,
      cookie,
    ),
    microsoftRes,
  );
  assert.equal(microsoftRes.statusCode, 200);
  assert.match(microsoftRes.body, /fixture_streamer/);
  assert.match(microsoftRes.body, /FixturePlayer/);
  assert.equal(
    store.bindingsBySoop.get("fixture_streamer")?.minecraft_uuid,
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  );
  assert.equal(store.audit[0]?.details?.entitlement_count, 4);

  const storedSession = [...store.sessions.values()][0];
  assert.equal(storedSession.status, "completed");
  assert.equal(storedSession.pkce_verifier_ciphertext, null);
  assert.equal(storedSession.microsoft_oauth_state_hash, null);
});

test("stops before Microsoft when the verified SOOP account is already linked", async () => {
  const store = new MemoryGameLinkStore();
  const binding = {
    id: "30000000-0000-4000-8000-000000000003",
    soop_user_id: "fixture_streamer",
    minecraft_uuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    minecraft_name: "FixturePlayer",
    status: "active",
  };
  store.bindingsBySoop.set(binding.soop_user_id, binding);
  store.bindingsByMinecraft.set(binding.minecraft_uuid, binding);
  const oauth = fakeOAuth();
  oauth.buildMicrosoftAuthorizationUrl = () => {
    throw new Error("Microsoft authorization must not start for an existing binding");
  };
  const handler = createGameLinkHandler({ store, oauth, env: TEST_ENV });

  const startRes = response();
  await handler(request("/api/game-link/soop/start"), startRes);
  const cookie = cookieFrom(startRes);
  const soopState = new URL(startRes.getHeader("location")).searchParams.get("state");

  const callbackRes = response();
  await handler(
    request(
      `/api/game-link/soop/callback?code=soop-code&state=${encodeURIComponent(soopState)}`,
      cookie,
    ),
    callbackRes,
  );

  assert.equal(callbackRes.statusCode, 200);
  assert.match(callbackRes.body, /fixture_streamer님 계정은 이미 연동된 Minecraft 계정이 있습니다/);
  assert.match(callbackRes.body, /연동된 Minecraft 계정: FixturePlayer/);
  assert.match(String(callbackRes.getHeader("set-cookie")), /Max-Age=0/);
});

test("rejects a mismatched SOOP OAuth state before token exchange", async () => {
  const store = new MemoryGameLinkStore();
  let exchanged = false;
  const oauth = fakeOAuth();
  oauth.verifySoopCallback = async () => {
    exchanged = true;
    return { soopId: "fixture_streamer" };
  };
  const handler = createGameLinkHandler({ store, oauth, env: TEST_ENV });

  const startRes = response();
  await handler(request("/api/game-link/soop/start"), startRes);
  const callbackRes = response();
  await handler(
    request(
      "/api/game-link/soop/callback?code=soop-code&state=attacker-state",
      cookieFrom(startRes),
    ),
    callbackRes,
  );
  assert.equal(callbackRes.statusCode, 400);
  assert.equal(exchanged, false);
});

test("does not silently reassign a Minecraft UUID to another SOOP identity", async () => {
  const store = new MemoryGameLinkStore();
  const now = new Date();
  const uuid = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  async function complete(soopId, token) {
    const tokenHash = sha256(token);
    await store.createSession({
      tokenHash,
      soopStateHash: sha256("soop-state"),
      expiresAt: new Date(now.getTime() + 60_000),
      now,
    });
    await store.recordSoopIdentity({
      tokenHash,
      stateHash: sha256("soop-state"),
      soopId,
      now,
    });
    await store.prepareMicrosoft({
      tokenHash,
      microsoftStateHash: sha256("ms-state"),
      pkceVerifierCiphertext: "test",
      now,
    });
    return store.completeSession({
      tokenHash,
      microsoftStateHash: sha256("ms-state"),
      minecraftUuid: uuid,
      minecraftName: "FixturePlayer",
      now,
    });
  }

  await complete("fixture_streamer", "first-session");
  await assert.rejects(
    () => complete("other_streamer", "second-session"),
    (error) =>
      error instanceof GameLinkConflictError &&
      error.code === "game_link_minecraft_conflict",
  );
});

test("attaches a later Byeollog signup to the existing game identity", async () => {
  const store = new MemoryGameLinkStore();
  const now = new Date("2026-09-21T10:00:00.000Z");
  const tokenHash = sha256("game-first-session");
  await store.createSession({
    tokenHash,
    soopStateHash: sha256("soop-state"),
    expiresAt: new Date(now.getTime() + 60_000),
    now,
  });
  await store.recordSoopIdentity({
    tokenHash,
    stateHash: sha256("soop-state"),
    soopId: "fixture_streamer",
    now,
  });
  await store.prepareMicrosoft({
    tokenHash,
    microsoftStateHash: sha256("ms-state"),
    pkceVerifierCiphertext: "test",
    now,
  });
  const gameOnly = await store.completeSession({
    tokenHash,
    microsoftStateHash: sha256("ms-state"),
    minecraftUuid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    minecraftName: "FixturePlayer",
    now,
  });
  assert.equal(gameOnly.byeollog_user_id, null);
  assert.equal(gameOnly.workspace_id, null);

  const attached = await store.attachByeollogAccount({
    soopId: "FIXTURE_STREAMER",
    userId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "20000000-0000-4000-8000-000000000002",
    now: new Date(now.getTime() + 1_000),
  });

  assert.equal(attached.id, gameOnly.id);
  assert.equal(attached.minecraft_uuid, gameOnly.minecraft_uuid);
  assert.equal(attached.byeollog_user_id, "10000000-0000-4000-8000-000000000001");
  assert.equal(attached.workspace_id, "20000000-0000-4000-8000-000000000002");
  assert.equal(store.bindingsBySoop.size, 1);
  assert.equal(store.audit.at(-1)?.event_type, "game_link_byeollog_account_attached");
});

test("migration keeps game identity tables server-only and completion atomic", async () => {
  const sql = await fs.readFile(
    new URL(
      "../supabase/migrations/20260921190000_add_game_identity_linking.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /enable row level security/);
  assert.match(sql, /revoke all on table public\.byeollog_game_identity_bindings from anon, authenticated/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /pkce_verifier_ciphertext = null/);
  assert.match(sql, /byeollog_user_id uuid references auth\.users\(id\) on delete set null/);
  assert.match(sql, /workspace_id uuid references public\.byeollog_workspaces\(id\) on delete set null/);
  assert.match(sql, /create trigger byeollog_attach_game_identity_to_workspace_v1/);
  assert.match(sql, /game_link_byeollog_account_attached/);
});
