import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const migrationUrl=auditURL('../supabase/migrations/20260901171632_bound_operational_data_retention_without_hot_path_changes.sql',import.meta.url);
const sql=(await readFile(migrationUrl,'utf8')).replace(/\s+/g,' ').toLowerCase();

test('operational retention is isolated from donation and action hot paths',()=>{
  assert.match(sql,/create or replace function private\.run_operational_retention_v1/);
  assert.match(sql,/pg_try_advisory_xact_lock/);
  assert.match(sql,/set lock_timeout='100ms'/);
  assert.match(sql,/set statement_timeout='1500ms'/);
  assert.doesNotMatch(sql,/create\s+trigger/);
  assert.doesNotMatch(sql,/delete from byeollog_automation\.events/);
  assert.doesNotMatch(sql,/delete from byeollog_automation\.executions/);
  assert.doesNotMatch(sql,/delete from public\.bangsel_donations/);
  assert.doesNotMatch(sql,/delete from public\.byeollog_wallpaper_/);
});

test('raw observations are aggregated exactly before bounded deletion',()=>{
  assert.match(sql,/create table if not exists private\.soop_event_observation_daily_v1/);
  assert.match(sql,/delete from public\.byeollog_soop_event_observations observation/);
  assert.match(sql,/insert into private\.soop_event_observation_daily_v1/);
  assert.match(sql,/on conflict \(observed_on,workspace_id,event_type,outcome\) do update/);
  assert.match(sql,/server_received_at < clock_timestamp\(\)-interval '14 days'/);
  assert.match(sql,/limit v_batch_limit for update skip locked/);
});

test('delivery retention excludes in-flight overlay commands',()=>{
  assert.match(sql,/outbox\.status in \('succeeded','failed'\)/);
  assert.match(sql,/clock_timestamp\(\)-interval '7 days'/);
  assert.doesNotMatch(sql,/outbox\.status in \('pending','processing'\).*delete/s);
});

test('execution retention preserves rows and action parameters',()=>{
  assert.match(sql,/execution\.status='succeeded'/);
  assert.match(sql,/execution\.finished_at < clock_timestamp\(\)-interval '30 days'/);
  assert.match(sql,/pg_column_size\(execution\.result\)>4096/);
  assert.doesNotMatch(sql,/set action_params/);
  assert.doesNotMatch(sql,/delete from byeollog_automation\.executions/);
});

test('maintenance entry points are internal and least-privileged',()=>{
  assert.match(sql,/alter table private\.soop_event_observation_daily_v1 enable row level security/);
  assert.match(sql,/revoke all on table private\.soop_event_observation_daily_v1 from public,anon,authenticated,service_role/);
  assert.match(sql,/revoke all on function private\.run_operational_retention_v1\(integer\) from public,anon,authenticated,service_role/);
  assert.match(sql,/byeollog-operational-retention-v1/);
});
