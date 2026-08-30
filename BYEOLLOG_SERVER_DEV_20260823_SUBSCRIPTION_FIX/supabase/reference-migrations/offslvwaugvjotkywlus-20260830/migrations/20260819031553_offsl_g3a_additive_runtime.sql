-- OFFSL G3A: additive, opt-in automation runtime.
--
-- Safety boundary:
--   * no legacy table/function/policy/ACL/storage mutation;
--   * no foreign key or trigger is attached to a legacy object;
--   * all candidate state lives in byeollog_automation;
--   * every API mutation re-locks the global and workspace gates;
--   * installation leaves the global gate OFF and enrolls no workspace.

begin;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

do $$
declare
  v_missing text[];
begin
  select array_agg(v.name order by v.name)
    into v_missing
  from unnest(array[
    'bangsel_collector_logs',
    'bangsel_collector_staging',
    'bangsel_donations',
    'bangsel_fan_stations',
    'bangsel_fans',
    'bangsel_roulette_invalidations',
    'bangsel_roulette_rules',
    'bangsel_task_import_items',
    'bangsel_tasks',
    'byeollog_audit_log',
    'byeollog_collector_devices',
    'byeollog_dashboard_handoffs',
    'byeollog_inquiries',
    'byeollog_rate_limits',
    'byeollog_signup_applications',
    'byeollog_workspace_members',
    'byeollog_workspace_settings',
    'byeollog_workspaces'
  ]::text[]) as v(name)
  where to_regclass(format('public.%I', v.name)) is null;

  if v_missing is not null then
    raise exception 'G3A_PF01: required legacy tables are missing: %', v_missing;
  end if;

  if to_regnamespace('byeollog_automation') is not null then
    raise exception 'G3A_PF02: byeollog_automation already exists';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'g3a\_%' escape '\'
  ) then
    raise exception 'G3A_PF03: a public g3a_* function already exists';
  end if;

  if to_regprocedure('extensions.digest(text,text)') is null
     or to_regprocedure('extensions.digest(bytea,text)') is null
     or to_regprocedure('extensions.gen_random_uuid()') is null then
    raise exception 'G3A_PF04: required pgcrypto functions are unavailable';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'auth' and table_name = 'sessions'
      and column_name = 'id' and udt_name = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'auth' and table_name = 'sessions'
      and column_name = 'user_id' and udt_name = 'uuid'
  ) or not exists (
    select 1
    from information_schema.columns
    where table_schema = 'auth' and table_name = 'sessions'
      and column_name = 'not_after' and udt_name = 'timestamptz'
  ) then
    raise exception 'G3A_PF05: auth.sessions contract is unavailable';
  end if;

  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'byeollog_workspaces'
      and column_name = 'id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'byeollog_workspaces'
      and column_name = 'status' and udt_name = 'text' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'byeollog_workspace_members'
      and column_name = 'workspace_id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'byeollog_workspace_members'
      and column_name = 'user_id' and udt_name = 'uuid' and is_nullable = 'NO'
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'byeollog_workspace_members'
      and column_name = 'role' and udt_name = 'text' and is_nullable = 'NO'
  ) then
    raise exception 'G3A_PF06: legacy workspace identity contract drifted';
  end if;

  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'anon')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'authenticated')
     or not exists (select 1 from pg_catalog.pg_roles where rolname = 'service_role') then
    raise exception 'G3A_PF07: expected API roles are unavailable';
  end if;
end;
$$;

create schema byeollog_automation;
revoke all on schema byeollog_automation from public, anon, authenticated, service_role;

comment on schema byeollog_automation is
  'OFFSL G3A additive automation state. Not exposed through the Data API.';

create table byeollog_automation.release_gate (
  gate_id smallint primary key default 1 check (gate_id = 1),
  enabled boolean not null default false,
  project_ref text not null default 'offslvwaugvjotkywlus'
    check (project_ref = 'offslvwaugvjotkywlus'),
  db_revision text not null default 'offsl-vnext-g3a-v1'
    check (db_revision = 'offsl-vnext-g3a-v1'),
  event_runtime_revision text not null default 'offsl-event-runtime-g3a-v1'
    check (event_runtime_revision = 'offsl-event-runtime-g3a-v1'),
  execution_worker_revision text not null default 'offsl-execution-worker-g3a-v1'
    check (execution_worker_revision = 'offsl-execution-worker-g3a-v1'),
  agent_runtime_revision text not null default 'offsl-agent-runtime-g3a-v1'
    check (agent_runtime_revision = 'offsl-agent-runtime-g3a-v1'),
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  enabled_at timestamptz,
  disabled_at timestamptz default clock_timestamp(),
  changed_by uuid,
  changed_at timestamptz not null default clock_timestamp(),
  constraint release_gate_g3a_install_dormant check (not enabled),
  constraint release_gate_state_safe check (
    (not enabled and enabled_at is null and disabled_at is not null)
    or (enabled and enabled_at is not null and disabled_at is null and evidence_sha256 is not null)
  )
);

insert into byeollog_automation.release_gate(gate_id, enabled)
values (1, false);

create table byeollog_automation.workspace_gates (
  workspace_id uuid primary key,
  enabled boolean not null default false,
  evidence_sha256 text check (evidence_sha256 is null or evidence_sha256 ~ '^[0-9a-f]{64}$'),
  enrolled_by uuid not null,
  enrolled_at timestamptz not null default clock_timestamp(),
  enabled_at timestamptz,
  disabled_at timestamptz default clock_timestamp(),
  changed_by uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  constraint workspace_gate_g3a_install_dormant check (not enabled),
  constraint workspace_gate_state_safe check (
    (not enabled and enabled_at is null and disabled_at is not null)
    or (enabled and enabled_at is not null and disabled_at is null and evidence_sha256 is not null)
  )
);

create unique index workspace_gates_single_enabled_idx
  on byeollog_automation.workspace_gates ((enabled))
  where enabled;

create table byeollog_automation.events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  schema_version text not null check (schema_version = '1.0'),
  external_event_id text not null check (char_length(external_event_id) between 1 and 200),
  source text not null check (source ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  platform text not null check (platform ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  event_type text not null check (event_type ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$'),
  subtype text check (subtype is null or char_length(subtype) between 1 and 64),
  actor jsonb check (actor is null or jsonb_typeof(actor) = 'object'),
  amount numeric check (amount is null or amount >= 0),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  raw jsonb,
  correlation_id text check (correlation_id is null or char_length(correlation_id) between 1 and 200),
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  authorized_user_id uuid not null,
  plan_token text not null check (plan_token ~ '^[0-9a-f]{64}$'),
  evaluated_rule_ids uuid[] not null default '{}'::uuid[],
  matched_rule_ids uuid[] not null default '{}'::uuid[],
  committed_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, source, external_event_id)
);

create index events_workspace_occurred_idx
  on byeollog_automation.events(workspace_id, occurred_at desc);

create table byeollog_automation.rules (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  enabled boolean not null default false,
  priority integer not null default 0 check (priority between -100000 and 100000),
  match_mode text not null default 'all' check (match_mode in ('all', 'any')),
  created_by_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, name)
);

create index rules_workspace_enabled_priority_idx
  on byeollog_automation.rules(workspace_id, enabled, priority desc, id);

create table byeollog_automation.rule_conditions (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_id uuid not null references byeollog_automation.rules(id) on delete cascade,
  position integer not null check (position between 0 and 255),
  path text not null check (path ~ '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*){0,7}$'),
  operator text not null check (operator in ('eq','neq','gt','gte','lt','lte','contains','in','exists')),
  value jsonb,
  unique (rule_id, position)
);

create index rule_conditions_rule_idx
  on byeollog_automation.rule_conditions(rule_id, position);

create table byeollog_automation.agent_devices (
  workspace_id uuid not null,
  device_id uuid not null,
  device_name text not null default 'Automation Agent'
    check (char_length(btrim(device_name)) between 1 and 120),
  secret_hash bytea not null check (octet_length(secret_hash) = 32),
  previous_secret_hash bytea check (previous_secret_hash is null or octet_length(previous_secret_hash) = 32),
  previous_secret_valid_until timestamptz,
  secret_revision bigint not null default 1 check (secret_revision > 0),
  secret_rotated_at timestamptz not null default clock_timestamp(),
  created_by_user_id uuid not null,
  registration_session_id uuid not null,
  registered_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  primary key (workspace_id, device_id),
  unique (registration_session_id),
  constraint agent_devices_previous_secret_safe check (
    (previous_secret_hash is null and previous_secret_valid_until is null)
    or (previous_secret_hash is not null and previous_secret_valid_until is not null)
  )
);

create index agent_devices_workspace_active_idx
  on byeollog_automation.agent_devices(workspace_id, last_seen_at desc)
  where revoked_at is null;

create table byeollog_automation.agent_device_status (
  workspace_id uuid not null,
  device_id uuid not null,
  agent_version text not null check (agent_version ~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'),
  platform text not null check (platform in ('windows','linux','macos','unknown')),
  supported_action_types text[] not null,
  reported_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, device_id),
  foreign key (workspace_id, device_id)
    references byeollog_automation.agent_devices(workspace_id, device_id)
    on delete cascade,
  constraint agent_device_status_action_count_safe check (
    cardinality(supported_action_types) between 1 and 32
  )
);

create table byeollog_automation.rule_actions (
  id uuid primary key default extensions.gen_random_uuid(),
  rule_id uuid not null references byeollog_automation.rules(id) on delete cascade,
  position integer not null check (position between 0 and 255),
  execution_target text not null check (execution_target in ('server','local_agent')),
  agent_device_id uuid,
  action_type text not null check (action_type ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  timeout_ms integer not null default 30000 check (timeout_ms between 100 and 120000),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10),
  retry_backoff_seconds integer not null default 15 check (retry_backoff_seconds between 1 and 3600),
  unique (rule_id, position),
  constraint rule_actions_target_safe check (
    (execution_target = 'server' and action_type = 'log' and agent_device_id is null)
    or (
      execution_target = 'local_agent'
      and action_type in ('obs.mute_for','obs.scene_switch','agent.notify')
      and not (params ? 'overlayAssetKey')
    )
  )
);

create index rule_actions_rule_idx
  on byeollog_automation.rule_actions(rule_id, position);

create table byeollog_automation.executions (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  event_id uuid not null references byeollog_automation.events(id) on delete cascade,
  rule_id uuid not null,
  action_id uuid not null,
  idempotency_key text not null check (idempotency_key ~ '^[0-9a-f]{64}$'),
  execution_target text not null check (execution_target in ('server','local_agent')),
  agent_device_id uuid,
  action_type text not null check (action_type ~ '^[a-z][a-z0-9_.-]{0,119}$'),
  action_params jsonb not null check (jsonb_typeof(action_params) = 'object'),
  timeout_ms integer not null check (timeout_ms between 100 and 120000),
  max_attempts integer not null check (max_attempts between 1 and 10),
  retry_backoff_seconds integer not null check (retry_backoff_seconds between 1 and 3600),
  status text not null default 'queued'
    check (status in ('queued','running','retry_scheduled','succeeded','failed','cancelled')),
  attempt_no integer not null default 0 check (attempt_no between 0 and 10),
  next_attempt_at timestamptz not null default clock_timestamp(),
  lease_owner text,
  lease_expires_at timestamptz,
  result jsonb,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (workspace_id, idempotency_key),
  constraint executions_lease_safe check (
    (status = 'running' and lease_owner is not null and lease_expires_at is not null)
    or (status <> 'running' and lease_owner is null and lease_expires_at is null)
  ),
  constraint executions_terminal_time_safe check (
    (status in ('succeeded','failed','cancelled') and finished_at is not null)
    or (status not in ('succeeded','failed','cancelled') and finished_at is null)
  )
);

create index executions_due_idx
  on byeollog_automation.executions(workspace_id, execution_target, next_attempt_at, created_at)
  where status in ('queued','retry_scheduled','running');

create index executions_event_idx
  on byeollog_automation.executions(event_id, created_at);

alter table byeollog_automation.release_gate enable row level security;
alter table byeollog_automation.workspace_gates enable row level security;
alter table byeollog_automation.events enable row level security;
alter table byeollog_automation.rules enable row level security;
alter table byeollog_automation.rule_conditions enable row level security;
alter table byeollog_automation.rule_actions enable row level security;
alter table byeollog_automation.executions enable row level security;
alter table byeollog_automation.agent_devices enable row level security;
alter table byeollog_automation.agent_device_status enable row level security;

create function byeollog_automation.assert_runtime_locked_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_release byeollog_automation.release_gate%rowtype;
  v_workspace byeollog_automation.workspace_gates%rowtype;
  v_expected_revision text;
begin
  if p_workspace_id is null or p_authorized_user_id is null
     or p_session_id is null or p_runtime_component is null
     or p_runtime_revision is null or p_db_revision is null then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  select g.* into v_release
  from byeollog_automation.release_gate g
  where g.gate_id = 1
  for share;

  if not found or not v_release.enabled
     or v_release.project_ref <> 'offslvwaugvjotkywlus'
     or v_release.db_revision <> 'offsl-vnext-g3a-v1'
     or v_release.evidence_sha256 is null then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  if p_db_revision <> v_release.db_revision then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  v_expected_revision := case p_runtime_component
    when 'event_runtime' then v_release.event_runtime_revision
    when 'execution_worker' then v_release.execution_worker_revision
    when 'agent_runtime' then v_release.agent_runtime_revision
    else null
  end;
  if v_expected_revision is null or p_runtime_revision is distinct from v_expected_revision then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  select g.* into v_workspace
  from byeollog_automation.workspace_gates g
  where g.workspace_id = p_workspace_id
  for share;

  if not found or not v_workspace.enabled or v_workspace.evidence_sha256 is null then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  -- These row locks exist only after both opt-in gates pass. They bind the
  -- authorization decision to this short candidate transaction without
  -- attaching any trigger, FK, policy or ACL to the legacy source tables.
  perform 1
  from public.byeollog_workspaces w
  where w.id = p_workspace_id and w.status = 'active'
  for share;
  if not found then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  perform 1
  from public.byeollog_workspace_members m
  where m.workspace_id = p_workspace_id
    and m.user_id = p_authorized_user_id
    and m.role in ('owner','manager')
  for share;
  if not found then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  if not exists (
    select 1
    from auth.sessions s
    where s.id = p_session_id
      and s.user_id = p_authorized_user_id
      and (s.not_after is null or s.not_after > now())
  ) then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;
end;
$$;

create function public.g3a_assert_active_auth_session_v1(
  p_user_id uuid,
  p_session_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $$
  select p_user_id is not null
    and p_session_id is not null
    and exists (
      select 1
      from auth.sessions s
      where s.id = p_session_id
        and s.user_id = p_user_id
        and (s.not_after is null or s.not_after > now())
    );
$$;

create function public.g3a_assert_runtime_active_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );
  return true;
exception when others then
  raise exception 'automation runtime unavailable' using errcode = 'BLR03';
end;
$$;

create function byeollog_automation.current_plan_v1(p_workspace_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
  with active_rules as (
    select r.*
    from byeollog_automation.rules r
    where r.workspace_id = p_workspace_id and r.enabled
  ), rules_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', r.id,
        'workspace_id', r.workspace_id,
        'name', r.name,
        'enabled', r.enabled,
        'priority', r.priority,
        'match_mode', r.match_mode
      ) order by r.priority desc, r.id
    ), '[]'::jsonb) as value
    from active_rules r
  ), conditions_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', c.id,
        'rule_id', c.rule_id,
        'position', c.position,
        'path', c.path,
        'operator', c.operator,
        'value', c.value
      ) order by c.rule_id, c.position, c.id
    ), '[]'::jsonb) as value
    from byeollog_automation.rule_conditions c
    join active_rules r on r.id = c.rule_id
  ), actions_json as (
    select coalesce(jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'rule_id', a.rule_id,
        'position', a.position,
        'execution_target', a.execution_target,
        'agent_device_id', a.agent_device_id,
        'action_type', a.action_type,
        'params', a.params,
        'timeout_ms', a.timeout_ms,
        'max_attempts', a.max_attempts,
        'retry_backoff_seconds', a.retry_backoff_seconds
      ) order by a.rule_id, a.position, a.id
    ), '[]'::jsonb) as value
    from byeollog_automation.rule_actions a
    join active_rules r on r.id = a.rule_id
  )
  select jsonb_build_object(
    'rules', rules_json.value,
    'conditions', conditions_json.value,
    'actions', actions_json.value
  )
  from rules_json, conditions_json, actions_json;
$$;

create function public.g3a_automation_schema_readiness_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid
)
returns table (
  ready boolean,
  revision text,
  project_ref text,
  workspace_id uuid,
  authorized_user_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_ready boolean := false;
  v_spec text;
  v_rpc oid;
  v_rpc_ok boolean;
  v_required_rpcs text[] := array[
    'public.g3a_assert_active_auth_session_v1(uuid,uuid)',
    'public.g3a_assert_runtime_active_v1(uuid,uuid,uuid,text,text,text)',
    'public.g3a_automation_schema_readiness_v1(uuid,uuid)',
    'public.g3a_load_automation_plan_v1(uuid,uuid,uuid,text,text,text)',
    'public.g3a_commit_event_plan_v1(uuid,jsonb,uuid,uuid,text,text,text,text,uuid[],uuid[],uuid[])',
    'public.g3a_claim_execution_v1(uuid,text,integer,uuid[],text,uuid,text,text[],uuid,uuid,text,text,text)',
    'public.g3a_renew_execution_v1(uuid,uuid,text,integer,integer,uuid,text,uuid,uuid,text,text,text)',
    'public.g3a_finish_execution_v1(uuid,uuid,text,integer,boolean,jsonb,text,boolean,uuid,text,uuid,uuid,text,text,text)',
    'public.g3a_register_agent_device_v1(uuid,uuid,text,text,uuid,uuid,bigint,text,text,text,text)',
    'public.g3a_rotate_agent_device_secret_v1(uuid,uuid,text,text,uuid,uuid,text,text,text)',
    'public.g3a_report_agent_status_v1(uuid,uuid,text,text,text,text[],uuid,uuid,text,text,text)'
  ];
begin
  if p_workspace_id is not null and p_authorized_user_id is not null then
    select exists (
      select 1
      from byeollog_automation.release_gate rg
      join byeollog_automation.workspace_gates wg
        on wg.workspace_id = p_workspace_id
      join public.byeollog_workspaces w
        on w.id = wg.workspace_id and w.status = 'active'
      join public.byeollog_workspace_members m
        on m.workspace_id = w.id
       and m.user_id = p_authorized_user_id
       and m.role in ('owner','manager')
      where rg.gate_id = 1
        and rg.enabled
        and rg.project_ref = 'offslvwaugvjotkywlus'
        and rg.db_revision = 'offsl-vnext-g3a-v1'
        and rg.evidence_sha256 is not null
        and wg.enabled
        and wg.evidence_sha256 is not null
    ) into v_ready;
  end if;

  if v_ready then
    if (
      select count(*)
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'g3a\_%' escape '\'
    ) <> cardinality(v_required_rpcs) then
      v_ready := false;
    end if;

    foreach v_spec in array v_required_rpcs loop
      exit when not v_ready;
      v_rpc := to_regprocedure(v_spec);
      if v_rpc is null then
        v_ready := false;
        exit;
      end if;

      select exists (
        select 1
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
        where p.oid = v_rpc
          and n.nspname = 'public'
          and owner_role.rolname = 'postgres'
          and p.prokind = 'f'
          and p.prosecdef
          and p.proconfig @> array['search_path=""']::text[]
          and exists (
            select 1 from unnest(p.proconfig) as cfg(value)
            where cfg.value like 'statement_timeout=%'
          )
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
          and not exists (
            select 1
            from pg_catalog.aclexplode(
              coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) acl
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> p.proowner
              and acl.grantee <> (
                select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role'
              )
          )
      ) into v_rpc_ok;
      v_ready := v_ready and coalesce(v_rpc_ok, false);
    end loop;
  end if;

  return query select
    v_ready,
    'offsl-vnext-g3a-v1'::text,
    'offslvwaugvjotkywlus'::text,
    p_workspace_id,
    p_authorized_user_id;
end;
$$;

create function public.g3a_load_automation_plan_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_plan jsonb;
  v_token text;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  v_plan := byeollog_automation.current_plan_v1(p_workspace_id);
  v_token := encode(
    extensions.digest(pg_catalog.convert_to(v_plan::text, 'UTF8'), 'sha256'),
    'hex'
  );

  return jsonb_build_object(
    'planToken', v_token,
    'rules', v_plan -> 'rules',
    'conditions', v_plan -> 'conditions',
    'actions', v_plan -> 'actions'
  );
end;
$$;

create function byeollog_automation.enroll_workspace_v1(
  p_workspace_id uuid,
  p_operator_user_id uuid,
  p_evidence_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_global_enabled boolean;
begin
  if p_workspace_id is null or p_operator_user_id is null
     or p_evidence_sha256 is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'workspace enrollment parameters are invalid' using errcode = '22023';
  end if;

  select g.enabled into v_global_enabled
  from byeollog_automation.release_gate g
  where g.gate_id = 1
  for update;
  if not found or v_global_enabled then
    raise exception 'global gate must be disabled before enrollment' using errcode = '55000';
  end if;

  perform 1
  from public.byeollog_workspaces w
  join public.byeollog_workspace_members m
    on m.workspace_id = w.id
  where w.id = p_workspace_id
    and w.status = 'active'
    and m.user_id = p_operator_user_id
    and m.role in ('owner','manager')
  for share of w, m;
  if not found then
    raise exception 'active operator membership is required' using errcode = '42501';
  end if;

  insert into byeollog_automation.workspace_gates(
    workspace_id,
    enabled,
    evidence_sha256,
    enrolled_by,
    changed_by
  ) values (
    p_workspace_id,
    false,
    p_evidence_sha256,
    p_operator_user_id,
    p_operator_user_id
  );
end;
$$;

create function byeollog_automation.set_workspace_gate_v1(
  p_workspace_id uuid,
  p_enabled boolean,
  p_operator_user_id uuid,
  p_evidence_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_global_enabled boolean;
begin
  if p_workspace_id is null or p_enabled is null or p_operator_user_id is null then
    raise exception 'workspace gate parameters are invalid' using errcode = '22023';
  end if;
  if p_enabled and (p_evidence_sha256 is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'activation evidence is required' using errcode = '22023';
  end if;

  select g.enabled into v_global_enabled
  from byeollog_automation.release_gate g
  where g.gate_id = 1
  for update;
  if not found then
    raise exception 'global release gate is missing' using errcode = '55000';
  end if;
  if p_enabled and v_global_enabled then
    raise exception 'global gate must be disabled while arming a workspace' using errcode = '55000';
  end if;

  if p_enabled then
    perform 1
    from public.byeollog_workspaces w
    join public.byeollog_workspace_members m on m.workspace_id = w.id
    where w.id = p_workspace_id
      and w.status = 'active'
      and m.user_id = p_operator_user_id
      and m.role in ('owner','manager')
    for share of w, m;
    if not found then
      raise exception 'active operator membership is required' using errcode = '42501';
    end if;
  end if;

  update byeollog_automation.workspace_gates g
  set enabled = p_enabled,
      evidence_sha256 = case when p_enabled then p_evidence_sha256 else g.evidence_sha256 end,
      enabled_at = case when p_enabled then clock_timestamp() else null end,
      disabled_at = case when p_enabled then null else clock_timestamp() end,
      changed_by = p_operator_user_id,
      changed_at = clock_timestamp()
  where g.workspace_id = p_workspace_id;
  if not found then
    raise exception 'workspace is not enrolled' using errcode = 'P0002';
  end if;
end;
$$;

create function byeollog_automation.set_release_gate_v1(
  p_enabled boolean,
  p_operator_user_id uuid,
  p_evidence_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_workspace_id uuid;
begin
  if p_enabled is null or p_operator_user_id is null then
    raise exception 'release gate parameters are invalid' using errcode = '22023';
  end if;
  if p_enabled and (p_evidence_sha256 is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'activation evidence is required' using errcode = '22023';
  end if;

  -- The operational order is always global row, then workspace row. This is
  -- the same order used by runtime mutations and emergency stop.
  perform 1
  from byeollog_automation.release_gate g
  where g.gate_id = 1
  for update;
  if not found then
    raise exception 'global release gate is missing' using errcode = '55000';
  end if;

  if p_enabled then
    select g.workspace_id into v_workspace_id
    from byeollog_automation.workspace_gates g
    where g.enabled
    for share;
    if not found then
      raise exception 'one workspace gate must be enabled first' using errcode = '55000';
    end if;

    perform 1
    from public.byeollog_workspaces w
    join public.byeollog_workspace_members m on m.workspace_id = w.id
    where w.id = v_workspace_id
      and w.status = 'active'
      and m.user_id = p_operator_user_id
      and m.role in ('owner','manager')
    for share of w, m;
    if not found then
      raise exception 'active operator membership is required' using errcode = '42501';
    end if;
  end if;

  update byeollog_automation.release_gate g
  set enabled = p_enabled,
      evidence_sha256 = case when p_enabled then p_evidence_sha256 else g.evidence_sha256 end,
      enabled_at = case when p_enabled then clock_timestamp() else null end,
      disabled_at = case when p_enabled then null else clock_timestamp() end,
      changed_by = p_operator_user_id,
      changed_at = clock_timestamp()
  where g.gate_id = 1;
end;
$$;

create function byeollog_automation.normalized_uuid_array_v1(p_values uuid[])
returns uuid[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(v.value order by v.value), '{}'::uuid[])
  from (
    select distinct u.value
    from unnest(coalesce(p_values, '{}'::uuid[])) as u(value)
    where u.value is not null
  ) v;
$$;

create function public.g3a_commit_event_plan_v1(
  p_workspace_id uuid,
  p_event jsonb,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text,
  p_plan_token text,
  p_evaluated_rule_ids uuid[],
  p_matched_rule_ids uuid[],
  p_rule_action_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_plan jsonb;
  v_current_token text;
  v_evaluated uuid[];
  v_matched uuid[];
  v_actions uuid[];
  v_expected_rules uuid[];
  v_expected_actions uuid[];
  v_event_id uuid;
  v_existing byeollog_automation.events%rowtype;
  v_source text;
  v_external_event_id text;
  v_schema_version text;
  v_platform text;
  v_event_type text;
  v_subtype text;
  v_actor jsonb;
  v_amount numeric;
  v_currency text;
  v_payload jsonb;
  v_raw jsonb;
  v_correlation_id text;
  v_occurred_at timestamptz;
  v_received_at timestamptz;
  v_queued_ids uuid[];
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  -- Candidate rule writers take the same lock from candidate-only triggers.
  -- It closes inserts as well as updates/deletes, so the token verification
  -- and execution snapshot below observe one immutable rule universe.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('g3a-rule-plan:' || p_workspace_id::text, 3200)
  );

  if p_runtime_component <> 'event_runtime'
     or p_event is null or jsonb_typeof(p_event) <> 'object'
     or p_plan_token is null or p_plan_token !~ '^[0-9a-f]{64}$' then
    raise exception 'event plan parameters are invalid' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_object_keys(p_event) as k(key)
    where k.key <> all (array[
      'workspace_id','schema_version','external_event_id','source','platform',
      'event_type','subtype','actor','amount','currency','payload','raw',
      'correlation_id','occurred_at','received_at'
    ]::text[])
  ) then
    raise exception 'event contains unsupported fields' using errcode = '22023';
  end if;

  begin
    if (p_event ->> 'workspace_id')::uuid is distinct from p_workspace_id then
      raise exception 'event workspace mismatch' using errcode = '22023';
    end if;
    v_schema_version := p_event ->> 'schema_version';
    v_external_event_id := p_event ->> 'external_event_id';
    v_source := p_event ->> 'source';
    v_platform := p_event ->> 'platform';
    v_event_type := p_event ->> 'event_type';
    v_subtype := nullif(p_event ->> 'subtype', '');
    v_actor := case
      when not (p_event ? 'actor') or jsonb_typeof(p_event -> 'actor') = 'null' then null
      else p_event -> 'actor'
    end;
    v_amount := case
      when not (p_event ? 'amount') or jsonb_typeof(p_event -> 'amount') = 'null' then null
      else (p_event ->> 'amount')::numeric
    end;
    v_currency := nullif(p_event ->> 'currency', '');
    v_payload := p_event -> 'payload';
    v_raw := case
      when not (p_event ? 'raw') or jsonb_typeof(p_event -> 'raw') = 'null' then null
      else p_event -> 'raw'
    end;
    v_correlation_id := nullif(p_event ->> 'correlation_id', '');
    v_occurred_at := (p_event ->> 'occurred_at')::timestamptz;
    v_received_at := (p_event ->> 'received_at')::timestamptz;
  exception when invalid_text_representation or invalid_datetime_format
    or numeric_value_out_of_range or datetime_field_overflow then
    raise exception 'event field encoding is invalid' using errcode = '22023';
  end;

  if v_schema_version is distinct from '1.0'
     or v_external_event_id is null
     or v_source is null
     or v_platform is null
     or v_event_type is null
     or v_payload is null or jsonb_typeof(v_payload) <> 'object'
     or (v_actor is not null and jsonb_typeof(v_actor) <> 'object')
     or v_occurred_at is null or v_received_at is null then
    raise exception 'event fields are invalid' using errcode = '22023';
  end if;

  select e.* into v_existing
  from byeollog_automation.events e
  where e.workspace_id = p_workspace_id
    and e.source = v_source
    and e.external_event_id = v_external_event_id
  for update;

  if found then
    if v_existing.schema_version is distinct from v_schema_version
       or v_existing.platform is distinct from v_platform
       or v_existing.event_type is distinct from v_event_type
       or v_existing.subtype is distinct from v_subtype
       or v_existing.actor is distinct from v_actor
       or v_existing.amount is distinct from v_amount
       or v_existing.currency is distinct from v_currency
       or v_existing.payload is distinct from v_payload
       or v_existing.raw is distinct from v_raw
       or v_existing.correlation_id is distinct from v_correlation_id
       or v_existing.occurred_at is distinct from v_occurred_at then
      raise exception 'duplicate event identity has different content' using errcode = 'BLP01';
    end if;

    select coalesce(array_agg(x.id order by x.id), '{}'::uuid[])
      into v_queued_ids
    from byeollog_automation.executions x
    where x.event_id = v_existing.id;

    return jsonb_build_object(
      'eventId', v_existing.id,
      'duplicate', true,
      'matchedRuleIds', to_jsonb(v_existing.matched_rule_ids),
      'queuedExecutionIds', to_jsonb(v_queued_ids)
    );
  end if;

  if array_position(p_evaluated_rule_ids, null) is not null
     or array_position(p_matched_rule_ids, null) is not null
     or array_position(p_rule_action_ids, null) is not null then
    raise exception 'event plan identifiers cannot contain null' using errcode = '22023';
  end if;

  v_evaluated := byeollog_automation.normalized_uuid_array_v1(p_evaluated_rule_ids);
  v_matched := byeollog_automation.normalized_uuid_array_v1(p_matched_rule_ids);
  v_actions := byeollog_automation.normalized_uuid_array_v1(p_rule_action_ids);
  if cardinality(v_evaluated) <> cardinality(coalesce(p_evaluated_rule_ids, '{}'::uuid[]))
     or cardinality(v_matched) <> cardinality(coalesce(p_matched_rule_ids, '{}'::uuid[]))
     or cardinality(v_actions) <> cardinality(coalesce(p_rule_action_ids, '{}'::uuid[])) then
    raise exception 'event plan identifiers must be unique' using errcode = '22023';
  end if;

  v_plan := byeollog_automation.current_plan_v1(p_workspace_id);
  v_current_token := encode(
    extensions.digest(pg_catalog.convert_to(v_plan::text, 'UTF8'), 'sha256'),
    'hex'
  );
  if v_current_token <> p_plan_token then
    raise exception 'automation plan changed during evaluation' using errcode = 'BLP02';
  end if;

  select coalesce(array_agg(r.id order by r.id), '{}'::uuid[])
    into v_expected_rules
  from byeollog_automation.rules r
  where r.workspace_id = p_workspace_id and r.enabled;
  if v_evaluated <> v_expected_rules then
    raise exception 'evaluated rule universe is incomplete' using errcode = '22023';
  end if;

  if exists (
    select 1 from unnest(v_matched) as m(id)
    where not (m.id = any(v_evaluated))
  ) then
    raise exception 'matched rule is outside the evaluated universe' using errcode = '22023';
  end if;

  select coalesce(array_agg(a.id order by a.id), '{}'::uuid[])
    into v_expected_actions
  from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id = a.rule_id
  where r.workspace_id = p_workspace_id and a.rule_id = any(v_matched);
  if v_actions <> v_expected_actions then
    raise exception 'matched action universe is incomplete' using errcode = '22023';
  end if;

  insert into byeollog_automation.events(
    workspace_id,
    schema_version,
    external_event_id,
    source,
    platform,
    event_type,
    subtype,
    actor,
    amount,
    currency,
    payload,
    raw,
    correlation_id,
    occurred_at,
    received_at,
    authorized_user_id,
    plan_token,
    evaluated_rule_ids,
    matched_rule_ids
  ) values (
    p_workspace_id,
    v_schema_version,
    v_external_event_id,
    v_source,
    v_platform,
    v_event_type,
    v_subtype,
    v_actor,
    v_amount,
    v_currency,
    v_payload,
    v_raw,
    v_correlation_id,
    v_occurred_at,
    v_received_at,
    p_authorized_user_id,
    v_current_token,
    v_evaluated,
    v_matched
  )
  on conflict (workspace_id, source, external_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select e.* into v_existing
    from byeollog_automation.events e
    where e.workspace_id = p_workspace_id
      and e.source = v_source
      and e.external_event_id = v_external_event_id
    for update;
    if not found then
      raise exception 'event identity conflict could not be resolved' using errcode = 'BLP02';
    end if;
    if v_existing.schema_version is distinct from v_schema_version
       or v_existing.platform is distinct from v_platform
       or v_existing.event_type is distinct from v_event_type
       or v_existing.subtype is distinct from v_subtype
       or v_existing.actor is distinct from v_actor
       or v_existing.amount is distinct from v_amount
       or v_existing.currency is distinct from v_currency
       or v_existing.payload is distinct from v_payload
       or v_existing.raw is distinct from v_raw
       or v_existing.correlation_id is distinct from v_correlation_id
       or v_existing.occurred_at is distinct from v_occurred_at then
      raise exception 'duplicate event identity has different content' using errcode = 'BLP01';
    end if;
    select coalesce(array_agg(x.id order by x.id), '{}'::uuid[])
      into v_queued_ids
    from byeollog_automation.executions x
    where x.event_id = v_existing.id;
    return jsonb_build_object(
      'eventId', v_existing.id,
      'duplicate', true,
      'matchedRuleIds', to_jsonb(v_existing.matched_rule_ids),
      'queuedExecutionIds', to_jsonb(v_queued_ids)
    );
  end if;

  insert into byeollog_automation.executions(
    workspace_id,
    event_id,
    rule_id,
    action_id,
    idempotency_key,
    execution_target,
    agent_device_id,
    action_type,
    action_params,
    timeout_ms,
    max_attempts,
    retry_backoff_seconds
  )
  select
    p_workspace_id,
    v_event_id,
    r.id,
    a.id,
    encode(extensions.digest(
      concat_ws('|', p_workspace_id::text, v_source, v_external_event_id, a.id::text, v_current_token),
      'sha256'
    ), 'hex'),
    a.execution_target,
    a.agent_device_id,
    a.action_type,
    a.params,
    a.timeout_ms,
    a.max_attempts,
    a.retry_backoff_seconds
  from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id = a.rule_id
  where r.workspace_id = p_workspace_id and a.id = any(v_actions)
  order by r.priority desc, r.id, a.position, a.id;

  select coalesce(array_agg(x.id order by x.created_at, x.id), '{}'::uuid[])
    into v_queued_ids
  from byeollog_automation.executions x
  where x.event_id = v_event_id;

  return jsonb_build_object(
    'eventId', v_event_id,
    'duplicate', false,
    'matchedRuleIds', to_jsonb(v_matched),
    'queuedExecutionIds', to_jsonb(v_queued_ids)
  );
end;
$$;

create function byeollog_automation.assert_agent_device_locked_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_device byeollog_automation.agent_devices%rowtype;
  v_hash bytea;
begin
  if p_workspace_id is null or p_device_id is null
     or p_device_secret_hash is null or p_device_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'agent authentication failed' using errcode = '28000';
  end if;
  v_hash := decode(p_device_secret_hash, 'hex');

  select d.* into v_device
  from byeollog_automation.agent_devices d
  where d.workspace_id = p_workspace_id and d.device_id = p_device_id
  for update;

  if not found or v_device.revoked_at is not null
     or not coalesce(
       v_device.secret_hash = v_hash
       or (
         v_device.previous_secret_hash = v_hash
         and v_device.previous_secret_valid_until > clock_timestamp()
       ),
       false
     ) then
    raise exception 'agent authentication failed' using errcode = '28000';
  end if;
end;
$$;

create function public.g3a_claim_execution_v1(
  p_workspace_id uuid,
  p_worker_id text,
  p_lease_seconds integer,
  p_execution_ids uuid[],
  p_execution_target text,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_supported_action_types text[],
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns table (
  execution_id uuid,
  idempotency_key text,
  workspace_id uuid,
  event_id uuid,
  execution_target text,
  agent_device_id uuid,
  action_type text,
  action_params jsonb,
  timeout_ms integer,
  attempt_no integer,
  max_attempts integer,
  retry_backoff_seconds integer,
  lease_expires_at timestamptz
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_execution byeollog_automation.executions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_supported text[];
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9:._-]{1,200}$'
     or p_lease_seconds is null or p_lease_seconds not between 5 and 600
     or p_execution_target is null or p_execution_target not in ('server','local_agent')
     or cardinality(coalesce(p_execution_ids, '{}'::uuid[])) > 20
     or array_position(p_execution_ids, null) is not null then
    raise exception 'execution claim parameters are invalid' using errcode = '22023';
  end if;

  if p_execution_target = 'server' then
    if p_runtime_component not in ('event_runtime','execution_worker')
       or p_agent_device_id is not null or p_agent_secret_hash is not null
       or p_supported_action_types is not null then
      raise exception 'server execution context is invalid' using errcode = '22023';
    end if;
  else
    if p_runtime_component <> 'agent_runtime'
       or p_agent_device_id is null or p_agent_secret_hash is null
       or cardinality(coalesce(p_supported_action_types, '{}'::text[])) not between 1 and 32
       or exists (
         select 1 from unnest(p_supported_action_types) as a(value)
         where a.value is null or a.value !~ '^[a-z][a-z0-9_.-]{0,119}$'
       ) then
      raise exception 'agent execution context is invalid' using errcode = '22023';
    end if;
    select array_agg(distinct a.value order by a.value)
      into v_supported
    from unnest(p_supported_action_types) as a(value);
    if cardinality(v_supported) <> cardinality(p_supported_action_types) then
      raise exception 'supported action types must be unique' using errcode = '22023';
    end if;
    perform byeollog_automation.assert_agent_device_locked_v1(
      p_workspace_id,
      p_agent_device_id,
      p_agent_secret_hash
    );
    perform 1
    from byeollog_automation.agent_device_status s
    where s.workspace_id = p_workspace_id
      and s.device_id = p_agent_device_id
      and s.reported_at > v_now - interval '5 minutes'
      and s.supported_action_types @> v_supported
      and v_supported @> s.supported_action_types
    for share;
    if not found then
      raise exception 'fresh exact agent capability report is required' using errcode = '55000';
    end if;
  end if;

  update byeollog_automation.executions e
  set status = 'failed',
      lease_owner = null,
      lease_expires_at = null,
      last_error = 'execution lease expired after final attempt',
      finished_at = v_now
  where e.workspace_id = p_workspace_id
    and e.execution_target = p_execution_target
    and e.status = 'running'
    and e.lease_expires_at <= v_now
    and e.attempt_no >= e.max_attempts;

  select e.* into v_execution
  from byeollog_automation.executions e
  where e.workspace_id = p_workspace_id
    and e.execution_target = p_execution_target
    and (
      (e.status in ('queued','retry_scheduled') and e.next_attempt_at <= v_now)
      or (e.status = 'running' and e.lease_expires_at <= v_now)
    )
    and e.attempt_no < e.max_attempts
    and (p_execution_ids is null or e.id = any(p_execution_ids))
    and (
      p_execution_target = 'server'
      or (
        (e.agent_device_id is null or e.agent_device_id = p_agent_device_id)
        and e.action_type = any(v_supported)
      )
    )
  order by e.next_attempt_at, e.created_at, e.id
  for update skip locked
  limit 1;

  if not found then
    return;
  end if;

  update byeollog_automation.executions e
  set status = 'running',
      attempt_no = e.attempt_no + 1,
      lease_owner = p_worker_id,
      lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
      agent_device_id = case
        when e.execution_target = 'local_agent' then coalesce(e.agent_device_id, p_agent_device_id)
        else null
      end,
      started_at = coalesce(e.started_at, v_now),
      last_error = null
  where e.id = v_execution.id
  returning e.* into v_execution;

  if p_execution_target = 'local_agent' then
    update byeollog_automation.agent_devices d
    set last_seen_at = v_now,
        previous_secret_hash = case
          when d.previous_secret_valid_until <= v_now then null
          else d.previous_secret_hash
        end,
        previous_secret_valid_until = case
          when d.previous_secret_valid_until <= v_now then null
          else d.previous_secret_valid_until
        end
    where d.workspace_id = p_workspace_id and d.device_id = p_agent_device_id;
  end if;

  return query select
    v_execution.id,
    v_execution.idempotency_key,
    v_execution.workspace_id,
    v_execution.event_id,
    v_execution.execution_target,
    v_execution.agent_device_id,
    v_execution.action_type,
    v_execution.action_params,
    v_execution.timeout_ms,
    v_execution.attempt_no,
    v_execution.max_attempts,
    v_execution.retry_backoff_seconds,
    v_execution.lease_expires_at;
end;
$$;

create function public.g3a_renew_execution_v1(
  p_workspace_id uuid,
  p_execution_id uuid,
  p_worker_id text,
  p_attempt_no integer,
  p_lease_seconds integer,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
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
  v_execution byeollog_automation.executions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_new_expiry timestamptz;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_execution_id is null
     or p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9:._-]{1,200}$'
     or p_attempt_no is null or p_attempt_no < 1
     or p_lease_seconds is null or p_lease_seconds not between 5 and 600 then
    raise exception 'execution renewal parameters are invalid' using errcode = '22023';
  end if;

  if p_runtime_component = 'agent_runtime' then
    perform byeollog_automation.assert_agent_device_locked_v1(
      p_workspace_id,
      p_agent_device_id,
      p_agent_secret_hash
    );
  elsif p_runtime_component in ('event_runtime','execution_worker') then
    if p_agent_device_id is not null or p_agent_secret_hash is not null then
      raise exception 'server execution context is invalid' using errcode = '22023';
    end if;
  else
    raise exception 'execution runtime component is invalid' using errcode = '22023';
  end if;

  select e.* into v_execution
  from byeollog_automation.executions e
  where e.id = p_execution_id and e.workspace_id = p_workspace_id
  for update;
  if not found or v_execution.status <> 'running'
     or v_execution.lease_owner <> p_worker_id
     or v_execution.attempt_no <> p_attempt_no
     or v_execution.lease_expires_at <= v_now then
    raise exception 'execution lease was lost' using errcode = '55000';
  end if;

  if v_execution.execution_target = 'local_agent' then
    if p_runtime_component <> 'agent_runtime'
       or p_agent_device_id is distinct from v_execution.agent_device_id then
      raise exception 'agent execution context is invalid' using errcode = '22023';
    end if;
  elsif p_runtime_component not in ('event_runtime','execution_worker')
        then
    raise exception 'server execution context is invalid' using errcode = '22023';
  end if;

  v_new_expiry := v_now + make_interval(secs => p_lease_seconds);
  update byeollog_automation.executions e
  set lease_expires_at = v_new_expiry
  where e.id = p_execution_id;
  return v_new_expiry;
end;
$$;

create function public.g3a_finish_execution_v1(
  p_workspace_id uuid,
  p_execution_id uuid,
  p_worker_id text,
  p_attempt_no integer,
  p_succeeded boolean,
  p_result jsonb,
  p_error text,
  p_retryable boolean,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns table (
  execution_id uuid,
  status text,
  attempt_no integer,
  next_attempt_at timestamptz,
  terminal boolean
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_execution byeollog_automation.executions%rowtype;
  v_now timestamptz := clock_timestamp();
  v_status text;
  v_next timestamptz;
  v_terminal boolean;
  v_delay_seconds integer;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_execution_id is null
     or p_worker_id is null or p_worker_id !~ '^[A-Za-z0-9:._-]{1,200}$'
     or p_attempt_no is null or p_attempt_no < 1
     or p_succeeded is null or p_retryable is null
     or (p_succeeded and p_retryable)
     or (p_succeeded and p_error is not null)
     or (not p_succeeded and p_result is not null)
     or (p_result is not null and jsonb_typeof(p_result) <> 'object')
     or char_length(coalesce(p_error, '')) > 2000 then
    raise exception 'execution finish parameters are invalid' using errcode = '22023';
  end if;

  if p_runtime_component = 'agent_runtime' then
    perform byeollog_automation.assert_agent_device_locked_v1(
      p_workspace_id,
      p_agent_device_id,
      p_agent_secret_hash
    );
  elsif p_runtime_component in ('event_runtime','execution_worker') then
    if p_agent_device_id is not null or p_agent_secret_hash is not null then
      raise exception 'server execution context is invalid' using errcode = '22023';
    end if;
  else
    raise exception 'execution runtime component is invalid' using errcode = '22023';
  end if;

  select e.* into v_execution
  from byeollog_automation.executions e
  where e.id = p_execution_id and e.workspace_id = p_workspace_id
  for update;
  if not found or v_execution.status <> 'running'
     or v_execution.lease_owner <> p_worker_id
     or v_execution.attempt_no <> p_attempt_no
     or v_execution.lease_expires_at <= v_now then
    raise exception 'execution lease was lost' using errcode = '55000';
  end if;

  if v_execution.execution_target = 'local_agent' then
    if p_runtime_component <> 'agent_runtime'
       or p_agent_device_id is distinct from v_execution.agent_device_id then
      raise exception 'agent execution context is invalid' using errcode = '22023';
    end if;
  elsif p_runtime_component not in ('event_runtime','execution_worker')
        then
    raise exception 'server execution context is invalid' using errcode = '22023';
  end if;

  if p_succeeded then
    v_status := 'succeeded';
    v_next := v_now;
    v_terminal := true;
  elsif p_retryable and v_execution.attempt_no < v_execution.max_attempts then
    v_delay_seconds := least(
      86400,
      (v_execution.retry_backoff_seconds * power(2, greatest(0, v_execution.attempt_no - 1)))::integer
    );
    v_status := 'retry_scheduled';
    v_next := v_now + make_interval(secs => v_delay_seconds);
    v_terminal := false;
  else
    v_status := 'failed';
    v_next := v_now;
    v_terminal := true;
  end if;

  update byeollog_automation.executions e
  set status = v_status,
      next_attempt_at = v_next,
      lease_owner = null,
      lease_expires_at = null,
      result = case when p_succeeded then p_result else null end,
      last_error = case when p_succeeded then null else nullif(p_error, '') end,
      finished_at = case when v_terminal then v_now else null end
  where e.id = p_execution_id;

  return query select
    p_execution_id,
    v_status,
    p_attempt_no,
    v_next,
    v_terminal;
end;
$$;

create function public.g3a_register_agent_device_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_name text,
  p_device_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_authenticated_at bigint,
  p_authentication_method text,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns table (
  created boolean,
  registered_at timestamptz
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_now_epoch bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_hash bytea;
  v_existing byeollog_automation.agent_devices%rowtype;
  v_registered_at timestamptz;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_runtime_component <> 'agent_runtime'
     or p_device_id is null
     or p_device_name is null or char_length(btrim(p_device_name)) not between 1 and 120
     or p_device_secret_hash is null or p_device_secret_hash !~ '^[0-9a-f]{64}$'
     or p_authenticated_at is null
     or p_authenticated_at < v_now_epoch - 600
     or p_authenticated_at > v_now_epoch + 60
     or p_authentication_method is null or p_authentication_method not in (
       'password','otp','totp','magiclink','oauth','sso/saml',
       'oauth_provider/authorization_code'
     ) then
    raise exception 'recent interactive authentication is required' using errcode = 'BL101';
  end if;

  v_hash := decode(p_device_secret_hash, 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('g3a-agent-registration:' || p_workspace_id::text, 3100)
  );

  select d.* into v_existing
  from byeollog_automation.agent_devices d
  where d.workspace_id = p_workspace_id and d.device_id = p_device_id
  for update;

  if found then
    if v_existing.revoked_at is not null or v_existing.secret_hash <> v_hash then
      raise exception 'agent authentication failed' using errcode = '28000';
    end if;
    return query select false, v_existing.registered_at;
    return;
  end if;

  if exists (
    select 1
    from byeollog_automation.agent_devices d
    where d.registration_session_id = p_session_id
  ) then
    raise exception 'authentication session already registered an agent' using errcode = 'BL102';
  end if;

  if (
    select count(*)
    from byeollog_automation.agent_devices d
    where d.workspace_id = p_workspace_id and d.revoked_at is null
  ) >= 5 then
    raise exception 'active agent device limit reached' using errcode = 'BL103';
  end if;

  insert into byeollog_automation.agent_devices(
    workspace_id,
    device_id,
    device_name,
    secret_hash,
    created_by_user_id,
    registration_session_id,
    registered_at,
    secret_rotated_at
  ) values (
    p_workspace_id,
    p_device_id,
    btrim(p_device_name),
    v_hash,
    p_authorized_user_id,
    p_session_id,
    v_now,
    v_now
  )
  returning agent_devices.registered_at into v_registered_at;

  return query select true, v_registered_at;
end;
$$;

create function public.g3a_rotate_agent_device_secret_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_current_secret_hash text,
  p_new_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns table (
  secret_revision bigint,
  rotated_at timestamptz,
  previous_valid_until timestamptz
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_current bytea;
  v_new bytea;
  v_device byeollog_automation.agent_devices%rowtype;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_runtime_component <> 'agent_runtime'
     or p_device_id is null
     or p_current_secret_hash is null or p_current_secret_hash !~ '^[0-9a-f]{64}$'
     or p_new_secret_hash is null or p_new_secret_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'agent secret rotation parameters are invalid' using errcode = '22023';
  end if;

  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,
    p_device_id,
    p_current_secret_hash
  );
  v_current := decode(p_current_secret_hash, 'hex');
  v_new := decode(p_new_secret_hash, 'hex');

  select d.* into v_device
  from byeollog_automation.agent_devices d
  where d.workspace_id = p_workspace_id and d.device_id = p_device_id
  for update;

  if v_device.secret_hash = v_new
     and v_device.previous_secret_hash = v_current
     and v_device.previous_secret_valid_until > v_now then
    return query select
      v_device.secret_revision,
      v_device.secret_rotated_at,
      v_device.previous_secret_valid_until;
    return;
  end if;

  if v_device.secret_hash <> v_current then
    raise exception 'agent authentication failed' using errcode = '28000';
  end if;
  if v_current = v_new then
    return query select
      v_device.secret_revision,
      v_device.secret_rotated_at,
      v_device.previous_secret_valid_until;
    return;
  end if;

  update byeollog_automation.agent_devices d
  set previous_secret_hash = d.secret_hash,
      previous_secret_valid_until = v_now + interval '10 minutes',
      secret_hash = v_new,
      secret_revision = d.secret_revision + 1,
      secret_rotated_at = v_now,
      last_seen_at = v_now
  where d.workspace_id = p_workspace_id and d.device_id = p_device_id
  returning d.* into v_device;

  return query select
    v_device.secret_revision,
    v_device.secret_rotated_at,
    v_device.previous_secret_valid_until;
end;
$$;

create function public.g3a_report_agent_status_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text,
  p_agent_version text,
  p_platform text,
  p_supported_action_types text[],
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
  v_supported text[];
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_runtime_component <> 'agent_runtime'
     or p_agent_version is null or p_agent_version !~ '^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$'
     or p_platform is null or p_platform not in ('windows','linux','macos','unknown')
     or cardinality(coalesce(p_supported_action_types, '{}'::text[])) not between 1 and 32
     or exists (
       select 1 from unnest(p_supported_action_types) as a(value)
       where a.value is null or a.value !~ '^[a-z][a-z0-9_.-]{0,119}$'
     ) then
    raise exception 'agent status parameters are invalid' using errcode = '22023';
  end if;

  select array_agg(distinct a.value order by a.value)
    into v_supported
  from unnest(p_supported_action_types) as a(value);
  if cardinality(v_supported) <> cardinality(p_supported_action_types) then
    raise exception 'supported action types must be unique' using errcode = '22023';
  end if;

  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash
  );

  insert into byeollog_automation.agent_device_status(
    workspace_id,
    device_id,
    agent_version,
    platform,
    supported_action_types,
    reported_at
  ) values (
    p_workspace_id,
    p_device_id,
    p_agent_version,
    p_platform,
    v_supported,
    v_now
  )
  on conflict (workspace_id, device_id) do update
  set agent_version = excluded.agent_version,
      platform = excluded.platform,
      supported_action_types = excluded.supported_action_types,
      reported_at = excluded.reported_at;

  update byeollog_automation.agent_devices d
  set last_seen_at = v_now,
      previous_secret_hash = case
        when d.previous_secret_valid_until <= v_now then null
        else d.previous_secret_hash
      end,
      previous_secret_valid_until = case
        when d.previous_secret_valid_until <= v_now then null
        else d.previous_secret_valid_until
      end
  where d.workspace_id = p_workspace_id and d.device_id = p_device_id;

  return v_now;
end;
$$;

create function byeollog_automation.guard_rule_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_workspace_id uuid;
  v_rule_id uuid;
  v_release_enabled boolean;
begin
  select g.enabled into v_release_enabled
  from byeollog_automation.release_gate g
  where g.gate_id = 1
  for share;
  if not found or v_release_enabled then
    raise exception 'rules can change only while the global runtime gate is disabled'
      using errcode = '55000';
  end if;

  if tg_table_name = 'rules' then
    if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
      raise exception 'rule workspace identity is immutable' using errcode = '22023';
    end if;
    v_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  else
    if tg_op = 'UPDATE' and new.rule_id is distinct from old.rule_id then
      raise exception 'rule child identity is immutable' using errcode = '22023';
    end if;
    v_rule_id := case when tg_op = 'DELETE' then old.rule_id else new.rule_id end;
    select r.workspace_id into v_workspace_id
    from byeollog_automation.rules r
    where r.id = v_rule_id;
    -- A cascaded child delete already holds the parent rule's advisory lock.
    if not found and tg_op <> 'DELETE' then
      raise exception 'rule parent is missing' using errcode = '23503';
    end if;
  end if;

  if v_workspace_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('g3a-rule-plan:' || v_workspace_id::text, 3200)
    );
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger g3a_rules_mutation_guard
before insert or update or delete on byeollog_automation.rules
for each row execute function byeollog_automation.guard_rule_mutation_v1();

create trigger g3a_rule_conditions_mutation_guard
before insert or update or delete on byeollog_automation.rule_conditions
for each row execute function byeollog_automation.guard_rule_mutation_v1();

create trigger g3a_rule_actions_mutation_guard
before insert or update or delete on byeollog_automation.rule_actions
for each row execute function byeollog_automation.guard_rule_mutation_v1();

revoke all on all tables in schema byeollog_automation
  from public, anon, authenticated, service_role;
revoke all on all sequences in schema byeollog_automation
  from public, anon, authenticated, service_role;
revoke all on all functions in schema byeollog_automation
  from public, anon, authenticated, service_role;

revoke execute on function public.g3a_assert_active_auth_session_v1(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.g3a_assert_runtime_active_v1(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.g3a_automation_schema_readiness_v1(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.g3a_load_automation_plan_v1(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke execute on function public.g3a_commit_event_plan_v1(
  uuid, jsonb, uuid, uuid, text, text, text, text, uuid[], uuid[], uuid[]
) from public, anon, authenticated;
revoke execute on function public.g3a_claim_execution_v1(
  uuid, text, integer, uuid[], text, uuid, text, text[], uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke execute on function public.g3a_renew_execution_v1(
  uuid, uuid, text, integer, integer, uuid, text, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke execute on function public.g3a_finish_execution_v1(
  uuid, uuid, text, integer, boolean, jsonb, text, boolean, uuid, text,
  uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke execute on function public.g3a_register_agent_device_v1(
  uuid, uuid, text, text, uuid, uuid, bigint, text, text, text, text
) from public, anon, authenticated;
revoke execute on function public.g3a_rotate_agent_device_secret_v1(
  uuid, uuid, text, text, uuid, uuid, text, text, text
) from public, anon, authenticated;
revoke execute on function public.g3a_report_agent_status_v1(
  uuid, uuid, text, text, text, text[], uuid, uuid, text, text, text
) from public, anon, authenticated;

grant execute on function public.g3a_assert_active_auth_session_v1(uuid, uuid)
  to service_role;
grant execute on function public.g3a_assert_runtime_active_v1(uuid, uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.g3a_automation_schema_readiness_v1(uuid, uuid)
  to service_role;
grant execute on function public.g3a_load_automation_plan_v1(uuid, uuid, uuid, text, text, text)
  to service_role;
grant execute on function public.g3a_commit_event_plan_v1(
  uuid, jsonb, uuid, uuid, text, text, text, text, uuid[], uuid[], uuid[]
) to service_role;
grant execute on function public.g3a_claim_execution_v1(
  uuid, text, integer, uuid[], text, uuid, text, text[], uuid, uuid, text, text, text
) to service_role;
grant execute on function public.g3a_renew_execution_v1(
  uuid, uuid, text, integer, integer, uuid, text, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.g3a_finish_execution_v1(
  uuid, uuid, text, integer, boolean, jsonb, text, boolean, uuid, text,
  uuid, uuid, text, text, text
) to service_role;
grant execute on function public.g3a_register_agent_device_v1(
  uuid, uuid, text, text, uuid, uuid, bigint, text, text, text, text
) to service_role;
grant execute on function public.g3a_rotate_agent_device_secret_v1(
  uuid, uuid, text, text, uuid, uuid, text, text, text
) to service_role;
grant execute on function public.g3a_report_agent_status_v1(
  uuid, uuid, text, text, text, text[], uuid, uuid, text, text, text
) to service_role;

comment on function public.g3a_assert_runtime_active_v1(uuid, uuid, uuid, text, text, text)
  is 'G3A service-only early fail-closed check. Every mutation independently repeats this lock boundary.';
comment on function public.g3a_automation_schema_readiness_v1(uuid, uuid)
  is 'G3A service-only additive negotiation receipt; returns one row and never enables a gate.';

do $$
declare
  v_function oid;
begin
  if (select g.enabled from byeollog_automation.release_gate g where g.gate_id = 1)
     or exists (select 1 from byeollog_automation.workspace_gates) then
    raise exception 'G3A_PF20: installation must remain globally OFF with no workspace enrollment';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class r on r.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = r.relnamespace
    where n.nspname = 'byeollog_automation'
      and (
        (r.relname = 'release_gate' and c.conname = 'release_gate_g3a_install_dormant')
        or (r.relname = 'workspace_gates' and c.conname = 'workspace_gate_g3a_install_dormant')
      )
      and c.contype = 'c'
      and c.convalidated
      and pg_catalog.pg_get_constraintdef(c.oid, true) ~* 'not enabled'
  ) <> 2 then
    raise exception 'G3A_PF20A: dormant activation seals are missing or invalid';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class r on r.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = r.relnamespace
    join pg_catalog.pg_class target on target.oid = c.confrelid
    join pg_catalog.pg_namespace target_n on target_n.oid = target.relnamespace
    where n.nspname = 'byeollog_automation'
      and c.contype = 'f'
      and target_n.nspname = 'public'
      and (target.relname like 'byeollog\_%' escape '\'
           or target.relname like 'bangsel\_%' escape '\')
  ) then
    raise exception 'G3A_PF21: candidate FK points at a legacy table';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class r on r.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = r.relnamespace
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    join pg_catalog.pg_namespace fn on fn.oid = p.pronamespace
    where n.nspname = 'public'
      and (r.relname like 'byeollog\_%' escape '\'
           or r.relname like 'bangsel\_%' escape '\')
      and fn.nspname = 'byeollog_automation'
  ) then
    raise exception 'G3A_PF22: candidate trigger is attached to a legacy table';
  end if;

  for v_function in
    select p.oid
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'g3a\_%' escape '\'
  loop
    if pg_catalog.has_function_privilege('anon', v_function, 'EXECUTE')
       or pg_catalog.has_function_privilege('authenticated', v_function, 'EXECUTE')
       or not pg_catalog.has_function_privilege('service_role', v_function, 'EXECUTE')
       or exists (
         select 1
         from pg_catalog.pg_proc p
         cross join lateral pg_catalog.aclexplode(
           coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
         ) acl
         where p.oid = v_function
           and acl.privilege_type = 'EXECUTE'
           and acl.grantee <> p.proowner
           and acl.grantee <> (
             select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role'
           )
       ) then
      raise exception 'G3A_PF23: public RPC ACL is not service-role-only';
    end if;
  end loop;

  if pg_catalog.has_schema_privilege('service_role', 'byeollog_automation', 'USAGE')
     or pg_catalog.has_schema_privilege('anon', 'byeollog_automation', 'USAGE')
     or pg_catalog.has_schema_privilege('authenticated', 'byeollog_automation', 'USAGE') then
    raise exception 'G3A_PF24: internal schema is exposed to an API role';
  end if;
end;
$$;

commit;
;
