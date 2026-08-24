import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = path => readFile(new URL(path, root), "utf8");

test("flashbang migration exposes bounded manager-only save and test RPCs", async () => {
  const migration = await text("supabase/migrations/20260824173931_add_flashbang_action.sql");
  assert.match(migration, /create or replace function public\.save_guided_rule_v12/);
  assert.match(migration, /create or replace function public\.dispatch_guided_rule_test_v3/);
  assert.match(migration, /p_flashbang_intensity not in \('soft','standard','strong'\)/);
  assert.match(migration, /p_flashbang_volume_percent not between 0 and 100/);
  assert.match(migration, /'durationMs',3000/);
  assert.match(migration, /'flashbang\.overlay'=any\(s\.supported_action_types\)/);
  assert.match(migration, /perform byeollog_automation\.assert_canary_manager_v1\(p_workspace_id\)/);
  assert.match(migration, /grant execute on function public\.save_guided_rule_v12[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.dispatch_guided_rule_test_v3[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon)/);
});

test("all live action runtimes allow flashbang without relaxing unrelated actions", async () => {
  const [status, agent, event] = await Promise.all([
    text("supabase/functions/_shared/agent-device-status.ts"),
    text("supabase/functions/agent-runtime/index.ts"),
    text("supabase/functions/event-runtime/index.ts")
  ]);
  for (const source of [status, agent, event]) assert.match(source, /"flashbang\.overlay"/);
  assert.match(event, /MAX_LIVE_ACTION_AGE_MS/);
  assert.match(event, /isLedgerOnlyReplay/);
});
