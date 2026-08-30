-- OFFSL v0.7.0 RC2 compatibility surface for the dormant G3A canary.
-- Additive only. The existing Byeollog tables and Collector contracts are not changed.
-- The exact canary workspace/operator are intentionally pinned.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  if (select enabled from byeollog_automation.release_gate where gate_id = 1)
     or coalesce((select enabled from byeollog_automation.workspace_gates
                  where workspace_id = '24adec81-8833-5c68-80fe-2d26eae075fb'::uuid), false) then
    raise exception 'G3A_COMPAT01: release gates must remain OFF';
  end if;
  if exists (select 1 from byeollog_automation.events)
     or exists (select 1 from byeollog_automation.executions) then
    raise exception 'G3A_COMPAT02: runtime rows must be empty';
  end if;
  if not exists (
    select 1 from public.byeollog_workspace_members m
    join public.byeollog_workspaces w on w.id = m.workspace_id
    where m.workspace_id = '24adec81-8833-5c68-80fe-2d26eae075fb'::uuid
      and m.user_id = '37c0485c-2848-5a49-a35c-9aca5b3c459b'::uuid
      and m.role in ('owner','manager')
      and w.status = 'active'
  ) then
    raise exception 'G3A_COMPAT03: exact canary membership is unavailable';
  end if;
end;
$preflight$;

alter table byeollog_automation.agent_devices
  add column if not exists management_revision bigint not null default 1
  check (management_revision > 0);

create table public.workspace_members (
  workspace_id uuid not null,
  user_id uuid not null,
  role text not null check (role in ('owner','admin','member','viewer')),
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, user_id),
  constraint workspace_members_g3a_canary_scope check (
    workspace_id = '24adec81-8833-5c68-80fe-2d26eae075fb'::uuid
    and user_id = '37c0485c-2848-5a49-a35c-9aca5b3c459b'::uuid
  )
);

create table public.rules (
  id uuid primary key,
  workspace_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  enabled boolean not null default false,
  priority integer not null default 0 check (priority between -10000 and 10000),
  match_mode text not null default 'all' check (match_mode in ('all','any')),
  created_by_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  version_series_id uuid not null,
  version_number integer not null default 1 check (version_number > 0),
  supersedes_rule_id uuid,
  superseded_at timestamptz,
  constraint rules_g3a_canary_scope check (
    workspace_id = '24adec81-8833-5c68-80fe-2d26eae075fb'::uuid
    and created_by_user_id = '37c0485c-2848-5a49-a35c-9aca5b3c459b'::uuid
  ),
  foreign key (workspace_id, created_by_user_id)
    references public.workspace_members(workspace_id, user_id),
  foreign key (supersedes_rule_id) references public.rules(id)
);
create unique index rules_g3a_active_name_idx
  on public.rules(workspace_id, name) where superseded_at is null;
create index rules_g3a_member_fk_idx
  on public.rules(workspace_id, created_by_user_id);
create index rules_g3a_supersedes_idx
  on public.rules(supersedes_rule_id) where supersedes_rule_id is not null;

create table public.rule_conditions (
  id uuid primary key,
  rule_id uuid not null references public.rules(id) on delete cascade,
  position integer not null check (position between 0 and 255),
  path text not null check (path ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,7}$'),
  operator text not null check (operator in ('eq','neq','gt','gte','lt','lte','contains','in','exists')),
  value jsonb,
  unique (rule_id, position)
);

create table public.overlay_assets (
  id uuid primary key,
  asset_key text not null check (asset_key ~ '^[a-z][a-z0-9_.-]{1,63}$'),
  version_number integer not null check (version_number > 0),
  display_name text not null check (char_length(display_name) between 1 and 120),
  mime_type text not null check (mime_type in ('image/svg+xml','image/png','image/webp','image/gif')),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  byte_size integer not null check (byte_size between 1 and 10485760),
  width_px integer not null check (width_px between 1 and 7680),
  height_px integer not null check (height_px between 1 and 7680),
  delivery_mode text not null check (delivery_mode in ('builtin','storage')),
  retired_at timestamptz,
  unique (asset_key, version_number)
);

create table public.overlay_asset_durations (
  overlay_asset_id uuid not null references public.overlay_assets(id) on delete cascade,
  duration_ms integer not null check (duration_ms between 1000 and 240000 and duration_ms % 1000 = 0),
  primary key (overlay_asset_id, duration_ms)
);

create table public.rule_actions (
  id uuid primary key,
  rule_id uuid not null references public.rules(id) on delete cascade,
  position integer not null check (position between 0 and 255),
  action_type text not null check (action_type ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  execution_target text not null check (execution_target in ('server','local_agent')),
  agent_device_id uuid,
  overlay_asset_id uuid references public.overlay_assets(id),
  overlay_duration_ms integer check (
    overlay_duration_ms is null
    or (overlay_duration_ms between 1000 and 240000 and overlay_duration_ms % 1000 = 0)
  ),
  unique (rule_id, position)
);
create index rule_actions_g3a_overlay_idx
  on public.rule_actions(overlay_asset_id) where overlay_asset_id is not null;

insert into public.workspace_members(workspace_id,user_id,role)
select m.workspace_id, m.user_id, case when m.role = 'owner' then 'owner' else 'admin' end
from public.byeollog_workspace_members m
where m.workspace_id = '24adec81-8833-5c68-80fe-2d26eae075fb'::uuid
  and m.user_id = '37c0485c-2848-5a49-a35c-9aca5b3c459b'::uuid
  and m.role in ('owner','manager');

insert into public.overlay_assets(
  id,asset_key,version_number,display_name,mime_type,content_sha256,
  byte_size,width_px,height_px,delivery_mode
) values (
  '27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc'::uuid,
  'microphone_off',1,'별록 마이크 OFF','image/svg+xml',
  'e1bcc594283f8307b9b681794618666bc9927b5efc1a2922523629c2c352873b',
  1926,1200,360,'builtin'
);
insert into public.overlay_asset_durations(overlay_asset_id,duration_ms)
values ('27ace87d-7ffa-5cfc-9c76-36c30cc1e2bc'::uuid,10000);

alter table public.workspace_members enable row level security;
alter table public.rules enable row level security;
alter table public.rule_conditions enable row level security;
alter table public.rule_actions enable row level security;
alter table public.overlay_assets enable row level security;
alter table public.overlay_asset_durations enable row level security;

create policy workspace_members_select_self on public.workspace_members
  for select to authenticated using ((select auth.uid()) = user_id);
create policy rules_select_member on public.rules
  for select to authenticated using (exists (
    select 1 from public.workspace_members m
    where m.workspace_id = rules.workspace_id and m.user_id = (select auth.uid())
  ));
create policy rule_conditions_select_member on public.rule_conditions
  for select to authenticated using (exists (
    select 1 from public.rules r join public.workspace_members m on m.workspace_id = r.workspace_id
    where r.id = rule_conditions.rule_id and m.user_id = (select auth.uid())
  ));
create policy rule_actions_select_member on public.rule_actions
  for select to authenticated using (exists (
    select 1 from public.rules r join public.workspace_members m on m.workspace_id = r.workspace_id
    where r.id = rule_actions.rule_id and m.user_id = (select auth.uid())
  ));
create policy overlay_assets_select_member on public.overlay_assets
  for select to authenticated using (exists (
    select 1 from public.workspace_members m where m.user_id = (select auth.uid())
  ));
create policy overlay_asset_durations_select_member on public.overlay_asset_durations
  for select to authenticated using (exists (
    select 1 from public.workspace_members m where m.user_id = (select auth.uid())
  ));

revoke all on public.workspace_members, public.rules, public.rule_conditions,
  public.rule_actions, public.overlay_assets, public.overlay_asset_durations
  from public, anon, authenticated;
grant select on public.workspace_members, public.rules, public.rule_conditions,
  public.rule_actions, public.overlay_assets, public.overlay_asset_durations
  to authenticated;

create function byeollog_automation.assert_canary_manager_v1(p_workspace_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_session_id uuid;
begin
  if p_workspace_id <> '24adec81-8833-5c68-80fe-2d26eae075fb'::uuid
     or v_uid <> '37c0485c-2848-5a49-a35c-9aca5b3c459b'::uuid then
    raise exception 'canary workspace access denied' using errcode = '42501';
  end if;
  begin
    v_session_id := nullif(auth.jwt()->>'session_id','')::uuid;
  exception when others then
    raise exception 'active auth session required' using errcode = '42501';
  end;
  perform public.g3a_assert_active_auth_session_v1(v_uid,v_session_id);
  if not exists (
    select 1 from public.byeollog_workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = v_uid
      and m.role in ('owner','manager')
  ) then
    raise exception 'canary manager membership required' using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function byeollog_automation.assert_rule_write_off_v1()
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if coalesce((select g.enabled from byeollog_automation.release_gate g where g.gate_id=1),false) then
    raise exception 'rules can change only while G3A is OFF' using errcode='55000';
  end if;
end;
$$;

create function byeollog_automation.save_guided_rule_compat_v1(
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
     or p_action_type <> 'obs.mute_for'
     or p_duration_seconds not between 1 and 240
     or p_agent_device_id is null
     or p_overlay_asset_id is not null then
    raise exception 'only the overlay-free G3A OBS timed-mute rule is supported' using errcode='22023';
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
  v_params := jsonb_build_object('target','obs','durationMs',p_duration_seconds*1000);
  insert into public.rule_actions(id,rule_id,position,action_type,params,execution_target,agent_device_id,overlay_asset_id,overlay_duration_ms)
  values(v_action_id,v_rule_id,0,p_action_type,v_params,'local_agent',p_agent_device_id,null,p_duration_seconds*1000);
  insert into byeollog_automation.rule_actions(id,rule_id,position,execution_target,agent_device_id,action_type,params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_action_id,v_rule_id,0,'local_agent',p_agent_device_id,p_action_type,v_params,least(120000,p_duration_seconds*1000+30000),3,15);
  return query select v_rule_id,v_version,p_enabled;
end;
$$;

create function byeollog_automation.set_guided_rule_enabled_compat_v1(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer,p_enabled boolean
)
returns table(rule_id uuid,current_enabled boolean)
language plpgsql volatile security definer set search_path='' set statement_timeout='10s'
as $$
declare v_uid uuid; v_current integer;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();
  select version_number into v_current from public.rules
  where id=p_rule_id and workspace_id=p_workspace_id and superseded_at is null for update;
  if not found then raise exception 'rule not found' using errcode='P0002'; end if;
  if v_current<>p_expected_version then raise exception 'rule version changed' using errcode='40001'; end if;
  update public.rules set enabled=p_enabled,version_number=version_number+1,updated_at=clock_timestamp() where id=p_rule_id;
  update byeollog_automation.rules set enabled=p_enabled,updated_at=clock_timestamp() where id=p_rule_id and workspace_id=p_workspace_id;
  return query select p_rule_id,p_enabled;
end;
$$;

create function byeollog_automation.list_agent_devices_compat_v1(p_workspace_id uuid)
returns table(
  device_id uuid,display_name text,registered_at timestamptz,last_seen_at timestamptz,
  last_reported_at timestamptz,revoked_at timestamptz,agent_version text,platform text,
  supported_action_types text[],overlay_assets_ready boolean,managed_overlay_assets integer,
  management_revision bigint,connection_state text
)
language plpgsql stable security definer set search_path='' set statement_timeout='5s'
as $$
begin
  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  return query
  select d.device_id,d.device_name,d.registered_at,d.last_seen_at,s.reported_at,d.revoked_at,
    s.agent_version,s.platform,s.supported_action_types,null::boolean,0,d.management_revision,
    case when d.revoked_at is not null then 'revoked'
         when s.reported_at>=clock_timestamp()-interval '2 minutes' then 'online'
         when s.reported_at is null then 'never_reported'
         when d.last_seen_at>=clock_timestamp()-interval '24 hours' then 'idle'
         else 'offline' end
  from byeollog_automation.agent_devices d
  left join byeollog_automation.agent_device_status s
    on s.workspace_id=d.workspace_id and s.device_id=d.device_id
  where d.workspace_id=p_workspace_id order by d.registered_at desc,d.device_id;
end;
$$;

create function byeollog_automation.rename_agent_device_compat_v1(
  p_workspace_id uuid,p_agent_device_id uuid,p_expected_revision bigint,p_display_name text
)
returns table(device_id uuid,display_name text,management_revision bigint)
language plpgsql volatile security definer set search_path='' set statement_timeout='5s'
as $$
begin
  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_display_name is null or char_length(btrim(p_display_name)) not between 1 and 60 then
    raise exception 'display name is invalid' using errcode='22023';
  end if;
  update byeollog_automation.agent_devices d
  set device_name=btrim(p_display_name),management_revision=d.management_revision+1
  where d.workspace_id=p_workspace_id and d.device_id=p_agent_device_id
    and d.management_revision=p_expected_revision and d.revoked_at is null
  returning d.device_id,d.device_name,d.management_revision into device_id,display_name,management_revision;
  if not found then raise exception 'device revision changed' using errcode='40001'; end if;
  return next;
end;
$$;

create function byeollog_automation.revoke_agent_device_compat_v1(
  p_workspace_id uuid,p_agent_device_id uuid,p_expected_revision bigint
)
returns table(device_id uuid,revoked_at timestamptz,management_revision bigint,disabled_rule_count integer)
language plpgsql volatile security definer set search_path='' set statement_timeout='10s'
as $$
begin
  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();
  update byeollog_automation.agent_devices d
  set revoked_at=clock_timestamp(),management_revision=d.management_revision+1
  where d.workspace_id=p_workspace_id and d.device_id=p_agent_device_id
    and d.management_revision=p_expected_revision and d.revoked_at is null
  returning d.device_id,d.revoked_at,d.management_revision into device_id,revoked_at,management_revision;
  if not found then raise exception 'device revision changed' using errcode='40001'; end if;
  with affected as (
    select distinct a.rule_id from public.rule_actions a join public.rules r on r.id=a.rule_id
    where r.workspace_id=p_workspace_id and a.agent_device_id=p_agent_device_id and r.enabled
  ), changed as (
    update public.rules r set enabled=false,version_number=version_number+1,updated_at=clock_timestamp()
    where r.id in (select rule_id from affected) returning r.id
  ) select count(*)::integer into disabled_rule_count from changed;
  update byeollog_automation.rules r set enabled=false,updated_at=clock_timestamp()
  where r.workspace_id=p_workspace_id and r.id in (
    select a.rule_id from byeollog_automation.rule_actions a where a.agent_device_id=p_agent_device_id
  );
  return next;
end;
$$;

create function byeollog_automation.list_overlay_readiness_compat_v1(p_workspace_id uuid)
returns table(agent_device_id uuid,asset_id uuid,content_sha256 text,reported_at timestamptz,fresh boolean)
language plpgsql stable security definer set search_path='' as $$
begin
  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  return;
end;
$$;

create function byeollog_automation.list_activity_compat_v1(p_workspace_id uuid,p_limit integer)
returns table(
  id uuid,status text,attempt_count integer,max_attempts integer,next_attempt_at timestamptz,
  lease_expires_at timestamptz,created_at timestamptz,updated_at timestamptz,
  action_type text,execution_target text,error_disposition text,error_code text,
  event_source text,event_type text,event_subtype text,event_occurred_at timestamptz,
  actor_name text,actor_id text,rule_name text
)
language plpgsql stable security definer set search_path='' set statement_timeout='5s'
as $$
begin
  perform byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_limit not between 1 and 100 then raise exception 'limit is invalid' using errcode='22023'; end if;
  return query
  select x.id,
    case x.status when 'queued' then 'pending' else x.status end,
    x.attempt_no,x.max_attempts,x.next_attempt_at,x.lease_expires_at,x.created_at,
    coalesce(x.finished_at,x.started_at,x.created_at),x.action_type,x.execution_target,
    case when x.status in ('queued','running','retry_scheduled') then 'retrying'
         when x.status='failed' then 'needs_review'
         when x.status='cancelled' then 'blocked' end,
    null::text,e.source,e.event_type,e.subtype,e.occurred_at,
    nullif(e.actor->>'name',''),nullif(e.actor->>'id',''),coalesce(r.name,'삭제된 규칙')
  from byeollog_automation.executions x
  join byeollog_automation.events e on e.id=x.event_id
  left join byeollog_automation.rules r on r.id=x.rule_id
  where x.workspace_id=p_workspace_id order by x.created_at desc,x.id limit p_limit;
end;
$$;

create function public.save_guided_rule_v4(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,
  p_source text,p_event_type text,p_subtype text,p_result text,p_min_amount bigint,
  p_action_type text,p_event_name text,p_output_types text[],p_quantity integer,
  p_duration_seconds integer,p_agent_device_id uuid,p_overlay_asset_id uuid,
  p_replace_rule_id uuid,p_expected_version integer
)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql volatile security invoker set search_path=''
as $$ select * from byeollog_automation.save_guided_rule_compat_v1(
  p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,p_min_amount,
  p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,p_agent_device_id,
  p_overlay_asset_id,p_replace_rule_id,p_expected_version) $$;

create function public.set_guided_rule_enabled_v1(p_workspace_id uuid,p_rule_id uuid,p_expected_version integer,p_enabled boolean)
returns table(rule_id uuid,current_enabled boolean)
language sql volatile security invoker set search_path=''
as $$ select * from byeollog_automation.set_guided_rule_enabled_compat_v1(p_workspace_id,p_rule_id,p_expected_version,p_enabled) $$;
create function public.list_agent_devices_v1(p_workspace_id uuid)
returns table(device_id uuid,display_name text,registered_at timestamptz,last_seen_at timestamptz,last_reported_at timestamptz,revoked_at timestamptz,agent_version text,platform text,supported_action_types text[],overlay_assets_ready boolean,managed_overlay_assets integer,management_revision bigint,connection_state text)
language sql stable security invoker set search_path=''
as $$ select * from byeollog_automation.list_agent_devices_compat_v1(p_workspace_id) $$;
create function public.rename_agent_device_v1(p_workspace_id uuid,p_agent_device_id uuid,p_expected_revision bigint,p_display_name text)
returns table(device_id uuid,display_name text,management_revision bigint)
language sql volatile security invoker set search_path=''
as $$ select * from byeollog_automation.rename_agent_device_compat_v1(p_workspace_id,p_agent_device_id,p_expected_revision,p_display_name) $$;
create function public.revoke_agent_device_v1(p_workspace_id uuid,p_agent_device_id uuid,p_expected_revision bigint)
returns table(device_id uuid,revoked_at timestamptz,management_revision bigint,disabled_rule_count integer)
language sql volatile security invoker set search_path=''
as $$ select * from byeollog_automation.revoke_agent_device_compat_v1(p_workspace_id,p_agent_device_id,p_expected_revision) $$;
create function public.list_agent_overlay_asset_readiness_v1(p_workspace_id uuid)
returns table(agent_device_id uuid,asset_id uuid,content_sha256 text,reported_at timestamptz,fresh boolean)
language sql stable security invoker set search_path=''
as $$ select * from byeollog_automation.list_overlay_readiness_compat_v1(p_workspace_id) $$;
create function public.list_automation_activity_v1(p_workspace_id uuid,p_limit integer)
returns table(id uuid,status text,attempt_count integer,max_attempts integer,next_attempt_at timestamptz,lease_expires_at timestamptz,created_at timestamptz,updated_at timestamptz,action_type text,execution_target text,error_disposition text,error_code text,event_source text,event_type text,event_subtype text,event_occurred_at timestamptz,actor_name text,actor_id text,rule_name text)
language sql stable security invoker set search_path=''
as $$ select * from byeollog_automation.list_activity_compat_v1(p_workspace_id,p_limit) $$;

revoke all on all functions in schema byeollog_automation from public,anon,authenticated;
grant usage on schema byeollog_automation to authenticated;
grant execute on function byeollog_automation.save_guided_rule_compat_v1(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,uuid,integer) to authenticated;
grant execute on function byeollog_automation.set_guided_rule_enabled_compat_v1(uuid,uuid,integer,boolean) to authenticated;
grant execute on function byeollog_automation.list_agent_devices_compat_v1(uuid) to authenticated;
grant execute on function byeollog_automation.rename_agent_device_compat_v1(uuid,uuid,bigint,text) to authenticated;
grant execute on function byeollog_automation.revoke_agent_device_compat_v1(uuid,uuid,bigint) to authenticated;
grant execute on function byeollog_automation.list_overlay_readiness_compat_v1(uuid) to authenticated;
grant execute on function byeollog_automation.list_activity_compat_v1(uuid,integer) to authenticated;

revoke execute on function public.save_guided_rule_v4(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,uuid,integer) from public,anon;
revoke execute on function public.set_guided_rule_enabled_v1(uuid,uuid,integer,boolean) from public,anon;
revoke execute on function public.list_agent_devices_v1(uuid) from public,anon;
revoke execute on function public.rename_agent_device_v1(uuid,uuid,bigint,text) from public,anon;
revoke execute on function public.revoke_agent_device_v1(uuid,uuid,bigint) from public,anon;
revoke execute on function public.list_agent_overlay_asset_readiness_v1(uuid) from public,anon;
revoke execute on function public.list_automation_activity_v1(uuid,integer) from public,anon;
grant execute on function public.save_guided_rule_v4(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,uuid,integer) to authenticated;
grant execute on function public.set_guided_rule_enabled_v1(uuid,uuid,integer,boolean) to authenticated;
grant execute on function public.list_agent_devices_v1(uuid) to authenticated;
grant execute on function public.rename_agent_device_v1(uuid,uuid,bigint,text) to authenticated;
grant execute on function public.revoke_agent_device_v1(uuid,uuid,bigint) to authenticated;
grant execute on function public.list_agent_overlay_asset_readiness_v1(uuid) to authenticated;
grant execute on function public.list_automation_activity_v1(uuid,integer) to authenticated;

notify pgrst,'reload schema';

do $postflight$
begin
  if (select count(*) from public.workspace_members)<>1
     or (select count(*) from public.overlay_assets)<>1
     or (select count(*) from public.overlay_asset_durations)<>1
     or exists(select 1 from public.rules)
     or exists(select 1 from byeollog_automation.rules)
     or (select enabled from byeollog_automation.release_gate where gate_id=1) then
    raise exception 'G3A_COMPAT04: additive postflight failed';
  end if;
end;
$postflight$;

commit;
;
