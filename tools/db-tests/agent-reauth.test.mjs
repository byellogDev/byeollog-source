import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

test('existing Agent reauthentication preserves enrollment and authorization boundaries',async()=>{
 const db=new PGlite();
 try {
  await db.exec(`create schema byeollog_automation; create schema auth;
    create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz,created_at timestamptz default now());
    create table public.byeollog_workspaces(id uuid primary key,display_name text,status text);
    create table public.byeollog_workspace_members(workspace_id uuid,user_id uuid,role text);
    create table byeollog_automation.release_gate(gate_id int,enabled boolean,project_ref text,db_revision text,evidence_sha256 text,event_runtime_revision text,execution_worker_revision text,agent_runtime_revision text);
    create table byeollog_automation.workspace_gates(workspace_id uuid,enabled boolean,evidence_sha256 text);
    insert into byeollog_automation.release_gate values(1,true,'offslvwaugvjotkywlus','offsl-vnext-g3a-v1','fixture','event','worker','agent');
    do $$ declare w uuid:=gen_random_uuid(); u uuid:=gen_random_uuid(); begin
      insert into public.byeollog_workspaces values(w,'테스트 스트리머','active');
      insert into public.byeollog_workspace_members values(w,u,'owner');
      insert into byeollog_automation.workspace_gates values(w,true,'fixture');
      for i in 1..10 loop insert into auth.sessions(id,user_id) values(gen_random_uuid(),u); end loop;
    end $$;`);
  const baseline=fs.readFileSync(new URL('../../supabase/migrations/20260819031553_offsl_g3a_additive_runtime.sql',import.meta.url),'utf8');
  const tableStart=baseline.indexOf('create table byeollog_automation.agent_devices (');
  await db.exec(baseline.slice(tableStart,baseline.indexOf('\n);',tableStart)+3));
  const guardStart=baseline.indexOf('create function byeollog_automation.assert_runtime_locked_v1(');
  assert.ok(guardStart>0);
  await db.exec(baseline.slice(guardStart,baseline.indexOf('\n$$;',guardStart)+4));
  await db.exec(fs.readFileSync(new URL('../../supabase/migrations/20261004103258_agent_existing_device_reauthentication.sql',import.meta.url),'utf8'));
  const result=await db.exec(fs.readFileSync(new URL('../../tests/agent-device-reauthentication.sql',import.meta.url),'utf8').replaceAll('__REGISTER_SCHEMA__','public'));
  assert.equal(Number(result.at(-1).rows[0].passed),15);
  assert.equal(result.at(-1).rows[0].all_passed,true);
 } finally { await db.close(); }
});
