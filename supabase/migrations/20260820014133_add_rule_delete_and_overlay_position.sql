-- Additive v0.7.0.17 automation contract.
-- Existing v4 callers and existing rules remain unchanged. New Agent clients use
-- v5 to append normalized 0..10000 overlay center coordinates to action params.

create or replace function byeollog_automation.save_guided_rule_v5_impl(
  p_workspace_id uuid,
  p_name text,
  p_enabled boolean,
  p_priority integer,
  p_source text,
  p_event_type text,
  p_subtype text,
  p_result text,
  p_min_amount bigint,
  p_action_type text,
  p_event_name text,
  p_output_types text[],
  p_quantity integer,
  p_duration_seconds integer,
  p_agent_device_id uuid,
  p_overlay_asset_id uuid,
  p_overlay_position_x integer,
  p_overlay_position_y integer,
  p_replace_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid, rule_version integer, created_enabled boolean)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $function$
declare
  v_uid uuid;
  v_rule_id uuid;
  v_rule_version integer;
  v_created_enabled boolean;
begin
  v_uid := byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();

  if (p_overlay_position_x is null) <> (p_overlay_position_y is null)
     or p_overlay_position_x is not null
        and (p_overlay_asset_id is null
             or p_overlay_position_x not between 0 and 10000
             or p_overlay_position_y not between 0 and 10000)
  then
    raise exception 'overlay position is invalid' using errcode='22023';
  end if;

  select saved.rule_id, saved.rule_version, saved.created_enabled
    into strict v_rule_id, v_rule_version, v_created_enabled
  from byeollog_automation.save_guided_rule_compat_v1(
    p_workspace_id,
    p_name,
    p_enabled,
    p_priority,
    p_source,
    p_event_type,
    p_subtype,
    p_result,
    p_min_amount,
    p_action_type,
    p_event_name,
    p_output_types,
    p_quantity,
    p_duration_seconds,
    p_agent_device_id,
    p_overlay_asset_id,
    p_replace_rule_id,
    p_expected_version
  ) saved;

  if p_overlay_position_x is not null then
    update public.rule_actions
       set params = params || jsonb_build_object(
         'overlayPositionX', p_overlay_position_x,
         'overlayPositionY', p_overlay_position_y
       )
     where rule_id = v_rule_id
       and overlay_asset_id = p_overlay_asset_id
       and action_type = p_action_type;

    if not found then
      raise exception 'saved overlay action was not found' using errcode='P0002';
    end if;

    update byeollog_automation.rule_actions
       set params = params || jsonb_build_object(
         'overlayPositionX', p_overlay_position_x,
         'overlayPositionY', p_overlay_position_y
       )
     where rule_id = v_rule_id
       and action_type = p_action_type;

    if not found then
      raise exception 'saved automation mirror action was not found' using errcode='P0002';
    end if;
  end if;

  return query select v_rule_id, v_rule_version, v_created_enabled;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v5_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,uuid,integer
) from public, anon;
grant execute on function byeollog_automation.save_guided_rule_v5_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,uuid,integer
) to authenticated;

create or replace function public.save_guided_rule_v5(
  p_workspace_id uuid,
  p_name text,
  p_enabled boolean,
  p_priority integer,
  p_source text,
  p_event_type text,
  p_subtype text,
  p_result text,
  p_min_amount bigint,
  p_action_type text,
  p_event_name text,
  p_output_types text[],
  p_quantity integer,
  p_duration_seconds integer,
  p_agent_device_id uuid,
  p_overlay_asset_id uuid,
  p_overlay_position_x integer,
  p_overlay_position_y integer,
  p_replace_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid, rule_version integer, created_enabled boolean)
language sql
set search_path = ''
as $function$
  select *
  from byeollog_automation.save_guided_rule_v5_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,
    p_result,p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,
    p_duration_seconds,p_agent_device_id,p_overlay_asset_id,
    p_overlay_position_x,p_overlay_position_y,p_replace_rule_id,p_expected_version
  )
$function$;

revoke all on function public.save_guided_rule_v5(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,uuid,integer
) from public, anon;
grant execute on function public.save_guided_rule_v5(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,uuid,integer,integer,uuid,integer
) to authenticated;

create or replace function byeollog_automation.delete_guided_rule_v1_impl(
  p_workspace_id uuid,
  p_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid, deleted_version integer)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $function$
declare
  v_uid uuid;
  v_version integer;
begin
  v_uid := byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();

  if p_rule_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'rule delete parameters are invalid' using errcode='22023';
  end if;

  select r.version_number
    into v_version
  from public.rules r
  where r.id = p_rule_id
    and r.workspace_id = p_workspace_id
    and r.superseded_at is null
    and r.version_number = p_expected_version
  for update;

  if not found then
    raise exception 'rule version changed' using errcode='40001';
  end if;

  delete from public.rules
  where id = p_rule_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception 'rule was not deleted' using errcode='P0002';
  end if;

  delete from byeollog_automation.rules
  where id = p_rule_id
    and workspace_id = p_workspace_id;

  if not found then
    raise exception 'automation mirror rule was not deleted' using errcode='P0002';
  end if;

  return query select p_rule_id, v_version;
end;
$function$;

revoke all on function byeollog_automation.delete_guided_rule_v1_impl(uuid,uuid,integer)
  from public, anon;
grant execute on function byeollog_automation.delete_guided_rule_v1_impl(uuid,uuid,integer)
  to authenticated;

create or replace function public.delete_guided_rule_v1(
  p_workspace_id uuid,
  p_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid, deleted_version integer)
language sql
set search_path = ''
as $function$
  select *
  from byeollog_automation.delete_guided_rule_v1_impl(
    p_workspace_id,p_rule_id,p_expected_version
  )
$function$;

revoke all on function public.delete_guided_rule_v1(uuid,uuid,integer)
  from public, anon;
grant execute on function public.delete_guided_rule_v1(uuid,uuid,integer)
  to authenticated;

do $verification$
declare
  v_save_definition text;
  v_delete_definition text;
begin
  select pg_get_functiondef('public.save_guided_rule_v5(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,integer,integer,uuid,integer)'::regprocedure)
    into strict v_save_definition;
  select pg_get_functiondef('public.delete_guided_rule_v1(uuid,uuid,integer)'::regprocedure)
    into strict v_delete_definition;

  if strpos(v_save_definition, 'save_guided_rule_v5_impl') = 0
     or strpos(v_delete_definition, 'delete_guided_rule_v1_impl') = 0
  then
    raise exception 'v0.7.0.17 automation RPC verification failed';
  end if;
end
$verification$;


