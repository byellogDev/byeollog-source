-- Add the first OBS voice-anonymizer live action without changing any existing
-- guided-rule facade.  The preset is deliberately a single server-validated
-- identity: the Agent resolves its OBS microphone and the locally configured
-- `별록 신원보호모드` filter; neither name is remotely injectable.

create or replace function byeollog_automation.save_guided_rule_v14_impl(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_raffle_allow_multiples boolean,
  p_raffle_ticket_position_x integer,p_raffle_ticket_position_y integer,
  p_raffle_ticket_scale_percent integer,p_raffle_ticket_volume_percent integer,
  p_raffle_draw_position_x integer,p_raffle_draw_position_y integer,
  p_raffle_draw_scale_percent integer,p_raffle_draw_volume_percent integer,
  p_flashbang_intensity text,p_flashbang_volume_percent integer,
  p_voice_preset text,p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_rule_id uuid;
  v_rule_version integer;
  v_created_enabled boolean;
  v_params jsonb;
  v_now timestamptz:=clock_timestamp();
begin
  if p_action_type<>'obs.voice_anonymize_for' then
    if p_voice_preset is not null then
      raise exception 'voice preset belongs to voice anonymize actions only' using errcode='22023';
    end if;
    return query select saved.rule_id,saved.rule_version,saved.created_enabled
    from byeollog_automation.save_guided_rule_v13_impl(
      p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
      p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
      p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
      p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
      p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
      p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_ticket_volume_percent,
      p_raffle_draw_position_x,p_raffle_draw_position_y,p_raffle_draw_scale_percent,
      p_raffle_draw_volume_percent,p_flashbang_intensity,p_flashbang_volume_percent,
      p_replace_rule_id,p_expected_version) saved;
    return;
  end if;

  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_event_type not in ('roulette','donation')
     or (p_event_type='roulette' and (
       p_result is null or char_length(btrim(p_result)) not between 1 and 500
       or p_min_amount is not null))
     or (p_event_type='donation' and (
       p_result is not null or p_min_amount is null or p_min_amount<1))
     or p_event_name is not null or p_output_types is not null or p_quantity is not null
     or p_duration_seconds is null or p_duration_seconds not between 3 and 60
     or p_agent_device_id is null or p_overlay_image_key is not null
     or p_overlay_position_x is not null or p_overlay_position_y is not null
     or p_overlay_scale_percent is not null or p_reward_multiplier is not null
     or p_allow_multiplier_stacking is not null or p_raffle_ticket_unit is not null
     or p_raffle_allow_multiples is not null or p_raffle_ticket_position_x is not null
     or p_raffle_ticket_position_y is not null or p_raffle_ticket_scale_percent is not null
     or p_raffle_ticket_volume_percent is not null or p_raffle_draw_position_x is not null
     or p_raffle_draw_position_y is not null or p_raffle_draw_scale_percent is not null
     or p_raffle_draw_volume_percent is not null or p_flashbang_intensity is not null
     or p_flashbang_volume_percent is not null
     or p_voice_preset is distinct from 'anonymous_low'
  then
    raise exception 'voice anonymize action parameters are invalid' using errcode='22023';
  end if;
  if not exists(
    select 1
    from byeollog_automation.agent_devices device_row
    join byeollog_automation.agent_device_status status_row
      on status_row.workspace_id=device_row.workspace_id
     and status_row.device_id=device_row.device_id
    where device_row.workspace_id=p_workspace_id
      and device_row.device_id=p_agent_device_id
      and device_row.revoked_at is null
      and status_row.reported_at>v_now-interval '2 minutes'
      and 'obs.voice_anonymize_for'=any(status_row.supported_action_types)
  ) then
    raise exception 'voice anonymize agent device is not currently online' using errcode='PT409';
  end if;

  -- Reuse the established version/condition writer inside this transaction,
  -- then replace only its temporary local action with the immutable voice
  -- contract.  The Agent checks the two OBS prerequisites before side effects.
  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_v13_impl(
    p_workspace_id=>p_workspace_id,p_name=>p_name,p_enabled=>p_enabled,
    p_priority=>p_priority,p_source=>p_source,p_event_type=>p_event_type,
    p_subtype=>p_subtype,
    p_result=>case when p_event_type='roulette' then btrim(p_result) else null end,
    p_min_amount=>case when p_event_type='donation' then p_min_amount else null end,
    p_action_type=>'obs.mute_for',p_event_name=>null,p_output_types=>null,
    p_quantity=>null,p_duration_seconds=>p_duration_seconds,
    p_agent_device_id=>p_agent_device_id,p_overlay_image_key=>null,
    p_overlay_position_x=>null,p_overlay_position_y=>null,p_overlay_scale_percent=>null,
    p_reward_multiplier=>null,p_allow_multiplier_stacking=>null,
    p_raffle_ticket_unit=>null,p_raffle_allow_multiples=>null,
    p_raffle_ticket_position_x=>null,p_raffle_ticket_position_y=>null,
    p_raffle_ticket_scale_percent=>null,p_raffle_ticket_volume_percent=>null,
    p_raffle_draw_position_x=>null,p_raffle_draw_position_y=>null,
    p_raffle_draw_scale_percent=>null,p_raffle_draw_volume_percent=>null,
    p_flashbang_intensity=>null,p_flashbang_volume_percent=>null,
    p_replace_rule_id=>p_replace_rule_id,p_expected_version=>p_expected_version) saved;

  v_params:=jsonb_build_object(
    'label','(신원보호모드/개발중)',
    'controlType','voice_anonymize',
    'target','microphone',
    'durationMs',p_duration_seconds*1000,
    'preset',p_voice_preset,
    'requiresObsMicInput',true,
    'requiresObsFilter',true);
  update public.rule_actions as public_action
     set action_type='obs.voice_anonymize_for',params=v_params,
         execution_target='local_agent',agent_device_id=p_agent_device_id,
         overlay_asset_id=null,overlay_duration_ms=null
   where public_action.rule_id=v_rule_id and public_action.position=0;
  update byeollog_automation.rule_actions as private_action
     set action_type='obs.voice_anonymize_for',params=v_params,
         execution_target='local_agent',agent_device_id=p_agent_device_id,
         timeout_ms=120000,max_attempts=3,retry_backoff_seconds=5
   where private_action.rule_id=v_rule_id and private_action.position=0;
  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

create or replace function public.save_guided_rule_v14(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_raffle_allow_multiples boolean,
  p_raffle_ticket_position_x integer,p_raffle_ticket_position_y integer,
  p_raffle_ticket_scale_percent integer,p_raffle_ticket_volume_percent integer,
  p_raffle_draw_position_x integer,p_raffle_draw_position_y integer,
  p_raffle_draw_scale_percent integer,p_raffle_draw_volume_percent integer,
  p_flashbang_intensity text,p_flashbang_volume_percent integer,
  p_voice_preset text,p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
  select * from byeollog_automation.save_guided_rule_v14_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
    p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_ticket_volume_percent,
    p_raffle_draw_position_x,p_raffle_draw_position_y,p_raffle_draw_scale_percent,
    p_raffle_draw_volume_percent,p_flashbang_intensity,p_flashbang_volume_percent,
    p_voice_preset,p_replace_rule_id,p_expected_version)
$function$;

create or replace function byeollog_automation.dispatch_guided_rule_test_v4_impl(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid)
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_requester_id uuid;
  v_action byeollog_automation.rule_actions%rowtype;
  v_device_id uuid;
  v_duration_ms integer;
  v_event_id uuid:=extensions.gen_random_uuid();
  v_execution_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_plan_token text;
  v_idempotency_key text;
begin
  v_requester_id:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_rule_id is null or p_expected_version is null or p_expected_version<1 then
    raise exception 'action test identity is invalid' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog-action-test:'||p_workspace_id::text||':'||p_rule_id::text,3320));
  if not exists(
    select 1 from public.rules rule_row
    where rule_row.id=p_rule_id and rule_row.workspace_id=p_workspace_id
      and rule_row.superseded_at is null and rule_row.version_number=p_expected_version
  ) then
    raise exception 'action test rule version changed or was not found' using errcode='40001';
  end if;
  select action_row.* into strict v_action
  from byeollog_automation.rule_actions action_row
  join byeollog_automation.rules rule_row on rule_row.id=action_row.rule_id
  where rule_row.workspace_id=p_workspace_id and rule_row.id=p_rule_id
    and action_row.position=0;
  if v_action.action_type<>'obs.voice_anonymize_for' then
    return query select * from byeollog_automation.dispatch_guided_rule_test_v3_impl(
      p_workspace_id,p_rule_id,p_expected_version);
    return;
  end if;
  begin
    v_device_id:=v_action.agent_device_id;
    v_duration_ms:=(v_action.params->>'durationMs')::integer;
    if (select count(*) from pg_catalog.jsonb_object_keys(v_action.params))<>7
       or v_action.params->>'label' is distinct from '(신원보호모드/개발중)'
       or v_action.params->>'controlType' is distinct from 'voice_anonymize'
       or v_action.params->>'target' is distinct from 'microphone'
       or v_duration_ms not between 3000 and 60000
       or v_duration_ms%1000<>0
       or v_action.params->>'preset' is distinct from 'anonymous_low'
       or pg_catalog.jsonb_typeof(v_action.params->'requiresObsMicInput')<>'boolean'
       or (v_action.params->>'requiresObsMicInput')::boolean is not true
       or pg_catalog.jsonb_typeof(v_action.params->'requiresObsFilter')<>'boolean'
       or (v_action.params->>'requiresObsFilter')::boolean is not true
    then
      raise exception 'voice anonymize test parameters are invalid' using errcode='22023';
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'voice anonymize test parameters are invalid' using errcode='22023';
  end;
  if v_device_id is null or not exists(
    select 1
    from byeollog_automation.agent_devices device_row
    join byeollog_automation.agent_device_status status_row
      on status_row.workspace_id=device_row.workspace_id
     and status_row.device_id=device_row.device_id
    where device_row.workspace_id=p_workspace_id and device_row.device_id=v_device_id
      and device_row.revoked_at is null
      and status_row.reported_at>v_now-interval '2 minutes'
      and 'obs.voice_anonymize_for'=any(status_row.supported_action_types)
  ) then
    raise exception 'voice anonymize agent device is not currently online' using errcode='PT409';
  end if;
  if exists(
    select 1 from byeollog_automation.executions execution_row
    join byeollog_automation.events event_row on event_row.id=execution_row.event_id
    where execution_row.workspace_id=p_workspace_id and execution_row.rule_id=p_rule_id
      and event_row.source='manual_test'
      and execution_row.status in ('queued','running','retry_scheduled')
      and execution_row.created_at>=v_now-interval '30 seconds'
  ) then
    raise exception 'an action test is already pending' using errcode='55000';
  end if;
  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to(
    'voice-anonymize-action-test-v1|'||p_workspace_id::text||'|'||p_rule_id::text||'|'||v_event_id::text,
    'UTF8'),'sha256'),'hex');
  v_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to(
    'voice-anonymize-action-test-execution-v1|'||p_workspace_id::text||'|'||v_execution_id::text,
    'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.events(
    id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
    actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,
    authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(
    v_event_id,p_workspace_id,'1.0','voice-anonymize-action-test-'||v_event_id::text,
    'manual_test','byeollog','action_test','obs.voice_anonymize_for',
    jsonb_build_object('display_name','(신원보호모드/개발중)'),null,null,
    jsonb_build_object('test',true,'rule_id',p_rule_id,'requested_at',v_now),null,
    'voice-anonymize-action-test:'||v_event_id::text,v_now,v_now,v_requester_id,
    v_plan_token,array[p_rule_id],array[p_rule_id]);
  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(
    v_execution_id,p_workspace_id,v_event_id,p_rule_id,v_action.id,v_idempotency_key,
    'local_agent',v_device_id,'obs.voice_anonymize_for',v_action.params,120000,1,5);
  return query select v_event_id,v_execution_id,'obs.voice_anonymize_for'::text,v_device_id;
exception when no_data_found or too_many_rows then
  raise exception 'action test rule snapshot is invalid' using errcode='P0002';
end;
$function$;

create or replace function public.dispatch_guided_rule_test_v4(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid)
language sql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
  select * from byeollog_automation.dispatch_guided_rule_test_v4_impl(
    p_workspace_id,p_rule_id,p_expected_version)
$function$;

-- Keep the private action target invariant closed over only packaged actions.
alter table byeollog_automation.rule_actions
  drop constraint if exists rule_actions_target_safe;

alter table byeollog_automation.rule_actions
  add constraint rule_actions_target_safe check (
    (
      execution_target='server'
      and action_type='log'
      and agent_device_id is null
    )
    or
    (
      execution_target='local_agent'
      and action_type in (
        'obs.mute_for',
        'obs.voice_anonymize_for',
        'windows.mic_mute_for',
        'obs.scene_switch',
        'agent.notify',
        'flashbang.overlay'
      )
      and (
        not (params ? 'overlayAssetKey')
        or (
          action_type='obs.mute_for'
          and params->>'overlayAssetKey'='mic_off'
        )
      )
    )
  );

-- Treat the voice filter as a live broadcast side effect.  Queued work expires
-- after the same two-minute window as mute, raffle and flashbang actions.
create or replace function byeollog_automation.stamp_live_action_deadline_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_occurred_at timestamptz;
begin
  if new.execution_target<>'local_agent'
     or new.action_type<>all(array[
       'obs.mute_for','obs.voice_anonymize_for','windows.mic_mute_for',
       'obs.scene_switch','agent.notify','raffle.overlay','flashbang.overlay'
     ]::text[])
  then
    return new;
  end if;
  select event_row.occurred_at into v_occurred_at
  from byeollog_automation.events event_row
  where event_row.id=new.event_id and event_row.workspace_id=new.workspace_id;
  if not found then
    raise exception 'live action event was not found' using errcode='23503';
  end if;
  new.action_params=coalesce(new.action_params,'{}'::jsonb)
    ||jsonb_build_object(
      'notAfterUtc',least(v_occurred_at,clock_timestamp())+interval '2 minutes');
  return new;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v14_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,
  integer,integer,integer,integer,integer,integer,integer,integer,text,integer,
  text,uuid,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.save_guided_rule_v14(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,
  integer,integer,integer,integer,integer,integer,integer,integer,text,integer,
  text,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.save_guided_rule_v14(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,
  integer,integer,integer,integer,integer,integer,integer,integer,text,integer,
  text,uuid,integer)
  to authenticated;

revoke all on function byeollog_automation.dispatch_guided_rule_test_v4_impl(
  uuid,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.dispatch_guided_rule_test_v4(
  uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.dispatch_guided_rule_test_v4(
  uuid,uuid,integer) to authenticated;
revoke all on function byeollog_automation.stamp_live_action_deadline_v1()
  from public,anon,authenticated,service_role;

comment on function public.save_guided_rule_v14(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,
  integer,integer,integer,integer,integer,integer,integer,integer,text,integer,
  text,uuid,integer)
  is 'Saves guided rules including bounded anonymous_low OBS voice anonymization on one selected online Agent.';
comment on function public.dispatch_guided_rule_test_v4(uuid,uuid,integer)
  is 'Queues one version-bound voice anonymize test, or delegates older supported action tests to v3.';

;
