-- Add independent, bounded TTS volume settings for raffle ticket grants and
-- winner announcements. Existing raffle rules remain compatible at 80%.

create or replace function byeollog_automation.save_guided_rule_v11_impl(
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
begin
  if p_action_type='raffle.ticket_grant' then
    if p_raffle_ticket_volume_percent not between 0 and 100
       or p_raffle_draw_volume_percent not between 0 and 100
    then
      raise exception 'raffle TTS volume is invalid' using errcode='22023';
    end if;
  elsif p_raffle_ticket_volume_percent is not null
     or p_raffle_draw_volume_percent is not null
  then
    raise exception 'raffle TTS fields belong to raffle actions only' using errcode='22023';
  end if;

  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_v10_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
    p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_draw_position_x,
    p_raffle_draw_position_y,p_raffle_draw_scale_percent,p_replace_rule_id,p_expected_version) saved;

  if p_action_type='raffle.ticket_grant' then
    update public.rule_actions public_action
       set params=public_action.params||jsonb_build_object(
         'ticketTtsVolumePercent',p_raffle_ticket_volume_percent,
         'drawTtsVolumePercent',p_raffle_draw_volume_percent)
     where public_action.rule_id=v_rule_id and public_action.position=0;
    update byeollog_automation.rule_actions runtime_action
       set params=runtime_action.params||jsonb_build_object(
         'ticketTtsVolumePercent',p_raffle_ticket_volume_percent,
         'drawTtsVolumePercent',p_raffle_draw_volume_percent)
     where runtime_action.rule_id=v_rule_id and runtime_action.position=0;
  end if;

  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

create or replace function public.save_guided_rule_v11(
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
  p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql
security definer
set search_path=''
as $function$
  select * from byeollog_automation.save_guided_rule_v11_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
    p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_ticket_volume_percent,
    p_raffle_draw_position_x,p_raffle_draw_position_y,p_raffle_draw_scale_percent,
    p_raffle_draw_volume_percent,p_replace_rule_id,p_expected_version)
$function$;

revoke all on function byeollog_automation.save_guided_rule_v11_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,uuid,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.save_guided_rule_v11(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.save_guided_rule_v11(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,uuid,integer)
  to authenticated;

create or replace function byeollog_automation.apply_raffle_tts_volume_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_params jsonb;
  v_kind text;
  v_ticket_volume integer := 80;
  v_draw_volume integer := 80;
begin
  if new.action_type<>'raffle.overlay' or new.action_params is null then return new; end if;
  select action_row.params into v_params
  from byeollog_automation.rule_actions action_row
  where action_row.id=new.action_id and action_row.rule_id=new.rule_id;
  if v_params is not null then
    begin
      v_ticket_volume:=coalesce((v_params->>'ticketTtsVolumePercent')::integer,80);
      v_draw_volume:=coalesce((v_params->>'drawTtsVolumePercent')::integer,80);
    exception when invalid_text_representation or numeric_value_out_of_range then
      v_ticket_volume:=80;
      v_draw_volume:=80;
    end;
  end if;
  if v_ticket_volume not between 0 and 100 then v_ticket_volume:=80; end if;
  if v_draw_volume not between 0 and 100 then v_draw_volume:=80; end if;
  v_kind:=new.action_params->>'kind';
  if v_kind='ticket_granted' then
    new.action_params:=new.action_params||jsonb_build_object('volumePercent',v_ticket_volume);
  elsif v_kind='draw_result' then
    new.action_params:=new.action_params||jsonb_build_object('volumePercent',v_draw_volume);
  elsif v_kind='test_sequence' then
    new.action_params:=new.action_params||jsonb_build_object(
      'ticketVolumePercent',v_ticket_volume,
      'drawVolumePercent',v_draw_volume);
  end if;
  return new;
end;
$function$;

revoke all on function byeollog_automation.apply_raffle_tts_volume_v1()
  from public,anon,authenticated,service_role;

create trigger apply_raffle_tts_volume_v1
before insert on byeollog_automation.executions
for each row when (new.action_type='raffle.overlay')
execute function byeollog_automation.apply_raffle_tts_volume_v1();
