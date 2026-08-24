-- Preserve the canonical rule name in public.rules while giving every archived
-- private mirror row an internal-only unique name. The private mirror still has
-- the legacy UNIQUE(workspace_id, name) constraint, so a same-name replacement
-- otherwise fails before the new raffle placement can be stored.
create or replace function byeollog_automation.save_guided_rule_v10_impl(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_raffle_allow_multiples boolean,
  p_raffle_ticket_position_x integer,p_raffle_ticket_position_y integer,
  p_raffle_ticket_scale_percent integer,p_raffle_draw_position_x integer,
  p_raffle_draw_position_y integer,p_raffle_draw_scale_percent integer,
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
  v_amount_operator text;
  v_params jsonb;
begin
  if p_action_type <> 'raffle.ticket_grant' then
    if p_raffle_allow_multiples is not null
       or p_raffle_ticket_position_x is not null or p_raffle_ticket_position_y is not null
       or p_raffle_ticket_scale_percent is not null or p_raffle_draw_position_x is not null
       or p_raffle_draw_position_y is not null or p_raffle_draw_scale_percent is not null
    then
      raise exception 'raffle fields belong to raffle actions only' using errcode='22023';
    end if;
    return query select saved.rule_id,saved.rule_version,saved.created_enabled
    from byeollog_automation.save_guided_rule_v9_impl(
      p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
      p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
      p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
      p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
      p_raffle_ticket_unit,p_replace_rule_id,p_expected_version) saved;
    return;
  end if;

  if p_raffle_allow_multiples is null
     or p_raffle_ticket_position_x not between 0 and 10000
     or p_raffle_ticket_position_y not between 0 and 10000
     or p_raffle_ticket_scale_percent not between 25 and 200
     or p_raffle_draw_position_x not between 0 and 10000
     or p_raffle_draw_position_y not between 0 and 10000
     or p_raffle_draw_scale_percent not between 25 and 200
  then
    raise exception 'raffle display parameters are invalid' using errcode='22023';
  end if;

  if p_replace_rule_id is not null then
    update byeollog_automation.rules private_rule
       set name=left(canonical_rule.name,72)
                ||' · 이력 · '
                ||replace(canonical_rule.id::text,'-',''),
           updated_at=clock_timestamp()
      from public.rules replacement_rule,
           public.rules canonical_rule
     where replacement_rule.id=p_replace_rule_id
       and replacement_rule.workspace_id=p_workspace_id
       and replacement_rule.superseded_at is null
       and replacement_rule.version_number=p_expected_version
       and canonical_rule.workspace_id=replacement_rule.workspace_id
       and canonical_rule.version_series_id=replacement_rule.version_series_id
       and private_rule.workspace_id=canonical_rule.workspace_id
       and private_rule.id=canonical_rule.id;
  end if;

  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_v9_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_replace_rule_id,p_expected_version) saved;

  v_amount_operator := case when p_raffle_allow_multiples then 'gte' else 'eq' end;
  update public.rule_conditions
     set operator=v_amount_operator
   where rule_id=v_rule_id and path='amount';
  update byeollog_automation.rule_conditions
     set operator=v_amount_operator
   where rule_id=v_rule_id and path='amount';

  v_params := jsonb_build_object(
    'label','추첨권 지급','controlType','raffle_ticket_grant',
    'ticketUnit',p_raffle_ticket_unit,'allowMultiples',p_raffle_allow_multiples,
    'agentDeviceId',p_agent_device_id,'overlayImageKey','raffle_ticket_granted',
    'durationMs',5000,
    'ticketOverlayPositionX',p_raffle_ticket_position_x,
    'ticketOverlayPositionY',p_raffle_ticket_position_y,
    'ticketOverlayScalePercent',p_raffle_ticket_scale_percent,
    'drawOverlayPositionX',p_raffle_draw_position_x,
    'drawOverlayPositionY',p_raffle_draw_position_y,
    'drawOverlayScalePercent',p_raffle_draw_scale_percent);
  update public.rule_actions set params=v_params where rule_id=v_rule_id and position=0;
  update byeollog_automation.rule_actions set params=v_params where rule_id=v_rule_id and position=0;
  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v10_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,uuid,integer)
  from public,anon,authenticated,service_role;

comment on function byeollog_automation.save_guided_rule_v10_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,uuid,integer)
  is 'Saves guided rules v10 and archives private mirror names before same-name raffle version replacement.';
