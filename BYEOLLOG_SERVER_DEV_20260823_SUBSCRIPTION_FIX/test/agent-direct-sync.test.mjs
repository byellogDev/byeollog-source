import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("direct Agent transport removes idle Edge invocations without moving action leases", async () => {
  const [migration, edge] = await Promise.all([
    readFile(new URL("supabase/migrations/20260901182718_agent_direct_sync_transport.sql", root), "utf8"),
    readFile(new URL("supabase/functions/agent-runtime/index.ts", root), "utf8")
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
