\set ON_ERROR_STOP on

create role anon;
create role authenticated;
create role service_role;
create schema extensions;
create schema byeollog_automation;
create extension pgcrypto with schema extensions;

create table public.byeollog_workspaces(
  id uuid primary key,
  display_name text not null,
  slug text not null,
  status text not null
);

create table byeollog_automation.events(
  id uuid primary key,
  workspace_id uuid not null
);

create table byeollog_automation.agent_devices(
  workspace_id uuid not null,
  device_id uuid not null,
  device_name text not null,
  registered_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  primary key(workspace_id,device_id)
);

create or replace function byeollog_automation.assert_runtime_locked_v1(
  uuid,uuid,uuid,text,text,text)
returns void language sql set search_path='' as $$select$$;

create or replace function byeollog_automation.assert_agent_device_locked_v1(
  uuid,uuid,text)
returns void language sql set search_path='' as $$select$$;

create or replace function public.get_agent_rollout_dashboard_v1(
  uuid,boolean,integer)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'release',jsonb_build_object('version','0.7.0.71'),
    'devices','[]'::jsonb,'recentExecutions','[]'::jsonb)
$$;

\ir ../supabase/migrations/20260825100000_add_collection_health_and_event_decisions.sql

insert into public.byeollog_workspaces(id,display_name,slug,status)
values('10000000-0000-4000-8000-000000000001','테스트','test','active');
insert into byeollog_automation.agent_devices(workspace_id,device_id,device_name)
values('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','테스트 PC');
insert into byeollog_automation.events(id,workspace_id)
values('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');

set role service_role;
select public.g3a_report_collection_health_v1(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001','hash','active',
  clock_timestamp()-interval '10 minutes',clock_timestamp(),clock_timestamp(),
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','agent_runtime','agent-revision','db-revision');
select public.g3a_record_event_decision_v1(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001','late_event_suppressed',
  'event_age_exceeds_live_action_window',clock_timestamp()-interval '5 minutes',
  clock_timestamp(),array['obs.mute_for'],
  array['60000000-0000-4000-8000-000000000001'::uuid],
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','event_runtime','event-revision','db-revision');
select public.g3a_record_event_decision_v1(
  '10000000-0000-4000-8000-000000000001',
  '30000000-0000-4000-8000-000000000001','late_event_suppressed',
  'event_age_exceeds_live_action_window',clock_timestamp()-interval '5 minutes',
  clock_timestamp(),array['obs.mute_for'],
  array['60000000-0000-4000-8000-000000000001'::uuid],
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','event_runtime','event-revision','db-revision');
reset role;

do $assert$
declare payload jsonb;
begin
  if (select count(*) from byeollog_automation.event_runtime_decisions)<>1 then
    raise exception 'event decision retry was not idempotent';
  end if;
  payload:=public.get_agent_rollout_dashboard_v2(
    '10000000-0000-4000-8000-000000000001',false,50);
  if payload#>>'{collectionHealth,status}'<>'collecting' then
    raise exception 'fresh active collection was not reported as collecting';
  end if;
  if jsonb_array_length(payload->'recentSafetyDecisions')<>1 then
    raise exception 'late-event decision was not returned';
  end if;
  if has_function_privilege('authenticated','public.g3a_record_event_decision_v1(uuid,uuid,text,text,timestamptz,timestamptz,text[],uuid[],uuid,uuid,text,text,text)','EXECUTE')
     or has_function_privilege('authenticated','public.g3a_report_collection_health_v1(uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,text,text,text)','EXECUTE') then
    raise exception 'internal write RPC is client executable';
  end if;
end;
$assert$;

set role service_role;
select public.g3a_report_collection_health_v1(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001','hash','active',
  clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '3 minutes',
  clock_timestamp()-interval '3 minutes',
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','agent_runtime','agent-revision','db-revision');
reset role;

do $assert$
declare payload jsonb;
begin
  payload:=public.get_agent_rollout_dashboard_v2(
    '10000000-0000-4000-8000-000000000001',false,50);
  if payload#>>'{collectionHealth,status}'<>'stalled' then
    raise exception 'stale active collection was not reported as stalled';
  end if;
end;
$assert$;

set role service_role;
select public.g3a_report_collection_health_v1(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000001','hash','idle',null,null,null,
  '40000000-0000-4000-8000-000000000001',
  '50000000-0000-4000-8000-000000000001','agent_runtime','agent-revision','db-revision');
reset role;

do $assert$
declare payload jsonb;
begin
  payload:=public.get_agent_rollout_dashboard_v2(
    '10000000-0000-4000-8000-000000000001',false,50);
  if payload#>>'{collectionHealth,status}'<>'idle' then
    raise exception 'non-collecting Agent was not reported as idle';
  end if;
end;
$assert$;

select 'COLLECTION_HEALTH_MIGRATION_PASS';
