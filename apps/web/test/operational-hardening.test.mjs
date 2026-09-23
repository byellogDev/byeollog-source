import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const migration=new URL('../supabase/migrations/20260901220924_harden_operational_reliability_without_hot_path_changes.sql',import.meta.url);

test('operational hardening stays off the donation and execution hot paths',async()=>{
  const sql=await readFile(migration,'utf8');
  assert.match(sql,/create or replace function private\.expire_stale_native_overlay_v1/i);
  assert.match(sql,/for update skip locked/i);
  assert.match(sql,/set lock_timeout='100ms'/i);
  assert.match(sql,/set statement_timeout='1000ms'/i);
  assert.match(sql,/status in \('pending','processing'\)[\s\S]*expires_at < clock_timestamp\(\)/i);
  assert.match(sql,/create or replace view private\.soop_event_observation_daily_live_v1/i);
  assert.match(sql,/from private\.soop_event_observation_daily_v1/i);
  assert.match(sql,/from public\.byeollog_soop_event_observations/i);
  assert.match(sql,/save_guided_rule_v15[\s\S]*dispatch_guided_rule_test_v5/i);
  assert.doesNotMatch(sql,/create or replace function public\.ingest_native_overlay_soop_donation/i);
  assert.doesNotMatch(sql,/create or replace function byeollog_automation\.claim/i);
});

test('every application foreign key reported by the advisor gets a leading index',async()=>{
  const [first,second]=await Promise.all([
    readFile(migration,'utf8'),
    readFile(new URL('../supabase/migrations/20260901221106_cover_remaining_application_foreign_keys.sql',import.meta.url),'utf8')
  ]);
  const sql=first+'\n'+second;
  for(const pattern of [
    /native_roulette_chat_buffer_v2\(consumed_event_id,workspace_id\)/i,
    /native_roulette_overlay_outbox_v2\(event_id,workspace_id\)/i,
    /native_roulette_revisions\(overlay_asset_key\)/i,
    /byeollog_soop_connections\(connected_by_user_id\)/i,
    /byeollog_soop_runtime_controls\(overlay_experiment_draft_id\)/i,
    /native_roulette_chat_followups\(donation_id,workspace_id\)/i,
    /native_roulette_chat_waits_v2\(event_id,workspace_id\)/i,
    /native_roulette_dispatch_outbox\(donation_id,workspace_id\)/i,
    /native_roulette_overlay_outbox_v2\(spin_id,workspace_id\)/i,
    /native_roulette_spins\(donation_id,workspace_id\)/i,
    /native_roulette_spins_v2\(event_id,workspace_id\)/i,
    /byeollog_native_roulette_services\(workspace_id,active_draft_id\)/i
  ])assert.match(sql,pattern);
});
