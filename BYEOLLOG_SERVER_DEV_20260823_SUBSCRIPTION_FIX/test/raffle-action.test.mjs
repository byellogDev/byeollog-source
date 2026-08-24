import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('raffle migration stores an idempotent private ledger and a durable overlay execution',async()=>{
  const sql=await source('../supabase/migrations/20260823103000_add_raffle_action.sql');
  assert.match(sql,/create table byeollog_automation\.raffle_rounds/);
  assert.match(sql,/unique\(workspace_id, source_event_key, rule_id\)/);
  assert.match(sql,/floor\(v_amount::numeric\/v_ticket_unit\)::integer/);
  assert.match(sql,/on conflict\(workspace_id,source_event_key,rule_id\) do nothing/);
  assert.match(sql,/create trigger protect_raffle_rule_v1/);
  assert.match(sql,/an open raffle round must be drawn before changing its rule/);
  assert.match(sql,/only one raffle ticket rule can be active at a time/);
  assert.match(sql,/after insert on byeollog_automation\.events/);
  assert.match(sql,/exception when others then[\s\S]*return new/);
  assert.match(sql,/'raffle\.overlay'/);
  assert.match(sql,/'kind','ticket_granted'/);
  assert.match(sql,/enable row level security/g);
  assert.match(sql,/explicit_deny/g);
  assert.match(sql,/revoke all on table[\s\S]*from public, anon, authenticated, service_role/);
});

test('raffle draw is weighted, bounded, auditable, and closes exactly one round',async()=>{
  const sql=await source('../supabase/migrations/20260823103000_add_raffle_action.sql');
  assert.match(sql,/p_winner_count not between 1 and 100/);
  assert.match(sql,/p_allow_duplicate_winners and p_winner_count>v_total/);
  assert.match(sql,/not p_allow_duplicate_winners and p_winner_count>v_participants/);
  assert.match(sql,/pg_advisory_xact_lock/);
  assert.match(sql,/remaining_ticket_count=case when p_allow_duplicate_winners then remaining_ticket_count-1 else 0 end/);
  assert.ok(sql.includes("v_seed||'|'||v_index::text"));
  assert.match(sql,/status='drawn'/);
  assert.match(sql,/'kind','draw_result'/);
  assert.match(sql,/grant execute on function public\.draw_raffle_v1\(uuid,integer,boolean\) to authenticated/);
});

test('agent runtime advertises and accepts only the explicit raffle overlay capability',async()=>{
  const [shared,agent]=await Promise.all([
    source('../supabase/functions/_shared/agent-device-status.ts'),
    source('../supabase/functions/agent-runtime/index.ts')
  ]);
  assert.match(shared,/"raffle\.overlay"/);
  assert.match(agent,/"raffle\.overlay"/);
});

test('raffle refinement supports exact-only or floor-multiple grants and two independent placements',async()=>{
  const sql=await source('../supabase/migrations/20260823153158_refine_raffle_ticket_modes_and_overlay.sql');
  assert.match(sql,/create or replace function byeollog_automation\.calculate_raffle_ticket_count_v1/);
  assert.match(sql,/when p_allow_multiples then p_donation_amount \/ p_ticket_unit/);
  assert.match(sql,/when p_donation_amount = p_ticket_unit then 1::bigint/);
  assert.match(sql,/v_calculated_tickets := byeollog_automation\.calculate_raffle_ticket_count_v1/);
  assert.match(sql,/v_allow_multiples := true;[\s\S]*v_calculated_tickets := byeollog_automation\.calculate_raffle_ticket_count_v1/);
  assert.match(sql,/case when p_raffle_allow_multiples then 'gte' else 'eq' end/);
  assert.match(sql,/'allowMultiples',p_raffle_allow_multiples/);
  assert.match(sql,/'ticketOverlayPositionX',p_raffle_ticket_position_x/);
  assert.match(sql,/'drawOverlayPositionX',p_raffle_draw_position_x/);
  assert.match(sql,/create or replace function public\.save_guided_rule_v10/);
  assert.match(sql,/grant execute on function public\.save_guided_rule_v10[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/grant execute[\s\S]+to (?:public|anon|service_role)/);
});

test('raffle placement-only edits preserve public names and archive private version names',async()=>{
  const sql=await source('../supabase/migrations/20260823191145_preserve_rule_version_names.sql');
  assert.match(sql,/create or replace function byeollog_automation\.save_guided_rule_v10_impl/);
  assert.match(sql,/if p_replace_rule_id is not null then[\s\S]*update byeollog_automation\.rules private_rule/);
  assert.match(sql,/canonical_rule\.version_series_id=replacement_rule\.version_series_id/);
  assert.match(sql,/private_rule\.id=canonical_rule\.id/);
  assert.match(sql,/left\(canonical_rule\.name,72\)[\s\S]*replace\(canonical_rule\.id::text,'-',''\)/);
  assert.match(sql,/'ticketOverlayPositionX',p_raffle_ticket_position_x/);
  assert.match(sql,/'drawOverlayPositionX',p_raffle_draw_position_x/);
  assert.doesNotMatch(sql,/delete\s+from\s+(?:public|byeollog_automation)\.rules/i);
  assert.doesNotMatch(sql,/drop\s+(?:table|constraint)/i);
  assert.match(sql,/revoke all on function byeollog_automation\.save_guided_rule_v10_impl[\s\S]*from public,anon,authenticated,service_role/);
});

test('raffle rule save disambiguates every v10 rule id reference without weakening security',async()=>{
  const sql=await source('../supabase/migrations/20260824051542_fix_save_guided_rule_v10_ambiguous_rule_id.sql');
  assert.match(sql,/save_guided_rule_v10_impl\(uuid,text,boolean,integer/);
  assert.match(sql,/public_condition\.rule_id=v_rule_id/);
  assert.match(sql,/runtime_condition\.rule_id=v_rule_id/);
  assert.match(sql,/public_action\.rule_id=v_rule_id/);
  assert.match(sql,/runtime_action\.rule_id=v_rule_id/);
  assert.match(sql,/p\.proowner = v_owner/);
  assert.match(sql,/p\.proacl is not distinct from v_acl/);
  assert.match(sql,/p\.prosecdef = v_security_definer/);
  assert.match(sql,/p\.proconfig is not distinct from v_config/);
  assert.doesNotMatch(sql,/delete\s+from|drop\s+(?:table|constraint)|truncate/i);
});

test('raffle test broadcast is non-mutating and queues one ordered local-agent sequence',async()=>{
  const sql=await source('../supabase/migrations/20260823153158_refine_raffle_ticket_modes_and_overlay.sql');
  const start=sql.indexOf('create or replace function byeollog_automation.dispatch_guided_rule_test_v2_impl');
  const end=sql.indexOf('create or replace function public.dispatch_guided_rule_test_v2',start);
  const body=sql.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(body,/'kind','test_sequence'/);
  assert.match(body,/'ticketOverlayImageKey','raffle_ticket_granted'/);
  assert.match(body,/'drawOverlayImageKey','raffle_draw'/);
  assert.match(body,/'local_agent',v_device_id,'raffle\.overlay'/);
  assert.doesNotMatch(body,/insert into byeollog_automation\.raffle_(?:entries|ticket_grants|draws|winners)/);
  assert.match(sql,/grant execute on function public\.dispatch_guided_rule_test_v2\(uuid,uuid,integer\) to authenticated/);
});

test('manual raffle draw seals one immutable pool and reveals exactly one winner per request',async()=>{
  const sql=await source('../supabase/migrations/20260823171308_add_manual_raffle_draw_control.sql');
  assert.match(sql,/status in \('open','sealed','drawn'\)/);
  assert.match(sql,/create unique index raffle_rounds_one_sealed_per_workspace/);
  assert.match(sql,/create or replace function public\.get_raffle_state_v2/);
  assert.match(sql,/create or replace function public\.start_raffle_draw_v1/);
  assert.match(sql,/set status='sealed'/);
  assert.match(sql,/create or replace function public\.draw_next_raffle_winner_v1/);
  assert.match(sql,/p_expected_draw_index/);
  assert.match(sql,/if v_index<>p_expected_draw_index/);
  assert.match(sql,/insert into byeollog_automation\.raffle_winners/);
  assert.match(sql,/'winnerCount',1,'drawIndex',v_index/);
  assert.match(sql,/if v_completed then[\s\S]*set status='drawn'/);
  assert.match(sql,/where workspace_id=p_workspace_id and status='open'/);
  assert.match(sql,/where workspace_id=p_workspace_id and status='sealed'/);
  assert.match(sql,/rr\.status in \('open','sealed'\)/);
  assert.match(sql,/revoke all on function public\.start_raffle_draw_v1[\s\S]*grant execute[\s\S]*to authenticated/);
  assert.match(sql,/revoke all on function public\.draw_next_raffle_winner_v1[\s\S]*grant execute[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/grant execute[\s\S]+to (?:public|anon|service_role)/);
});

test('raffle TTS volumes are independently saved and injected into every durable execution',async()=>{
  const sql=await source('../supabase/migrations/20260824090000_add_raffle_tts_volume.sql');
  assert.match(sql,/create or replace function public\.save_guided_rule_v11/);
  assert.match(sql,/p_raffle_ticket_volume_percent not between 0 and 100/);
  assert.match(sql,/'ticketTtsVolumePercent',p_raffle_ticket_volume_percent/);
  assert.match(sql,/'drawTtsVolumePercent',p_raffle_draw_volume_percent/);
  assert.match(sql,/create or replace function byeollog_automation\.apply_raffle_tts_volume_v1/);
  assert.match(sql,/before insert on byeollog_automation\.executions/);
  assert.match(sql,/v_kind='ticket_granted'[\s\S]*'volumePercent',v_ticket_volume/);
  assert.match(sql,/v_kind='draw_result'[\s\S]*'volumePercent',v_draw_volume/);
  assert.match(sql,/v_kind='test_sequence'[\s\S]*'ticketVolumePercent',v_ticket_volume[\s\S]*'drawVolumePercent',v_draw_volume/);
  assert.match(sql,/grant execute on function public\.save_guided_rule_v11[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/grant execute[\s\S]+to (?:public|anon|service_role)/);
  assert.doesNotMatch(sql,/delete\s+from|truncate/i);
});
