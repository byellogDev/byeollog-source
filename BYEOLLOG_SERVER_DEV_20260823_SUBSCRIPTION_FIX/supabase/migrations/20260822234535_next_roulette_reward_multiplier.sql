-- 다음 룰렛 보상 증가: 후원자별 1회성 배수 상태와 규칙 저장 계약.
-- 기존 데이터/규칙을 변경하지 않는 additive migration이다.

create table if not exists byeollog_automation.roulette_reward_multiplier_state (
  workspace_id uuid not null,
  actor_key text not null,
  multiplier integer check (multiplier is null or multiplier between 2 and 100),
  source_event_key text not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, actor_key),
  check (char_length(actor_key) between 1 and 180),
  check (char_length(source_event_key) between 1 and 200)
);

create table if not exists byeollog_automation.roulette_reward_multiplier_receipts (
  workspace_id uuid not null,
  source_event_key text not null,
  actor_key text,
  result_text text not null,
  control_event boolean not null,
  configured_multiplier integer,
  allow_stacking boolean,
  applied_multiplier integer not null check (applied_multiplier between 1 and 100),
  pending_multiplier integer,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, source_event_key),
  check (char_length(source_event_key) between 1 and 200),
  check (actor_key is null or char_length(actor_key) between 1 and 180),
  check (char_length(result_text) between 1 and 500),
  check (configured_multiplier is null or configured_multiplier between 2 and 100),
  check (pending_multiplier is null or pending_multiplier between 2 and 100)
);

revoke all on table byeollog_automation.roulette_reward_multiplier_state from public, anon, authenticated, service_role;
revoke all on table byeollog_automation.roulette_reward_multiplier_receipts from public, anon, authenticated, service_role;

create or replace function byeollog_automation.resolve_roulette_reward_multiplier_v1(
  p_workspace_id uuid,
  p_source_event_key text,
  p_actor_id text,
  p_result text,
  p_configured_multiplier integer,
  p_allow_stacking boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_now timestamptz := clock_timestamp();
  v_actor_key text := lower(nullif(btrim(coalesce(p_actor_id, '')), ''));
  v_result text := btrim(coalesce(p_result, ''));
  v_control boolean := p_configured_multiplier is not null;
  v_existing byeollog_automation.roulette_reward_multiplier_receipts%rowtype;
  v_pending byeollog_automation.roulette_reward_multiplier_state%rowtype;
  v_applied integer := 1;
  v_pending_after integer;
  v_stacked boolean := false;
begin
  if p_workspace_id is null
     or p_source_event_key is null
     or char_length(p_source_event_key) not between 1 and 200
     or btrim(p_source_event_key) = ''
     or char_length(v_result) not between 1 and 500
     or (v_actor_key is not null and char_length(v_actor_key) not between 1 and 180)
     or (p_configured_multiplier is not null and p_configured_multiplier not between 2 and 100)
     or (p_configured_multiplier is null and p_allow_stacking is not null)
  then
    raise exception 'roulette reward multiplier parameters are invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'roulette-reward-multiplier:' || p_workspace_id::text || ':' || coalesce(v_actor_key, p_source_event_key),
      4101
    )
  );

  select r.* into v_existing
  from byeollog_automation.roulette_reward_multiplier_receipts r
  where r.workspace_id = p_workspace_id
    and r.source_event_key = p_source_event_key;

  if found then
    if v_existing.actor_key is distinct from v_actor_key
       or v_existing.result_text is distinct from v_result then
      raise exception 'roulette reward multiplier event identity conflict' using errcode = 'BLM01';
    end if;
    return jsonb_build_object(
      'appliedMultiplier', v_existing.applied_multiplier,
      'pendingMultiplier', v_existing.pending_multiplier,
      'controlEvent', v_existing.control_event,
      'stacked', false,
      'duplicate', true
    );
  end if;

  -- 후원자 ID가 없는 결과에는 다른 시청자의 상태를 잘못 적용하지 않는다.
  if v_actor_key is null then
    insert into byeollog_automation.roulette_reward_multiplier_receipts(
      workspace_id, source_event_key, actor_key, result_text, control_event,
      configured_multiplier, allow_stacking, applied_multiplier, pending_multiplier
    ) values (
      p_workspace_id, p_source_event_key, null, v_result, v_control,
      p_configured_multiplier, p_allow_stacking, 1, null
    );
    return jsonb_build_object(
      'appliedMultiplier', 1,
      'pendingMultiplier', null,
      'controlEvent', v_control,
      'stacked', false,
      'duplicate', false
    );
  end if;

  select s.* into v_pending
  from byeollog_automation.roulette_reward_multiplier_state s
  where s.workspace_id = p_workspace_id
    and s.actor_key = v_actor_key
  for update;

  if found and (v_pending.expires_at <= v_now or v_pending.multiplier is null) then
    update byeollog_automation.roulette_reward_multiplier_state s
       set multiplier = null,
           expires_at = v_now,
           updated_at = v_now
     where s.workspace_id = p_workspace_id
       and s.actor_key = v_actor_key;
    v_pending.workspace_id := null;
    v_pending.multiplier := null;
  end if;

  if v_control then
    if v_pending.workspace_id is not null and coalesce(p_allow_stacking, false) then
      v_pending_after := least(100, v_pending.multiplier * p_configured_multiplier);
      v_stacked := true;
    else
      v_pending_after := p_configured_multiplier;
    end if;

    insert into byeollog_automation.roulette_reward_multiplier_state(
      workspace_id, actor_key, multiplier, source_event_key, expires_at, updated_at
    ) values (
      p_workspace_id, v_actor_key, v_pending_after, p_source_event_key,
      v_now + interval '12 hours', v_now
    )
    on conflict (workspace_id, actor_key) do update
      set multiplier = excluded.multiplier,
          source_event_key = excluded.source_event_key,
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at;
  else
    if v_pending.workspace_id is not null then
      v_applied := v_pending.multiplier;
      update byeollog_automation.roulette_reward_multiplier_state s
         set multiplier = null,
             expires_at = v_now,
             updated_at = v_now
       where s.workspace_id = p_workspace_id
         and s.actor_key = v_actor_key;
    end if;
    v_pending_after := null;
  end if;

  insert into byeollog_automation.roulette_reward_multiplier_receipts(
    workspace_id, source_event_key, actor_key, result_text, control_event,
    configured_multiplier, allow_stacking, applied_multiplier, pending_multiplier
  ) values (
    p_workspace_id, p_source_event_key, v_actor_key, v_result, v_control,
    p_configured_multiplier, p_allow_stacking, v_applied, v_pending_after
  );

  return jsonb_build_object(
    'appliedMultiplier', v_applied,
    'pendingMultiplier', v_pending_after,
    'controlEvent', v_control,
    'stacked', v_stacked,
    'duplicate', false
  );
end;
$function$;

revoke all on function byeollog_automation.resolve_roulette_reward_multiplier_v1(
  uuid,text,text,text,integer,boolean
) from public, anon, authenticated, service_role;

create or replace function public.resolve_roulette_reward_multiplier_v1(
  p_workspace_id uuid,
  p_source_event_key text,
  p_actor_id text,
  p_result text,
  p_configured_multiplier integer,
  p_allow_stacking boolean
)
returns jsonb
language sql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
  select byeollog_automation.resolve_roulette_reward_multiplier_v1(
    p_workspace_id, p_source_event_key, p_actor_id, p_result,
    p_configured_multiplier, p_allow_stacking
  )
$function$;

revoke all on function public.resolve_roulette_reward_multiplier_v1(
  uuid,text,text,text,integer,boolean
) from public, anon, authenticated;
grant execute on function public.resolve_roulette_reward_multiplier_v1(
  uuid,text,text,text,integer,boolean
) to service_role;

create or replace function byeollog_automation.capture_roulette_reward_multiplier_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_control_params jsonb;
  v_multiplier integer;
  v_allow_stacking boolean;
begin
  if new.event_type <> 'roulette' then return new; end if;

  select a.params
    into v_control_params
  from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id = a.rule_id
  where a.rule_id = any(coalesce(new.matched_rule_ids, '{}'::uuid[]))
    and a.action_type = 'log'
    and a.params ->> 'controlType' = 'next_roulette_reward_multiplier'
  order by r.priority desc, r.id, a.position, a.id
  limit 1;

  if found then
    begin
      v_multiplier := (v_control_params ->> 'multiplier')::integer;
      v_allow_stacking := coalesce((v_control_params ->> 'allowStacking')::boolean, false);
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'stored roulette reward multiplier rule is invalid' using errcode = '22023';
    end;
  end if;

  perform byeollog_automation.resolve_roulette_reward_multiplier_v1(
    new.workspace_id,
    new.external_event_id,
    new.actor ->> 'id',
    new.payload ->> 'result',
    v_multiplier,
    case when v_multiplier is null then null else v_allow_stacking end
  );
  return new;
end;
$function$;

revoke all on function byeollog_automation.capture_roulette_reward_multiplier_v1() from public, anon, authenticated, service_role;

create trigger capture_roulette_reward_multiplier_v1
after insert on byeollog_automation.events
for each row execute function byeollog_automation.capture_roulette_reward_multiplier_v1();

create or replace function byeollog_automation.apply_roulette_reward_multiplier_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_multiplier integer;
  v_duration integer;
  v_quantity integer;
begin
  select r.applied_multiplier into v_multiplier
  from byeollog_automation.events e
  join byeollog_automation.roulette_reward_multiplier_receipts r
    on r.workspace_id = e.workspace_id
   and r.source_event_key = e.external_event_id
  where e.id = new.event_id;

  if coalesce(v_multiplier, 1) <= 1 then return new; end if;

  if new.action_type in ('obs.mute_for', 'windows.mic_mute_for') then
    begin
      v_duration := (new.action_params ->> 'durationMs')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'timed mute duration is invalid' using errcode = '22023';
    end;
    new.action_params := jsonb_set(
      new.action_params,
      '{durationMs}',
      to_jsonb(least(900000, v_duration * v_multiplier)),
      false
    );
  elsif new.action_type = 'upbo.apply' then
    begin
      v_quantity := (new.action_params ->> 'quantity')::integer;
    exception when invalid_text_representation or numeric_value_out_of_range then
      raise exception 'upbo quantity is invalid' using errcode = '22023';
    end;
    new.action_params := jsonb_set(
      new.action_params,
      '{quantity}',
      to_jsonb(least(200, v_quantity * v_multiplier)),
      false
    );
  end if;
  return new;
end;
$function$;

revoke all on function byeollog_automation.apply_roulette_reward_multiplier_v1() from public, anon, authenticated, service_role;

create trigger apply_roulette_reward_multiplier_v1
before insert on byeollog_automation.executions
for each row execute function byeollog_automation.apply_roulette_reward_multiplier_v1();

create or replace function byeollog_automation.save_guided_rule_v8_impl(
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
  p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,
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
  v_uid uuid;
  v_rule_id uuid;
  v_series_id uuid;
  v_version integer;
  v_condition_id uuid;
  v_action_id uuid := extensions.gen_random_uuid();
  v_position integer := 0;
  v_params jsonb;
begin
  if p_action_type <> 'roulette.reward_multiplier_next' then
    if p_reward_multiplier is not null or coalesce(p_allow_multiplier_stacking, false) then
      raise exception 'reward multiplier fields belong to multiplier actions only' using errcode = '22023';
    end if;
    return query
    select saved.rule_id, saved.rule_version, saved.created_enabled
    from byeollog_automation.save_guided_rule_v7_impl(
      p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,
      p_result,p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,
      p_duration_seconds,p_agent_device_id,p_overlay_image_key,p_overlay_position_x,
      p_overlay_position_y,p_overlay_scale_percent,p_replace_rule_id,p_expected_version
    ) as saved;
    return;
  end if;

  v_uid := byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();

  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
     or p_priority not between -10000 and 10000
     or p_source not in ('weflab','byeollog')
     or p_event_type <> 'roulette'
     or p_result is null or char_length(btrim(p_result)) not between 1 and 500
     or p_reward_multiplier is null
     or p_reward_multiplier not between 2 and 100
     or p_allow_multiplier_stacking is null
     or p_min_amount is not null
     or p_event_name is not null
     or p_output_types is not null
     or p_quantity is not null
     or p_duration_seconds is not null
     or p_agent_device_id is not null
     or p_overlay_image_key is not null
     or p_overlay_position_x is not null
     or p_overlay_position_y is not null
     or p_overlay_scale_percent is not null
  then
    raise exception 'next roulette reward multiplier parameters are invalid' using errcode = '22023';
  end if;

  if p_replace_rule_id is null then
    if p_expected_version is not null then
      raise exception 'orphan expected version' using errcode = '22023';
    end if;
    v_rule_id := extensions.gen_random_uuid();
    v_series_id := v_rule_id;
    v_version := 1;
    insert into public.rules(
      id,workspace_id,name,enabled,priority,match_mode,created_by_user_id,
      version_series_id,version_number
    ) values (
      v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid,
      v_series_id,v_version
    );
    insert into byeollog_automation.rules(
      id,workspace_id,name,enabled,priority,match_mode,created_by_user_id
    ) values (
      v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid
    );
  else
    select r.version_series_id,r.version_number+1
      into v_series_id,v_version
    from public.rules r
    where r.id=p_replace_rule_id
      and r.workspace_id=p_workspace_id
      and r.superseded_at is null
      and r.version_number=p_expected_version
    for update;
    if not found then
      raise exception 'rule version changed' using errcode='40001';
    end if;
    update public.rules
      set enabled=false,superseded_at=clock_timestamp(),updated_at=clock_timestamp()
      where id=p_replace_rule_id;
    update byeollog_automation.rules
      set enabled=false,updated_at=clock_timestamp()
      where id=p_replace_rule_id;
    v_rule_id := extensions.gen_random_uuid();
    insert into public.rules(
      id,workspace_id,name,enabled,priority,match_mode,created_by_user_id,
      version_series_id,version_number,supersedes_rule_id
    ) values (
      v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid,
      v_series_id,v_version,p_replace_rule_id
    );
    insert into byeollog_automation.rules(
      id,workspace_id,name,enabled,priority,match_mode,created_by_user_id
    ) values (
      v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid
    );
  end if;

  v_condition_id := extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'source','eq',to_jsonb(p_source));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'source','eq',to_jsonb(p_source));

  v_position := v_position + 1;
  v_condition_id := extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'type','eq',to_jsonb('roulette'::text));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'type','eq',to_jsonb('roulette'::text));

  if nullif(btrim(coalesce(p_subtype,'')), '') is not null then
    v_position := v_position + 1;
    v_condition_id := extensions.gen_random_uuid();
    insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'subtype','eq',to_jsonb(btrim(p_subtype)));
    insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'subtype','eq',to_jsonb(btrim(p_subtype)));
  end if;

  v_position := v_position + 1;
  v_condition_id := extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'payload.result','eq',to_jsonb(btrim(p_result)));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'payload.result','eq',to_jsonb(btrim(p_result)));

  v_params := jsonb_build_object(
    'label','다음 룰렛 보상 증가',
    'controlType','next_roulette_reward_multiplier',
    'multiplier',p_reward_multiplier,
    'allowStacking',coalesce(p_allow_multiplier_stacking,false)
  );

  insert into public.rule_actions(
    id,rule_id,position,action_type,params,execution_target,agent_device_id,
    overlay_asset_id,overlay_duration_ms
  ) values (v_action_id,v_rule_id,0,'log',v_params,'server',null,null,null);
  insert into byeollog_automation.rule_actions(
    id,rule_id,position,execution_target,agent_device_id,action_type,params,
    timeout_ms,max_attempts,retry_backoff_seconds
  ) values (v_action_id,v_rule_id,0,'server',null,'log',v_params,5000,1,15);

  return query select v_rule_id,v_version,p_enabled;
end;
$function$;

revoke all on function byeollog_automation.save_guided_rule_v8_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,uuid,integer
) from public,anon;
grant execute on function byeollog_automation.save_guided_rule_v8_impl(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,uuid,integer
) to authenticated;
create or replace function public.save_guided_rule_v8(
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
  p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,
  p_replace_rule_id uuid,
  p_expected_version integer
)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql
set search_path = ''
as $function$
  select * from byeollog_automation.save_guided_rule_v8_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,
    p_result,p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,
    p_duration_seconds,p_agent_device_id,p_overlay_image_key,p_overlay_position_x,
    p_overlay_position_y,p_overlay_scale_percent,p_reward_multiplier,
    p_allow_multiplier_stacking,p_replace_rule_id,p_expected_version
  )
$function$;

revoke all on function public.save_guided_rule_v8(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,uuid,integer
) from public,anon;
grant execute on function public.save_guided_rule_v8(
  uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,
  integer,uuid,text,integer,integer,integer,integer,boolean,uuid,integer
) to authenticated;
