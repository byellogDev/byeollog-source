-- Full-screen flashbang overlay action. The visual asset is packaged in the
-- Windows Agent; the database stores only a bounded intensity and volume.

create or replace function byeollog_automation.save_guided_rule_v12_impl(
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
  p_replace_rule_id uuid,p_expected_version integer)
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
  v_asset_key text;
  v_params jsonb;
  v_now timestamptz:=clock_timestamp();
begin
  if p_action_type<>'flashbang.overlay' then
    if p_flashbang_intensity is not null or p_flashbang_volume_percent is not null then
      raise exception 'flashbang fields belong to flashbang actions only' using errcode='22023';
    end if;
    return query select saved.rule_id,saved.rule_version,saved.created_enabled
    from byeollog_automation.save_guided_rule_v11_impl(
      p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
      p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
      p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
      p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
      p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
      p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_ticket_volume_percent,
      p_raffle_draw_position_x,p_raffle_draw_position_y,p_raffle_draw_scale_percent,
      p_raffle_draw_volume_percent,p_replace_rule_id,p_expected_version) saved;
    return;
  end if;

  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_event_type<>'roulette' or p_result is null or char_length(btrim(p_result)) not between 1 and 500
     or p_min_amount is not null or p_event_name is not null or p_output_types is not null
     or p_quantity is not null or p_duration_seconds is not null
     or p_agent_device_id is null or p_overlay_image_key is not null
     or p_overlay_position_x is not null or p_overlay_position_y is not null
     or p_overlay_scale_percent is not null or p_reward_multiplier is not null
     or p_allow_multiplier_stacking is not null or p_raffle_ticket_unit is not null
     or p_raffle_allow_multiples is not null or p_raffle_ticket_position_x is not null
     or p_raffle_ticket_position_y is not null or p_raffle_ticket_scale_percent is not null
     or p_raffle_ticket_volume_percent is not null or p_raffle_draw_position_x is not null
     or p_raffle_draw_position_y is not null or p_raffle_draw_scale_percent is not null
     or p_raffle_draw_volume_percent is not null
     or p_flashbang_intensity not in ('soft','standard','strong')
     or p_flashbang_volume_percent not between 0 and 100
  then
    raise exception 'flashbang action parameters are invalid' using errcode='22023';
  end if;
  if not exists(
    select 1 from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s
      on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=p_agent_device_id
      and d.revoked_at is null and s.reported_at>v_now-interval '2 minutes'
      and 'flashbang.overlay'=any(s.supported_action_types)
  ) then
    raise exception 'flashbang agent device is not currently online' using errcode='PT409';
  end if;

  -- Reuse the proven guided-rule versioning/condition writer, then replace the
  -- temporary local action inside this same transaction.
  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_v11_impl(
    p_workspace_id=>p_workspace_id,p_name=>p_name,p_enabled=>p_enabled,
    p_priority=>p_priority,p_source=>p_source,p_event_type=>'roulette',
    p_subtype=>p_subtype,p_result=>p_result,p_min_amount=>null,
    p_action_type=>'obs.mute_for',p_event_name=>null,p_output_types=>null,
    p_quantity=>null,p_duration_seconds=>3,p_agent_device_id=>p_agent_device_id,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_replace_rule_id=>p_replace_rule_id,
    p_expected_version=>p_expected_version) saved;

  v_asset_key:=case p_flashbang_intensity
    when 'soft' then 'flashbang_soft'
    when 'strong' then 'flashbang_strong'
    else 'flashbang_standard'
  end;
  v_params:=jsonb_build_object(
    'label','섬광탄!','controlType','flashbang','intensity',p_flashbang_intensity,
    'overlayImageKey',v_asset_key,'durationMs',3000,
    'volumePercent',p_flashbang_volume_percent);
  update public.rule_actions as public_action
     set action_type='flashbang.overlay',params=v_params,execution_target='local_agent',
         agent_device_id=p_agent_device_id,overlay_asset_id=null,overlay_duration_ms=3000
   where public_action.rule_id=v_rule_id and public_action.position=0;
  update byeollog_automation.rule_actions as private_action
     set action_type='flashbang.overlay',params=v_params,execution_target='local_agent',
         agent_device_id=p_agent_device_id,timeout_ms=150000,max_attempts=3,retry_backoff_seconds=5
   where private_action.rule_id=v_rule_id and private_action.position=0;
  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

create or replace function public.save_guided_rule_v12(
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
  p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql security definer set search_path=''
as $function$
  select * from byeollog_automation.save_guided_rule_v12_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
    p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_ticket_volume_percent,
    p_raffle_draw_position_x,p_raffle_draw_position_y,p_raffle_draw_scale_percent,
    p_raffle_draw_volume_percent,p_flashbang_intensity,p_flashbang_volume_percent,
    p_replace_rule_id,p_expected_version)
$function$;

create or replace function byeollog_automation.dispatch_guided_rule_test_v3_impl(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid)
language plpgsql security definer set search_path='' set statement_timeout='10s'
as $function$
declare
  v_requester_id uuid;
  v_action byeollog_automation.rule_actions%rowtype;
  v_device_id uuid;
  v_event_id uuid:=extensions.gen_random_uuid();
  v_execution_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_plan_token text;
  v_idempotency_key text;
begin
  v_requester_id:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog-action-test:'||p_workspace_id::text||':'||p_rule_id::text,3320));
  if not exists(select 1 from public.rules r where r.id=p_rule_id and r.workspace_id=p_workspace_id
    and r.superseded_at is null and r.version_number=p_expected_version) then
    raise exception 'action test rule version changed or was not found' using errcode='40001';
  end if;
  select a.* into strict v_action from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id=a.rule_id
  where r.workspace_id=p_workspace_id and r.id=p_rule_id and a.position=0;
  if v_action.action_type<>'flashbang.overlay' then
    return query select * from byeollog_automation.dispatch_guided_rule_test_v2_impl(
      p_workspace_id,p_rule_id,p_expected_version);
    return;
  end if;
  begin
    v_device_id:=v_action.agent_device_id;
    if v_action.params->>'intensity' not in ('soft','standard','strong')
       or v_action.params->>'overlayImageKey' not in ('flashbang_soft','flashbang_standard','flashbang_strong')
       or (v_action.params->>'durationMs')::integer<>3000
       or (v_action.params->>'volumePercent')::integer not between 0 and 100
    then raise exception 'flashbang test parameters are invalid' using errcode='22023'; end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'flashbang test parameters are invalid' using errcode='22023';
  end;
  if v_device_id is null or not exists(
    select 1 from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=v_device_id and d.revoked_at is null
      and s.reported_at>v_now-interval '2 minutes' and 'flashbang.overlay'=any(s.supported_action_types)
  ) then raise exception 'flashbang agent device is not currently online' using errcode='PT409'; end if;
  if exists(select 1 from byeollog_automation.executions x join byeollog_automation.events e on e.id=x.event_id
    where x.workspace_id=p_workspace_id and x.rule_id=p_rule_id and e.source='manual_test'
      and x.status in ('queued','running','retry_scheduled') and x.created_at>=v_now-interval '30 seconds')
  then raise exception 'an action test is already pending' using errcode='55000'; end if;
  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to(
    'flashbang-action-test-v1|'||p_workspace_id::text||'|'||p_rule_id::text||'|'||v_event_id::text,'UTF8'),'sha256'),'hex');
  v_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to(
    'flashbang-action-test-execution-v1|'||p_workspace_id::text||'|'||v_execution_id::text,'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.events(
    id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
    actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,
    authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(v_event_id,p_workspace_id,'1.0','flashbang-action-test-'||v_event_id::text,
    'manual_test','byeollog','action_test','flashbang.overlay',
    jsonb_build_object('display_name','별록 섬광탄 테스트'),null,null,
    jsonb_build_object('test',true,'rule_id',p_rule_id,'requested_at',v_now),null,
    'flashbang-action-test:'||v_event_id::text,v_now,v_now,v_requester_id,v_plan_token,
    array[p_rule_id],array[p_rule_id]);
  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_execution_id,p_workspace_id,v_event_id,p_rule_id,v_action.id,v_idempotency_key,
    'local_agent',v_device_id,'flashbang.overlay',v_action.params,150000,1,5);
  return query select v_event_id,v_execution_id,'flashbang.overlay'::text,v_device_id;
exception when no_data_found or too_many_rows then
  raise exception 'action test rule snapshot is invalid' using errcode='P0002';
end;
$function$;

create or replace function public.dispatch_guided_rule_test_v3(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid)
language sql security definer set search_path=''
as $function$
  select * from byeollog_automation.dispatch_guided_rule_test_v3_impl(
    p_workspace_id,p_rule_id,p_expected_version)
$function$;

-- Include flashbang in the same two-minute late-action safety contract.
create or replace function byeollog_automation.stamp_live_action_deadline_v1()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare v_occurred_at timestamptz;
begin
  if new.execution_target<>'local_agent' or new.action_type<>all(array[
    'obs.mute_for','windows.mic_mute_for','obs.scene_switch','agent.notify',
    'raffle.overlay','flashbang.overlay']::text[]) then return new; end if;
  select event_row.occurred_at into v_occurred_at from byeollog_automation.events event_row
  where event_row.id=new.event_id and event_row.workspace_id=new.workspace_id;
  if not found then raise exception 'live action event was not found' using errcode='23503'; end if;
  new.action_params=coalesce(new.action_params,'{}'::jsonb)||jsonb_build_object(
    'notAfterUtc',least(v_occurred_at,clock_timestamp())+interval '2 minutes');
  return new;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v12_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.save_guided_rule_v12(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.save_guided_rule_v12(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer) to authenticated;
revoke all on function byeollog_automation.dispatch_guided_rule_test_v3_impl(uuid,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.dispatch_guided_rule_test_v3(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.dispatch_guided_rule_test_v3(uuid,uuid,integer) to authenticated;
revoke all on function byeollog_automation.stamp_live_action_deadline_v1() from public,anon,authenticated,service_role;

;
