-- Let flashbang rules use either an exact roulette result or an exact
-- donation amount. The existing v12 facade remains available for deployed
-- Agents; v13 is additive and keeps all other guided-rule behavior unchanged.

create or replace function byeollog_automation.save_guided_rule_v13_impl(
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
    return query select saved.rule_id,saved.rule_version,saved.created_enabled
    from byeollog_automation.save_guided_rule_v12_impl(
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
     or p_event_name is not null or p_output_types is not null
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

  -- Reuse the proven condition/version writer. Donation conditions are written
  -- by the existing compatibility layer with operator=eq, never gte.
  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_v12_impl(
    p_workspace_id=>p_workspace_id,p_name=>p_name,p_enabled=>p_enabled,
    p_priority=>p_priority,p_source=>p_source,p_event_type=>p_event_type,
    p_subtype=>p_subtype,p_result=>case when p_event_type='roulette' then btrim(p_result) else null end,
    p_min_amount=>case when p_event_type='donation' then p_min_amount else null end,
    p_action_type=>'obs.mute_for',p_event_name=>null,p_output_types=>null,
    p_quantity=>null,p_duration_seconds=>3,p_agent_device_id=>p_agent_device_id,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_replace_rule_id=>p_replace_rule_id,
    p_expected_version=>p_expected_version) saved;

  v_asset_key:=case p_flashbang_intensity
    when 'soft' then 'flashbang_soft'
    when 'strong' then 'flashbang_strong'
    else 'flashbang_standard'
  end;
  v_params:=jsonb_build_object(
    'label','섬광탄!','controlType','flashbang','intensity',p_flashbang_intensity,
    'overlayImageKey',v_asset_key,'durationMs',5000,
    'volumePercent',p_flashbang_volume_percent);
  update public.rule_actions as public_action
     set action_type='flashbang.overlay',params=v_params,execution_target='local_agent',
         agent_device_id=p_agent_device_id,overlay_asset_id=null,overlay_duration_ms=5000
   where public_action.rule_id=v_rule_id and public_action.position=0;
  update byeollog_automation.rule_actions as private_action
     set action_type='flashbang.overlay',params=v_params,execution_target='local_agent',
         agent_device_id=p_agent_device_id,timeout_ms=120000,max_attempts=3,retry_backoff_seconds=5
   where private_action.rule_id=v_rule_id and private_action.position=0;
  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

create or replace function public.save_guided_rule_v13(
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
language sql
security definer
set search_path=''
as $function$
  select * from byeollog_automation.save_guided_rule_v13_impl(
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

revoke all on function byeollog_automation.save_guided_rule_v13_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.save_guided_rule_v13(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.save_guided_rule_v13(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer)
  to authenticated;

comment on function public.save_guided_rule_v13(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,uuid,integer)
  is 'Saves guided rules and lets flashbang actions use either roulette-result equality or exact-donation equality.';


