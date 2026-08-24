import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('raffle delivery failures abort the event transaction and upstream identity is session independent',async()=>{
  const sql=await source('../supabase/migrations/20260823225424_harden_raffle_delivery.sql');
  const start=sql.indexOf('create or replace function byeollog_automation.capture_raffle_ticket_grant_v1');
  const end=sql.indexOf('revoke all on function byeollog_automation.capture_raffle_ticket_grant_v1',start);
  const body=sql.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(sql,/add column if not exists source_upstream_key text/);
  assert.match(sql,/row_number\(\) over\([\s\S]*partition by workspace_id,source_upstream_key[\s\S]*duplicate_rank>1/);
  assert.match(sql,/source_upstream_key='legacy-duplicate:'\|\|grant_row\.id::text/);
  assert.match(sql,/create unique index raffle_ticket_grants_workspace_upstream_uidx[\s\S]*\(workspace_id,source_upstream_key\)/);
  assert.match(body,/r\.workspace_id=new\.workspace_id[\s\S]*r\.enabled/);
  assert.match(body,/'weflab:'\|\|btrim\(new\.payload->>'sourceUid'\)/);
  assert.match(body,/regexp_replace\([\s\S]*'\[\[:cntrl:\]\]\+'/);
  assert.match(body,/on conflict\(workspace_id,source_upstream_key\) do nothing/);
  assert.match(body,/if v_calculated_tickets > 100000 then\s*return new/);
  assert.match(body,/v_existing_actor_tickets\+v_tickets>100000/);
  assert.match(body,/v_existing_round_tickets\+v_tickets>1000000/);
  assert.match(body,/v_existing_actor_tickets=0 and v_existing_participants>=100000/);
  const duplicateCheck=body.indexOf('source_upstream_key=v_source_upstream_key');
  const roundInsert=body.indexOf('insert into byeollog_automation.raffle_rounds(');
  assert.ok(duplicateCheck>=0&&roundInsert>duplicateCheck);
  assert.match(body,/'raffle-grant-v3\|'\|\|new\.workspace_id::text\|\|'\|'\|\|v_source_upstream_key/);
  assert.doesNotMatch(body,/exception\s+when\s+others[\s\S]*return\s+new/i);
});

test('stale events preserve only the raffle ledger and never queue a stale overlay',async()=>{
  const [sql,runtime]=await Promise.all([
    source('../supabase/migrations/20260823225424_harden_raffle_delivery.sql'),
    source('../supabase/functions/event-runtime/index.ts')
  ]);
  const ledgerReturn=sql.indexOf('if v_ledger_only then return new; end if;');
  const executionInsert=sql.indexOf('insert into byeollog_automation.executions(',ledgerReturn);
  assert.ok(ledgerReturn>=0&&executionInsert>ledgerReturn);
  assert.match(runtime,/MAX_LIVE_ACTION_AGE_MS = 2 \* 60 \* 1000/);
  assert.match(runtime,/nowMs - occurredAtMs > MAX_LIVE_ACTION_AGE_MS/);
  assert.match(runtime,/rule\.actions\.length !== 1/);
  assert.match(runtime,/action\.execution_target === "server"[\s\S]*action\.action_type === "log"[\s\S]*raffle_ticket_grant/);
  assert.match(sql,/v_ledger_only boolean := clock_timestamp\(\)-new\.occurred_at > interval '2 minutes'/);
  assert.doesNotMatch(runtime,/deliveryMode: "raffle_ledger_only"/);
  assert.match(runtime,/payload: event\.payload/);
  assert.match(runtime,/ledgerOnlyReplay \? allMatched\.filter\(isRaffleLedgerRule\) : allMatched/);
  assert.match(sql,/create trigger stamp_live_action_deadline_v1[\s\S]*before insert on byeollog_automation\.executions/);
  assert.match(sql,/'notAfterUtc',least\(v_occurred_at,clock_timestamp\(\)\)\+interval '2 minutes'/);
});

test('legacy all-at-once raffle draw cannot bypass the manual sealed draw flow',async()=>{
  const sql=await source('../supabase/migrations/20260823225424_harden_raffle_delivery.sql');
  assert.match(sql,/revoke all on function public\.draw_raffle_v1\(uuid,integer,boolean\)[\s\S]*from public,anon,authenticated,service_role/);
  assert.doesNotMatch(sql,/grant execute on function public\.draw_raffle_v1/);
});

test('manual raffle v2 pins round, draw and Agent snapshots and expires old local work',async()=>{
  const sql=await source('../supabase/migrations/20260824103000_harden_manual_raffle_draw_request.sql');
  assert.match(sql,/create or replace function public\.start_raffle_draw_v2\(\s*p_workspace_id uuid,\s*p_expected_round_id uuid/);
  assert.match(sql,/where workspace_id=p_workspace_id[\s\S]*and id=p_expected_round_id[\s\S]*and status='open'[\s\S]*for update/);
  assert.match(sql,/set status='sealed'[\s\S]*sealed_at=v_now/);
  assert.match(sql,/v_total not between 1 and 1000000[\s\S]*v_participants not between 1 and 100000[\s\S]*raffle pool exceeds the safe limit/);
  assert.match(sql,/total_tickets_snapshot=v_total::integer[\s\S]*participant_count_snapshot=v_participants::integer/);
  assert.match(sql,/create or replace function public\.draw_next_raffle_winner_v2\(\s*p_workspace_id uuid,\s*p_draw_id uuid,\s*p_expected_draw_index integer,\s*p_expected_agent_device_id uuid/);
  assert.match(sql,/if v_round\.agent_device_id<>p_expected_agent_device_id[\s\S]*errcode='40001'/);
  assert.match(sql,/where round_id=v_round\.id and id=p_draw_id[\s\S]*for update/);
  assert.match(sql,/'agentDeviceId',v_round\.agent_device_id/);
  assert.match(sql,/revoke execute on function public\.start_raffle_draw_v1\(uuid,integer,boolean\)[\s\S]*from authenticated/);
  assert.match(sql,/revoke execute on function public\.draw_next_raffle_winner_v1\(uuid,integer\)[\s\S]*from authenticated/);
  assert.match(sql,/execution_row\.status in \('queued','running','retry_scheduled'\)/);
  assert.doesNotMatch(sql,/delete\s+from|truncate|drop\s+(?:table|schema)/i);
});

test('sealed raffle timestamp is added by a non-destructive recovery migration, not predeclared by the harness',async()=>{
  const [baseMigration,recoveryMigration,harness]=await Promise.all([
    source('../supabase/migrations/20260823103000_add_raffle_action.sql'),
    source('../supabase/migrations/20260824160000_add_missing_raffle_sealed_at.sql'),
    source('./raffle-migration-behavior-harness.sql')
  ]);
  const baseTableStart=baseMigration.indexOf('create table byeollog_automation.raffle_rounds');
  const baseTableEnd=baseMigration.indexOf(');',baseTableStart);
  const harnessTableStart=harness.indexOf('create table byeollog_automation.raffle_rounds');
  const harnessTableEnd=harness.indexOf(');',harnessTableStart);
  assert.ok(baseTableStart>=0&&baseTableEnd>baseTableStart);
  assert.ok(harnessTableStart>=0&&harnessTableEnd>harnessTableStart);
  assert.doesNotMatch(baseMigration.slice(baseTableStart,baseTableEnd),/\bsealed_at\b/);
  assert.doesNotMatch(harness.slice(harnessTableStart,harnessTableEnd),/\bsealed_at\b/);
  assert.match(recoveryMigration,/alter table byeollog_automation\.raffle_rounds\s+add column if not exists sealed_at timestamptz/i);
  assert.doesNotMatch(recoveryMigration,/delete\s+from|truncate|drop\s+(?:table|schema|column)/i);
  assert.ok(
    harness.indexOf('20260824160000_add_missing_raffle_sealed_at.sql')
      > harness.indexOf('20260824103000_harden_manual_raffle_draw_request.sql'),
    'the harness must reproduce the missing production column before applying its recovery migration'
  );
});
