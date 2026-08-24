-- Additive follow-up for v0.7.0.19.
--
-- The public compatibility projection keeps overlayAssetKey for existing rule
-- readers. The Event First runtime mirror uses overlayImageKey so the existing
-- restrictive legacy check remains intact without DROP/constraint replacement.

create or replace function byeollog_automation.save_guided_rule_v7_impl(
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
  p_overlay_image_key text,
  p_overlay_position_x integer,
  p_overlay_position_y integer,
  p_overlay_scale_percent integer,
  p_replace_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $function$
declare
  v_rule_id uuid;
  v_rule_version integer;
  v_created_enabled boolean;
  v_public_params jsonb;
  v_runtime_params jsonb;
begin
  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();

  if (p_overlay_position_x is null) <> (p_overlay_position_y is null)
     or (p_overlay_image_key is null and (
           p_overlay_position_x is not null or p_overlay_scale_percent is not null
        ))
     or (p_overlay_image_key is not null and (
           p_overlay_position_x is null
           or p_overlay_scale_percent is null
           or p_overlay_position_x not between 0 and 10000
           or p_overlay_position_y not between 0 and 10000
           or p_overlay_scale_percent not between 25 and 200
        ))
  then
    raise exception 'overlay placement is invalid' using errcode='22023';
  end if;

  if p_overlay_image_key is not null
     and p_overlay_image_key not in (
       'mic_off',
       'mic_off_center',
       'mic_off_top_left',
       'mic_off_top_right',
       'mic_off_badge',
       'mic_off_quiet',
       'mic_off_signal_panel',
       'mic_off_screenprint'
     )
  then
    raise exception 'packaged overlay image key is invalid' using errcode='22023';
  end if;

  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_compat_v1(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,
    p_result,p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,
    p_duration_seconds,p_agent_device_id,null,p_replace_rule_id,p_expected_version
  ) as saved;

  if p_overlay_image_key is not null then
    v_public_params := jsonb_build_object(
      'overlayAssetKey',p_overlay_image_key,
      'overlayPositionX',p_overlay_position_x,
      'overlayPositionY',p_overlay_position_y,
      'overlayScalePercent',p_overlay_scale_percent
    );
    v_runtime_params := jsonb_build_object(
      'overlayImageKey',p_overlay_image_key,
      'overlayPositionX',p_overlay_position_x,
      'overlayPositionY',p_overlay_position_y,
      'overlayScalePercent',p_overlay_scale_percent
    );

    update public.rule_actions as public_action
       set overlay_asset_id=null,
           overlay_duration_ms=p_duration_seconds*1000,
           params=coalesce(public_action.params,'{}'::jsonb) || v_public_params
     where public_action.rule_id=v_rule_id
       and public_action.action_type=p_action_type;
    if not found then
      raise exception 'saved overlay action was not found' using errcode='P0002';
    end if;

    update byeollog_automation.rule_actions as runtime_action
       set params=(coalesce(runtime_action.params,'{}'::jsonb) - 'overlayAssetKey') || v_runtime_params
     where runtime_action.rule_id=v_rule_id
       and runtime_action.action_type=p_action_type;
    if not found then
      raise exception 'saved automation mirror action was not found' using errcode='P0002';
    end if;
  end if;

  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v7_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,uuid,integer
) from public,anon;
grant execute on function byeollog_automation.save_guided_rule_v7_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,uuid,integer
) to authenticated;

do $migration$
begin
  if not exists (
    select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid=p.pronamespace
     where n.nspname='byeollog_automation'
       and p.proname='save_guided_rule_v7_impl'
       and position('overlayImageKey' in pg_catalog.pg_get_functiondef(p.oid))>0
       and position('params=coalesce(public_action.params' in pg_catalog.pg_get_functiondef(p.oid))>0
  ) then
    raise exception 'v0.7.0.19 mirror-key fix verification failed';
  end if;
end
$migration$;
