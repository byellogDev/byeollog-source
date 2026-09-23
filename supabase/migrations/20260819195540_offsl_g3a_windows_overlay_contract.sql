begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

alter table byeollog_automation.rule_actions
  drop constraint rule_actions_target_safe;
alter table byeollog_automation.rule_actions
  add constraint rule_actions_target_safe check (
    (execution_target = 'server' and action_type = 'log' and agent_device_id is null)
    or (
      execution_target = 'local_agent'
      and action_type in ('obs.mute_for','windows.mic_mute_for','obs.scene_switch','agent.notify')
      and (
        not (params ? 'overlayAssetKey')
        or (action_type = 'obs.mute_for' and params->>'overlayAssetKey' = 'mic_off')
      )
    )
  );

create or replace function byeollog_automation.save_guided_rule_compat_v1(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,
  p_source text,p_event_type text,p_subtype text,p_result text,p_min_amount bigint,
  p_action_type text,p_event_name text,p_output_types text[],p_quantity integer,
  p_duration_seconds integer,p_agent_device_id uuid,p_overlay_asset_id uuid,
  p_replace_rule_id uuid,p_expected_version integer
)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_uid uuid;
  v_rule_id uuid;
  v_series_id uuid;
  v_version integer;
  v_condition_id uuid;
  v_action_id uuid := extensions.gen_random_uuid();
  v_position integer := 0;
  v_params jsonb;
begin
  v_uid := byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
     or p_priority not between -10000 and 10000
     or p_source not in ('weflab','byeollog')
     or p_event_type not in ('roulette','donation')
     or p_action_type not in ('obs.mute_for','windows.mic_mute_for')
     or p_duration_seconds not between 1 and 240
     or p_agent_device_id is null
     or (p_action_type = 'windows.mic_mute_for' and p_overlay_asset_id is not null) then
    raise exception 'timed-mute rule parameters are invalid' using errcode='22023';
  end if;
  if p_event_type='roulette' and (p_result is null or char_length(p_result) not between 1 and 500) then
    raise exception 'roulette result is required' using errcode='22023';
  end if;
  if p_min_amount is not null and p_min_amount < 1 then
    raise exception 'minimum amount is invalid' using errcode='22023';
  end if;
  if not exists (
    select 1 from byeollog_automation.agent_devices d
    where d.workspace_id=p_workspace_id and d.device_id=p_agent_device_id
      and d.created_by_user_id=v_uid and d.revoked_at is null
  ) then
    raise exception 'active canary agent device is required' using errcode='P0002';
  end if;
  if p_overlay_asset_id is not null then
    if not exists (
      select 1
      from public.overlay_assets a
      where a.id=p_overlay_asset_id
        and a.retired_at is null
        and a.asset_key='microphone_off'
        and a.version_number=1
        and a.delivery_mode='builtin'
        and a.mime_type='image/svg+xml'
        and a.content_sha256='e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b'
        and a.byte_size=1926 and a.width_px=1200 and a.height_px=360
    ) or not exists (
      select 1 from public.overlay_asset_durations d
      where d.overlay_asset_id=p_overlay_asset_id
        and d.duration_ms=p_duration_seconds*1000
    ) then
      raise exception 'approved built-in overlay revision is required' using errcode='22023';
    end if;
  end if;

  if p_replace_rule_id is null then
    if p_expected_version is not null then raise exception 'orphan expected version' using errcode='22023'; end if;
    v_rule_id := extensions.gen_random_uuid();
    v_series_id := v_rule_id;
    v_version := 1;
    insert into public.rules(id,workspace_id,name,enabled,priority,match_mode,created_by_user_id,version_series_id,version_number)
    values(v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid,v_series_id,v_version);
    insert into byeollog_automation.rules(id,workspace_id,name,enabled,priority,match_mode,created_by_user_id)
    values(v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid);
  else
    select r.version_series_id,r.version_number+1 into v_series_id,v_version
    from public.rules r
    where r.id=p_replace_rule_id and r.workspace_id=p_workspace_id and r.superseded_at is null
      and r.version_number=p_expected_version
    for update;
    if not found then raise exception 'rule version changed' using errcode='40001'; end if;
    v_rule_id := p_replace_rule_id;
    delete from public.rule_conditions where rule_id=v_rule_id;
    delete from public.rule_actions where rule_id=v_rule_id;
    delete from byeollog_automation.rule_conditions where rule_id=v_rule_id;
    delete from byeollog_automation.rule_actions where rule_id=v_rule_id;
    update public.rules set name=btrim(p_name),enabled=p_enabled,priority=p_priority,
      version_number=v_version,updated_at=clock_timestamp() where id=v_rule_id;
    update byeollog_automation.rules set name=btrim(p_name),enabled=p_enabled,priority=p_priority,
      updated_at=clock_timestamp() where id=v_rule_id;
  end if;

  v_condition_id := extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'source','eq',to_jsonb(p_source));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'source','eq',to_jsonb(p_source));
  v_position := v_position + 1;
  v_condition_id := extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'type','eq',to_jsonb(p_event_type));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'type','eq',to_jsonb(p_event_type));
  if p_subtype is not null then
    v_position := v_position + 1; v_condition_id := extensions.gen_random_uuid();
    insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'subtype','eq',to_jsonb(p_subtype));
    insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'subtype','eq',to_jsonb(p_subtype));
  end if;
  if p_event_type='roulette' then
    v_position := v_position + 1; v_condition_id := extensions.gen_random_uuid();
    insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'payload.result','eq',to_jsonb(p_result));
    insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'payload.result','eq',to_jsonb(p_result));
  end if;
  if p_min_amount is not null then
    v_position := v_position + 1; v_condition_id := extensions.gen_random_uuid();
    insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'amount','gte',to_jsonb(p_min_amount));
    insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'amount','gte',to_jsonb(p_min_amount));
  end if;

  v_params := jsonb_build_object(
    'target',case when p_action_type='obs.mute_for' then 'microphone' else 'selected_capture_device' end,
    'durationMs',p_duration_seconds*1000
  );
  if p_overlay_asset_id is not null then
    v_params := v_params || jsonb_build_object('overlayAssetKey','mic_off');
  end if;
  insert into public.rule_actions(id,rule_id,position,action_type,params,execution_target,agent_device_id,overlay_asset_id,overlay_duration_ms)
  values(v_action_id,v_rule_id,0,p_action_type,v_params,'local_agent',p_agent_device_id,
    p_overlay_asset_id,case when p_overlay_asset_id is null then null else p_duration_seconds*1000 end);
  insert into byeollog_automation.rule_actions(id,rule_id,position,execution_target,agent_device_id,action_type,params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_action_id,v_rule_id,0,'local_agent',p_agent_device_id,p_action_type,v_params,least(120000,p_duration_seconds*1000+30000),3,15);
  return query select v_rule_id,v_version,p_enabled;
end;
$$;

create or replace function public.g3a_authenticate_agent_device_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_now timestamptz := clock_timestamp();
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,
    p_runtime_component,p_runtime_revision,p_db_revision
  );
  if p_runtime_component <> 'agent_runtime' then
    raise exception 'agent runtime component is required' using errcode='22023';
  end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_device_id,p_device_secret_hash
  );
  return v_now;
end;
$$;

revoke execute on function public.g3a_authenticate_agent_device_v1(
  uuid,uuid,text,uuid,uuid,text,text,text
) from public,anon,authenticated;
grant execute on function public.g3a_authenticate_agent_device_v1(
  uuid,uuid,text,uuid,uuid,text,text,text
) to service_role;

comment on function public.g3a_authenticate_agent_device_v1(uuid,uuid,text,uuid,uuid,text,text,text)
  is 'G3A service-only non-mutating Agent authentication for exact built-in overlay manifest delivery.';

commit;

