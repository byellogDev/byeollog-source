import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = path => readFile(new URL(path, root), "utf8");

test("voice preset migration adds a version-isolated low/high contract", async () => {
  const migration = await text(
    "supabase/migrations/20260825134122_add_voice_anonymizer_pitch_presets.sql"
  );
  assert.match(migration, /create or replace function public\.save_guided_rule_v15/);
  assert.match(migration, /create or replace function public\.dispatch_guided_rule_test_v5/);
  assert.match(migration, /p_action_type<>'obs\.voice_anonymize_for_v2'/);
  assert.match(migration, /p_voice_preset not in \('anonymous_low','anonymous_high'\)/);
  assert.match(migration, /'obs\.voice_anonymize_for_v2'=any\(status_row\.supported_action_types\)/);
  assert.match(migration, /save_guided_rule_v14_impl/);
  assert.match(migration, /dispatch_guided_rule_test_v4_impl/);
  assert.match(migration, /grant execute on function public\.save_guided_rule_v15[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.dispatch_guided_rule_test_v5[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon)/);
  assert.match(migration, /rule_actions_target_safe[\s\S]*'obs\.voice_anonymize_for_v2'/);
  assert.match(migration, /stamp_live_action_deadline_v1[\s\S]*'obs\.voice_anonymize_for_v2'/);
});

test("every G3A boundary admits both legacy voice rules and preset-aware rules", async () => {
  const [status, agent, event, dashboard] = await Promise.all([
    text("supabase/functions/_shared/agent-device-status.ts"),
    text("supabase/functions/agent-runtime/index.ts"),
    text("supabase/functions/event-runtime/index.ts"),
    text("lib/agent-rollout-html.js")
  ]);
  for (const source of [status, agent, event]) {
    assert.match(source, /"obs\.voice_anonymize_for"/);
    assert.match(source, /"obs\.voice_anonymize_for_v2"/);
  }
  assert.match(dashboard, /'obs\.voice_anonymize_for':'\(신원보호모드\/개발중\)'/);
  assert.match(dashboard, /'obs\.voice_anonymize_for_v2':'\(신원보호모드\/개발중\) 업톤·다운톤'/);
});
