import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = auditURL("../", import.meta.url);
const text = path => readFile(auditURL(path, root), "utf8");

test("v16 save and v6 manual test RPCs are additive, bounded, and manager-only", async () => {
  const migration = await text("supabase/migrations/20260826060945_add_screen_and_effect_actions.sql");
  assert.match(migration, /create or replace function public\.save_guided_rule_v16/);
  assert.match(migration, /create or replace function public\.dispatch_guided_rule_test_v6/);
  assert.match(migration, /save_guided_rule_v15_impl/);
  assert.match(migration, /dispatch_guided_rule_test_v5_impl/);
  assert.match(migration, /p_duration_seconds is null or p_duration_seconds not between 3 and 30/);
  assert.match(migration, /p_duration_seconds is null or p_duration_seconds not between 2 and 10/);
  assert.match(migration, /p_visual_variant is null/);
  assert.match(migration, /p_visual_volume_percent is null/);
  assert.match(migration, /status_row\.reported_at>v_now-interval '2 minutes'/);
  assert.match(migration, /perform byeollog_automation\.assert_canary_manager_v1\(p_workspace_id\)/);
  assert.match(migration, /grant execute on function public\.save_guided_rule_v16[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.dispatch_guided_rule_test_v6[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon)/);
});

test("new server action params are exact and live executions expire", async () => {
  const migration = await text("supabase/migrations/20260826060945_add_screen_and_effect_actions.sql");
  for (const type of ["obs.screen_flip_for", "obs.screen_shake_for", "water_splash.overlay", "fireworks.overlay"])
    assert.match(migration, new RegExp(`'${type.replaceAll(".", "\\.")}'`));
  assert.match(migration, /'label',v_label,'controlType','screen_flip','target','program'/);
  assert.match(migration, /'axis','vertical'/);
  assert.match(migration, /'restoreMode','scene_snapshot'/);
  assert.match(migration, /'controlType','screen_shake'/);
  assert.match(migration, /'overlayImageKey','earthquake_audio'/);
  assert.match(migration, /'effect','water_splash'/);
  assert.match(migration, /'durationMs',3500/);
  assert.match(migration, /'effect','fireworks'/);
  assert.match(migration, /'durationMs',5000/);
  assert.match(migration, /'mic_off','mic_off_center','mic_off_top_left','mic_off_top_right'/);
  assert.match(migration, /least\(v_occurred_at,clock_timestamp\(\)\)\+interval '2 minutes'/);
  assert.match(migration, /v_action\.params,120000,1,5/);
});

test("all live runtimes advertise exactly the four new action types", async () => {
  const sources = await Promise.all([
    text("supabase/functions/_shared/agent-device-status.ts"),
    text("supabase/functions/agent-runtime/index.ts"),
    text("supabase/functions/event-runtime/index.ts")
  ]);
  for (const source of sources) {
    for (const type of ["obs.screen_flip_for", "obs.screen_shake_for", "water_splash.overlay", "fireworks.overlay"])
      assert.match(source, new RegExp(`"${type.replaceAll(".", "\\.")}"`));
  }
});
