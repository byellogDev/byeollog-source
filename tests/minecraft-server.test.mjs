import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import { sha256 } from "../apps/admin-runtime/lib/game-link-security.mjs";
import { createMinecraftServerHandler } from "../apps/admin-runtime/lib/minecraft-server-service.mjs";
import { MinecraftServerStoreError } from "../apps/admin-runtime/lib/minecraft-server-store.mjs";

const SERVER_ID = "10000000-0000-4000-8000-000000000001";
const API_KEY = `bms_${"a".repeat(43)}`;
const REQUEST_ID = "request_1234567890abcdef";
const MINECRAFT_UUID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

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
  };
}

function request(overrides = {}) {
  return {
    method: "POST",
    url: "/api/minecraft-server/player",
    query: {},
    headers: {
      authorization: `Bearer ${API_KEY}`,
      "x-byeollog-server-id": SERVER_ID,
      "x-byeollog-request-id": REQUEST_ID,
      "x-byeollog-timestamp": "1789952400",
    },
    body: { minecraftUuid: MINECRAFT_UUID },
    ...overrides,
  };
}

test("returns a linked identity only after the store authorizes that server grant", async () => {
  let received;
  const handler = createMinecraftServerHandler({
    store: {
      async authorizePlayer(input) {
        received = input;
        return {
          soop_user_id: "fixture_streamer",
          minecraft_uuid: MINECRAFT_UUID,
          minecraft_name: "FixturePlayer",
        };
      },
    },
  });
  const res = response();
  await handler(request(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    linked: true,
    player: {
      soopUserId: "fixture_streamer",
      minecraftUuid: MINECRAFT_UUID,
      minecraftName: "FixturePlayer",
    },
  });
  assert.equal(received.serverId, SERVER_ID);
  assert.equal(received.apiKeyHash, sha256(API_KEY));
  assert.equal(received.requestIdHash, sha256(REQUEST_ID));
  assert.equal(received.minecraftUuid, MINECRAFT_UUID);
  assert.equal(received.requestedAt.toISOString(), "2026-09-21T01:00:00.000Z");
});

test("does not reveal whether an ungranted player is globally linked", async () => {
  const handler = createMinecraftServerHandler({
    store: { authorizePlayer: async () => null },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { code: "player_not_available" });
});

test("rejects malformed credentials before querying the store", async () => {
  let called = false;
  const handler = createMinecraftServerHandler({
    store: { authorizePlayer: async () => (called = true) },
  });
  const res = response();
  await handler(
    request({ headers: { ...request().headers, authorization: "Bearer exposed" } }),
    res,
  );
  assert.equal(res.statusCode, 401);
  assert.equal(called, false);
});

test("maps a replayed request to a conflict without leaking store details", async () => {
  const handler = createMinecraftServerHandler({
    store: {
      authorizePlayer: async () => {
        throw new MinecraftServerStoreError("minecraft_server_request_replayed", 400);
      },
    },
  });
  const res = response();
  await handler(request(), res);
  assert.equal(res.statusCode, 409);
  assert.deepEqual(JSON.parse(res.body), { code: "request_replayed" });
});

test("migration enforces server scoping, replay protection, and server-only access", async () => {
  const sql = await fs.readFile(
    new URL(
      "../supabase/migrations/20260921190100_add_minecraft_server_scope.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(sql, /byeollog_minecraft_servers enable row level security/);
  assert.match(sql, /byeollog_minecraft_server_player_grants enable row level security/);
  assert.match(sql, /revoke all on table public\.byeollog_minecraft_servers\s+from public, anon, authenticated/);
  assert.match(sql, /security invoker/);
  assert.match(sql, /set search_path = ''/);
  assert.match(sql, /minecraft_server_request_replayed/);
  assert.match(sql, /g\.server_id = p_server_id/);
  assert.match(sql, /g\.status = 'active'/);
  assert.match(sql, /b\.status = 'active'/);
  assert.doesNotMatch(sql, /api_key[^\n]*default/i);
});
