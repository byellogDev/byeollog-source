import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const repo=auditURL('../',import.meta.url);
const agent=auditURL('../../BYEOLLOG_AGENT_DEV_v07022/',import.meta.url);

test('collection stop opens a service-only scheduled incident without donor content',async()=>{
  const sql=await readFile(auditURL('supabase/migrations/20260829164723_add_soop_gateway_incident_monitor.sql',repo),'utf8');
  assert.match(sql,/byeollog-soop-gateway-heartbeat-monitor-v1/);
  assert.match(sql,/select private\.check_soop_gateway_heartbeats_v1\(\)/);
  assert.match(sql,/revoke all on table public\.byeollog_soop_gateway_incidents from public,anon,authenticated,service_role/i);
  assert.doesNotMatch(sql,/actor_name|donor_name|raw_message/i);
});

test('gateway outbox pressure and dead letters emit bounded structured warnings only',async()=>{
  const source=await readFile(auditURL('services/soop-chat-gateway/index.mjs',repo),'utf8');
  assert.match(source,/log\(threshold==='critical'\?'error':'warn','outbox_pressure',\{pending,deadLetters,threshold/);
  assert.match(source,/onDeadLetter:\(error,item,state\)=>log\('error','outbox_item_dead_lettered'/);
  assert.doesNotMatch(source,/outbox_pressure',\{[^}]*body/);
  assert.doesNotMatch(source,/outbox_item_dead_lettered',\{[^}]*body/);
});

test('cross-workspace attempts are blocked and recorded in a private aggregate-safe ledger',async()=>{
  const sql=await readFile(auditURL('supabase/migrations/20260907013000_enforce_soop_workspace_ownership.sql',repo),'utf8');
  assert.match(sql,/create table if not exists private\.soop_workspace_conflicts/);
  assert.match(sql,/revoke all on table private\.soop_workspace_conflicts from public,anon,authenticated,service_role/);
  assert.match(sql,/return 'conflict'/);
  const conflictLedger=sql.slice(
    sql.indexOf('create table if not exists private.soop_workspace_conflicts'),
    sql.indexOf('alter table public.byeollog_soop_core_donations')
  );
  assert.doesNotMatch(conflictLedger,/actor_name|donor_name|raw_message/);
});

test('Agent display completion is authenticated and image failures remain code-only best effort',async()=>{
  const [service,client,localAgent]=await Promise.all([
    readFile(auditURL('ByeollogOverlayService.cs',agent),'utf8'),
    readFile(auditURL('VNextDevelopmentClient.cs',agent),'utf8'),
    readFile(auditURL('VNextLocalAgent.cs',agent),'utf8')
  ]);
  assert.match(service,/Codes only: do not put donor data, URLs or exception messages in logs/);
  assert.match(service,/fetch\('\/overlay\/wallpaper-error\?stage='/);
  assert.match(service,/_storage\.Log\("풍벽지 오버레이 표시 오류 · stage=" \+ stage\)/);
  assert.match(service,/image\.onerror = \(\) =>/);
  assert.match(client,/g3a_agent_direct_display_observation_v1/);
  assert.match(client,/p_device_secret_hash = DeviceSecretSha256/);
  assert.match(localAgent,/Best-effort telemetry must never affect|계측은 표시·ACK 경로 밖의 best-effort 작업/);
  assert.doesNotMatch(service,/풍벽지 오버레이 표시 오류[^\n]*(actor|donor|url)/i);
});
