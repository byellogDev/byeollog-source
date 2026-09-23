import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=path=>readFile(auditURL(path,import.meta.url),'utf8');

test('raffle winner reannounce copies one immutable winner presentation without mutating its ledger',async()=>{
  const sql=await source('../supabase/migrations/20260823230740_add_raffle_winner_reannounce.sql');
  const start=sql.indexOf('create or replace function public.reannounce_raffle_winner_v1');
  const end=sql.indexOf('$function$;',start);
  const body=sql.slice(start,end);

  assert.ok(start>=0&&end>start);
  assert.match(body,/p_workspace_id uuid,[\s\S]*p_draw_id uuid,[\s\S]*p_draw_index integer,[\s\S]*p_expected_reannounce_number integer/);
  assert.match(body,/v_uid:=byeollog_automation\.assert_canary_manager_v1\(p_workspace_id\)/);
  assert.match(body,/pg_advisory_xact_lock[\s\S]*'byeollog-raffle:'\|\|p_workspace_id::text/);
  assert.match(body,/join byeollog_automation\.raffle_rounds r[\s\S]*r\.workspace_id=d\.workspace_id/);
  assert.match(body,/where d\.workspace_id=p_workspace_id[\s\S]*d\.id=p_draw_id[\s\S]*w\.draw_index=p_draw_index/);
  assert.match(body,/'raffle-draw-step-execution-v1\|'\|\|p_workspace_id::text/);
  assert.match(body,/execution_row\.idempotency_key=v_original_idempotency_key/);
  assert.match(body,/event_row\.id=execution_row\.event_id[\s\S]*event_row\.subtype='winner_selection'[\s\S]*event_row\.payload->>'drawId'=p_draw_id::text/);
  assert.doesNotMatch(body,/execution_row\.action_params->>'drawId'/);
  assert.match(body,/v_original_execution\.action_params,v_original_execution\.timeout_ms/);
  assert.match(body,/'executionId',v_execution_id,[\s\S]*'agentDeviceId',v_original_execution\.agent_device_id/);
  assert.match(body,/insert into byeollog_automation\.events/);
  assert.match(body,/insert into byeollog_automation\.executions/);
  assert.doesNotMatch(body,/(?:insert\s+into|update|delete\s+from)\s+byeollog_automation\.raffle_(?:rounds|entries|ticket_grants|draws|draw_candidates|winners)/i);
});

test('raffle winner reannounce is bounded and retry-idempotent by expected sequence number',async()=>{
  const sql=await source('../supabase/migrations/20260823230740_add_raffle_winner_reannounce.sql');
  assert.match(sql,/p_expected_reannounce_number not between 1 and 10/);
  assert.match(sql,/'raffle-winner-reannounce-v1\|'\|\|p_workspace_id::text/);
  assert.match(sql,/execution_row\.idempotency_key=v_reannounce_idempotency_key[\s\S]*'created',false/);
  assert.match(sql,/max\(case[\s\S]*'\^\(\?:\[1-9\]\|10\)\$'[\s\S]*\(event_row\.payload->>'reannounceNumber'\)::integer/);
  assert.match(sql,/v_previous_reannounce_number>=10/);
  assert.match(sql,/p_expected_reannounce_number<>v_previous_reannounce_number\+1/);
  assert.match(sql,/using errcode='40001'/);
  assert.match(sql,/'created',true/);
});

test('raffle winner reannounce is authenticated-only and does not restore legacy draw exposure',async()=>{
  const sql=await source('../supabase/migrations/20260823230740_add_raffle_winner_reannounce.sql');
  assert.match(sql,/security definer[\s\S]*set search_path=''[\s\S]*set statement_timeout='10s'/);
  assert.match(sql,/revoke all on function public\.reannounce_raffle_winner_v1\(uuid,uuid,integer,integer\)[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.reannounce_raffle_winner_v1\(uuid,uuid,integer,integer\)[\s\S]*to authenticated/);
  assert.doesNotMatch(sql,/grant execute[\s\S]+to (?:public|anon|service_role)/);
  assert.doesNotMatch(sql,/grant execute on function public\.draw_raffle_v1/i);
});

test('raffle state exposes only bounded reannounce counts and keeps event lookup indexed',async()=>{
  const sql=await source('../supabase/migrations/20260823230740_add_raffle_winner_reannounce.sql');
  const stateStart=sql.indexOf('create or replace function public.get_raffle_state_v2');
  const stateEnd=sql.indexOf('$function$;',stateStart);
  const stateBody=sql.slice(stateStart,stateEnd);
  assert.ok(stateStart>=0&&stateEnd>stateStart);
  assert.match(sql,/create index if not exists events_raffle_reannounce_lookup_idx[\s\S]*workspace_id,\(payload->>'drawId'\),\(payload->>'drawIndex'\)[\s\S]*subtype='winner_reannounce'/);
  assert.match(stateBody,/'reannounceCount',[\s\S]*select count\(\*\)[\s\S]*event_row\.workspace_id=p_workspace_id[\s\S]*event_row\.subtype='winner_reannounce'/);
  assert.match(stateBody,/'agentDeviceId',r\.agent_device_id/);
  assert.match(stateBody,/event_row\.payload->>'drawId'=d\.id::text[\s\S]*event_row\.payload->>'drawIndex'=w\.draw_index::text/);
  assert.doesNotMatch(stateBody,/event_row\.payload[^\n]*jsonb_agg|select\s+event_row\.payload/i);
  assert.match(sql,/revoke all on function public\.get_raffle_state_v2\(uuid\)[\s\S]*from public,anon,authenticated,service_role[\s\S]*grant execute on function public\.get_raffle_state_v2\(uuid\) to authenticated/);
});
