import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = auditURL("../", import.meta.url);

test("direct Agent transport removes idle Edge invocations without moving action leases", async () => {
  const [migration, edge] = await Promise.all([
    readFile(auditURL("supabase/migrations/20260901182718_agent_direct_sync_transport.sql", root), "utf8"),
    readFile(auditURL("supabase/functions/agent-runtime/index.ts", root), "utf8")
  ]);

  assert.match(migration, /g3a_agent_direct_pending_v1/);
  assert.match(migration, /g3a_agent_direct_report_v1/);
  assert.match(migration, /g3a_agent_direct_wallpaper_snapshot_v1/);
  assert.match(migration, /auth\.jwt\(\)->>'session_id'/);
  assert.match(migration, /g3a_authenticate_agent_device_v1/);
  assert.match(migration, /execution_target = 'local_agent'/);
  assert.match(migration, /execution\.action_type = any\(p_supported_action_types\)/);
  assert.match(migration, /grant execute on function public\.g3a_agent_direct_pending_v1[\s\S]*to authenticated/);
  assert.match(migration, /revoke all on function byeollog_automation\.agent_direct_runtime_context_v1[\s\S]*authenticated/);
  assert.match(migration, /byeollog_signature_assets_member_read_v1/);
  assert.doesNotMatch(migration, /for (insert|update|delete)/i);

  assert.match(edge, /operation === "claim"/);
  assert.match(edge, /rpc\/g3a_claim_execution_v1/);
  assert.match(edge, /if \(operation === "heartbeat"\)[\s\S]*rpc\/g3a_finish_execution_v1/);
  assert.match(edge, /rpc\/g3a_finish_execution_v1/);
  assert.match(edge, /operation === "device_status"[\s\S]*normalizeCollectionHealth/);
});

test("existing authenticated pending probes keep compatible Agents live without extra requests", async () => {
  const migration = await readFile(
    auditURL("supabase/migrations/20260902095644_keep_agent_online_from_existing_pending_probe.sql", root),
    "utf8"
  );

  assert.match(migration, /create or replace function public\.g3a_agent_direct_pending_v1/i);
  assert.match(migration, /agent_direct_runtime_context_v1\([\s\S]*p_device_secret_hash/);
  assert.match(migration, /update byeollog_automation\.agent_device_status[\s\S]*set reported_at = v_now/i);
  assert.match(migration, /reported_at < v_now - interval '1 minute'/i);
  assert.match(migration, /supported_action_types @> p_supported_action_types/);
  assert.match(migration, /p_supported_action_types @> status_row\.supported_action_types/);
  assert.match(migration, /revoke all on function public\.g3a_agent_direct_pending_v1[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant execute on function public\.g3a_agent_direct_pending_v1[\s\S]*to authenticated/i);
});
