import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const text = path => readFile(new URL(path, root), "utf8");

test("flashbang migration exposes bounded manager-only save and test RPCs", async () => {
  const migration = await text("supabase/migrations/20260824173931_add_flashbang_action.sql");
  const targetSafetyMigration = await text("supabase/migrations/20260824192432_allow_flashbang_rule_action_target.sql");
  const timeoutRepairMigration = await text("supabase/migrations/20260824192955_fix_flashbang_timeout_contract.sql");
  const exactDonationMigration = await text("supabase/migrations/20260824202652_allow_flashbang_exact_donation.sql");
  assert.match(migration, /create or replace function public\.save_guided_rule_v12/);
  assert.match(migration, /create or replace function public\.dispatch_guided_rule_test_v3/);
  assert.match(migration, /p_flashbang_intensity not in \('soft','standard','strong'\)/);
  assert.match(migration, /p_flashbang_volume_percent not between 0 and 100/);
  assert.match(migration, /'durationMs',5000/);
  assert.match(migration, /timeout_ms=120000/);
  assert.doesNotMatch(migration, /150000/);
  assert.match(migration, /'flashbang\.overlay'=any\(s\.supported_action_types\)/);
  assert.match(migration, /perform byeollog_automation\.assert_canary_manager_v1\(p_workspace_id\)/);
  assert.match(migration, /grant execute on function public\.save_guided_rule_v12[\s\S]*to authenticated/);
  assert.match(migration, /grant execute on function public\.dispatch_guided_rule_test_v3[\s\S]*to authenticated/);
  assert.doesNotMatch(migration, /grant execute[\s\S]*to (?:public|anon)/);
  assert.match(targetSafetyMigration, /rule_actions_target_safe/);
  assert.match(targetSafetyMigration, /'flashbang\.overlay'/);
  assert.match(targetSafetyMigration, /params\s*\?\s*'overlayAssetKey'/);
  assert.match(timeoutRepairMigration, /create or replace function byeollog_automation\.save_guided_rule_v12_impl/);
  assert.match(timeoutRepairMigration, /create or replace function byeollog_automation\.dispatch_guided_rule_test_v3_impl/);
  assert.match(timeoutRepairMigration, /'durationMs',5000/);
  assert.match(timeoutRepairMigration, /timeout_ms=120000/);
  assert.match(timeoutRepairMigration, /v_action\.params,120000,1,5/);
  assert.doesNotMatch(timeoutRepairMigration, /150000/);
  assert.match(exactDonationMigration, /create or replace function public\.save_guided_rule_v13/);
  assert.match(exactDonationMigration, /p_event_type not in \('roulette','donation'\)/);
  assert.match(exactDonationMigration, /p_event_type='donation'[\s\S]*p_result is not null or p_min_amount is null or p_min_amount<1/);
  assert.match(exactDonationMigration, /p_event_type=>p_event_type/);
  assert.match(exactDonationMigration, /p_min_amount=>case when p_event_type='donation' then p_min_amount else null end/);
  assert.match(exactDonationMigration, /grant execute on function public\.save_guided_rule_v13[\s\S]*to authenticated/);
  assert.doesNotMatch(exactDonationMigration, /grant execute[\s\S]*to (?:public|anon)/);
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
