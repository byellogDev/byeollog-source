\set ON_ERROR_STOP on
create role anon; create role authenticated; create role service_role;
create schema extensions; create schema byeollog_automation;
create extension pgcrypto with schema extensions;

create table public.rules(id uuid primary key,workspace_id uuid not null,name text not null default '',enabled boolean not null default true,priority integer not null default 100,superseded_at timestamptz,version_number integer not null default 1);
create table public.rule_actions(id uuid primary key,rule_id uuid not null,position integer not null,action_type text not null,params jsonb not null,execution_target text not null,agent_device_id uuid,overlay_asset_id uuid,overlay_duration_ms integer);
create table byeollog_automation.rules(id uuid primary key,workspace_id uuid not null);
create table byeollog_automation.rule_actions(id uuid primary key,rule_id uuid not null,position integer not null,execution_target text not null,agent_device_id uuid,action_type text not null,params jsonb not null,timeout_ms integer not null,max_attempts integer not null,retry_backoff_seconds integer not null);
alter table byeollog_automation.rule_actions
  add constraint rule_actions_target_safe check (
    execution_target='server' and action_type='log' and agent_device_id is null
    or execution_target='local_agent'
       and action_type in ('obs.mute_for','windows.mic_mute_for','obs.scene_switch','agent.notify')
       and (not (params?'overlayAssetKey') or action_type='obs.mute_for' and params->>'overlayAssetKey'='mic_off')
  );
create table byeollog_automation.agent_devices(workspace_id uuid not null,device_id uuid not null,revoked_at timestamptz,primary key(workspace_id,device_id));
create table byeollog_automation.agent_device_status(workspace_id uuid not null,device_id uuid not null,reported_at timestamptz not null,supported_action_types text[] not null,primary key(workspace_id,device_id));
create table byeollog_automation.events(id uuid primary key,workspace_id uuid not null,schema_version text not null,external_event_id text not null,source text not null,platform text not null,event_type text not null,subtype text,actor jsonb,amount numeric,currency text,payload jsonb not null,raw jsonb,correlation_id text,occurred_at timestamptz not null,received_at timestamptz not null,authorized_user_id uuid,plan_token text,evaluated_rule_ids uuid[] not null,matched_rule_ids uuid[] not null);
create table byeollog_automation.executions(id uuid primary key,workspace_id uuid not null,event_id uuid not null,rule_id uuid not null,action_id uuid not null,idempotency_key text not null,execution_target text not null,agent_device_id uuid,action_type text not null,action_params jsonb not null,timeout_ms integer not null,max_attempts integer not null,retry_backoff_seconds integer not null,status text not null default 'queued',created_at timestamptz not null default clock_timestamp());

create or replace function byeollog_automation.assert_canary_manager_v1(uuid) returns uuid language sql as $$select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid$$;
create or replace function byeollog_automation.save_guided_rule_v11_impl(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,p_raffle_allow_multiples boolean,p_raffle_ticket_position_x integer,p_raffle_ticket_position_y integer,p_raffle_ticket_scale_percent integer,p_raffle_ticket_volume_percent integer,p_raffle_draw_position_x integer,p_raffle_draw_position_y integer,p_raffle_draw_scale_percent integer,p_raffle_draw_volume_percent integer,p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean) language plpgsql as $$
declare v_rule uuid:=extensions.gen_random_uuid(); v_action uuid:=extensions.gen_random_uuid();
begin
  insert into public.rules(id,workspace_id,name,enabled,priority) values(v_rule,p_workspace_id,p_name,p_enabled,p_priority);
  insert into byeollog_automation.rules values(v_rule,p_workspace_id);
  insert into public.rule_actions values(v_action,v_rule,0,p_action_type,jsonb_build_object('durationMs',p_duration_seconds*1000),'local_agent',p_agent_device_id,null,null);
  insert into byeollog_automation.rule_actions values(v_action,v_rule,0,'local_agent',p_agent_device_id,p_action_type,jsonb_build_object('durationMs',p_duration_seconds*1000),150000,3,5);
  return query select v_rule,1,p_enabled;
end$$;
create or replace function byeollog_automation.dispatch_guided_rule_test_v2_impl(uuid,uuid,integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid) language sql as $$select null::uuid,null::uuid,'legacy'::text,null::uuid$$;

\ir ../supabase/migrations/20260824173931_add_flashbang_action.sql
\ir ../supabase/migrations/20260824192432_allow_flashbang_rule_action_target.sql

-- Production already has this trigger from raffle delivery hardening. Recreate
-- that prerequisite in the focused harness so the replacement function is
-- exercised on the new flashbang execution as it is in production.
create trigger trg_stamp_live_action_deadline_v1
before insert on byeollog_automation.executions
for each row execute function byeollog_automation.stamp_live_action_deadline_v1();

do $$
declare
  v_workspace uuid:='11111111-1111-4111-8111-111111111111';
  v_device uuid:='22222222-2222-4222-8222-222222222222';
  v_saved record; v_test record; v_action jsonb;
begin
  insert into byeollog_automation.agent_devices values(v_workspace,v_device,null);
  insert into byeollog_automation.agent_device_status values(v_workspace,v_device,clock_timestamp(),array['obs.mute_for','flashbang.overlay']);
  select * into strict v_saved from public.save_guided_rule_v12(
    p_workspace_id=>v_workspace,p_name=>'섬광탄!',p_enabled=>true,p_priority=>100,
    p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,p_result=>'섬광탄',
    p_min_amount=>null,p_action_type=>'flashbang.overlay',p_event_name=>null,
    p_output_types=>null,p_quantity=>null,p_duration_seconds=>null,
    p_agent_device_id=>v_device,p_overlay_image_key=>null,p_overlay_position_x=>null,
    p_overlay_position_y=>null,p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>'strong',
    p_flashbang_volume_percent=>75,p_replace_rule_id=>null,p_expected_version=>null);
  select params into strict v_action from byeollog_automation.rule_actions where rule_id=v_saved.rule_id;
  if v_action->>'intensity'<>'strong' or v_action->>'overlayImageKey'<>'flashbang_strong'
     or v_action->>'durationMs'<>'3000' or v_action->>'volumePercent'<>'75'
     or (select action_type from public.rule_actions where rule_id=v_saved.rule_id)<>'flashbang.overlay'
  then raise exception 'flashbang rule was not saved exactly'; end if;
  select * into strict v_test from public.dispatch_guided_rule_test_v3(v_workspace,v_saved.rule_id,1);
  if v_test.action_type<>'flashbang.overlay'
     or (select action_params->>'notAfterUtc' from byeollog_automation.executions where id=v_test.execution_id) is null
  then raise exception 'flashbang test execution/deadline was not created'; end if;
  if not pg_catalog.has_function_privilege('authenticated','public.save_guided_rule_v12(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer)','EXECUTE')
     or not pg_catalog.has_function_privilege('authenticated','public.dispatch_guided_rule_test_v3(uuid,uuid,integer)','EXECUTE')
  then raise exception 'flashbang RPC privilege boundary mismatch'; end if;
end$$;
select 'FLASHBANG_ACTION_MIGRATION_PASS' as result;
