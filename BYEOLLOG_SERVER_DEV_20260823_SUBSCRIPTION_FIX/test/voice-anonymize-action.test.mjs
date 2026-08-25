import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = path => readFile(new URL(path, root), "utf8");

test("voice anonymize migration exposes one bounded manager action without hiding it", async () => {
  const migration = await text("supabase/migrations/20260825120000_add_voice_anonymize_action.sql");
  assert.match(migration, /create or replace function public\.save_guided_rule_v14/);
  assert.match(migration, /create or replace function public\.dispatch_guided_rule_test_v4/);
  assert.match(migration, /p_duration_seconds is null or p_duration_seconds not between 3 and 60/);
  assert.match(migration, /p_voice_preset is distinct from 'anonymous_low'/);
  assert.match(migration, /'label','\(신원보호모드\/개발중\)'/);
  assert.match(migration, /'target','microphone'/);
  assert.match(migration, /'requiresObsMicInput',true/);
  assert.match(migration, /'requiresObsFilter',true/);
  assert.match(migration, /'obs\.voice_anonymize_for'=any\(status_row\.supported_action_types\)/);
  assert.match(migration, /perform byeollog_automation\.assert_canary_manager_v1\(p_workspace_id\)/);
  assert.match(migration, /grant execute on function public\.save_guided_rule_v14[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.dispatch_guided_rule_test_v4[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon)/);
  assert.match(migration, /rule_actions_target_safe[\s\S]*'obs\.voice_anonymize_for'/);
  assert.match(migration, /stamp_live_action_deadline_v1[\s\S]*'obs\.voice_anonymize_for'/);
});

test("every G3A runtime boundary admits only the packaged voice action name", async () => {
  const [status, agent, event, dashboard] = await Promise.all([
    text("supabase/functions/_shared/agent-device-status.ts"),
    text("supabase/functions/agent-runtime/index.ts"),
    text("supabase/functions/event-runtime/index.ts"),
    text("lib/agent-rollout-html.js")
  ]);
  for (const source of [status, agent, event]) {
    assert.match(source, /"obs\.voice_anonymize_for"/);
  }
  assert.match(dashboard, /'obs\.voice_anonymize_for':'\(신원보호모드\/개발중\)'/);
  assert.match(event, /MAX_LIVE_ACTION_AGE_MS/);
  assert.match(event, /isLedgerOnlyReplay/);
});
