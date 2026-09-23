-- SOOP Chat SDK gateway readiness and observability.
--
-- This migration is additive and deliberately keeps every live execution gate
-- disabled. Browser roles receive no table privileges or RLS policies; only
-- trusted server/gateway processes using the service role can access rows.

create table if not exists public.byeollog_soop_runtime_controls (
  workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,
  gateway_enabled boolean not null default false,
  native_roulette_enabled boolean not null default false,
  synthetic_test_enabled boolean not null default true,
  live_diagnostics_enabled boolean not null default true,
  updated_by_user_id uuid,
  updated_at timestamptz not null default clock_timestamp(),
  check (not native_roulette_enabled or gateway_enabled)
);

create table if not exists public.byeollog_soop_gateway_sessions (
  workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,
  instance_id text not null,
  state text not null,
  generation bigint not null default 0,
  reconnect_count integer not null default 0,
  last_sequence bigint not null default 0,
  chat_number bigint,
  token_expires_at timestamptz,
  connected_at timestamptz,
  last_event_at timestamptz,
  heartbeat_at timestamptz not null,
  last_error_code text,
  updated_at timestamptz not null default clock_timestamp(),
  check (char_length(instance_id) between 8 and 160 and instance_id!~'[[:cntrl:]]'),
  check (state in ('idle','connecting','waiting_for_live','connected','retry_wait','reauthorization_required','stopped')),
  check (generation>=0),
  check (reconnect_count between 0 and 2147483647),
  check (last_sequence>=0),
  check (chat_number is null or chat_number>0),
  check (last_error_code is null or (char_length(last_error_code) between 1 and 120 and last_error_code~'^[a-z0-9_:-]+$'))
);

create index if not exists byeollog_soop_gateway_sessions_health_idx
  on public.byeollog_soop_gateway_sessions(state,heartbeat_at desc);

create table if not exists public.byeollog_soop_event_observations (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  event_fingerprint text not null,
  event_type text not null,
  provider_occurred_at timestamptz not null,
  gateway_received_at timestamptz not null,
  server_received_at timestamptz not null default clock_timestamp(),
  normalized_at timestamptz,
  roulette_committed_at timestamptz,
  overlay_queued_at timestamptz,
  tts_queued_at timestamptz,
  action_queued_at timestamptz,
  deduplicated boolean not null default false,
  outcome text not null default 'received',
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,event_fingerprint),
  check (event_fingerprint~'^[0-9a-f]{64}$'),
  check (event_type in ('donation','chat','synthetic_donation','synthetic_chat')),
  check (outcome in ('received','duplicate','ignored','correlated','committed','dispatched','failed')),
  check (jsonb_typeof(details)='object' and octet_length(details::text)<=16384),
  check (gateway_received_at>=provider_occurred_at-interval '2 minutes'),
  check (server_received_at>=gateway_received_at-interval '2 minutes')
);

create index if not exists byeollog_soop_event_observations_workspace_time_idx
  on public.byeollog_soop_event_observations(workspace_id,server_received_at desc);
create index if not exists byeollog_soop_event_observations_failures_idx
  on public.byeollog_soop_event_observations(workspace_id,server_received_at desc)
  where outcome='failed';

create table if not exists public.byeollog_soop_diagnostic_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  requested_by_user_id uuid,
  mode text not null,
  status text not null,
  current_stage text not null,
  metrics jsonb not null default '{}'::jsonb,
  last_error_code text,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (mode in ('offline','live','synthetic_e2e')),
  check (status in ('queued','running','waiting_for_live','passed','failed')),
  check (current_stage in ('oauth','token','broadcast','sdk','event','roulette','overlay','tts','action','complete')),
  check (jsonb_typeof(metrics)='object' and octet_length(metrics::text)<=16384),
  check (last_error_code is null or (char_length(last_error_code) between 1 and 120 and last_error_code~'^[a-z0-9_:-]+$')),
  check ((status in ('passed','failed'))=(finished_at is not null))
);

create index if not exists byeollog_soop_diagnostic_runs_workspace_time_idx
  on public.byeollog_soop_diagnostic_runs(workspace_id,created_at desc);

alter table public.byeollog_soop_runtime_controls enable row level security;
alter table public.byeollog_soop_gateway_sessions enable row level security;
alter table public.byeollog_soop_event_observations enable row level security;
alter table public.byeollog_soop_diagnostic_runs enable row level security;

revoke all on table public.byeollog_soop_runtime_controls from public,anon,authenticated,service_role;
revoke all on table public.byeollog_soop_gateway_sessions from public,anon,authenticated,service_role;
revoke all on table public.byeollog_soop_event_observations from public,anon,authenticated,service_role;
revoke all on table public.byeollog_soop_diagnostic_runs from public,anon,authenticated,service_role;

grant select,insert,update,delete on table public.byeollog_soop_runtime_controls to service_role;
grant select,insert,update,delete on table public.byeollog_soop_gateway_sessions to service_role;
grant select,insert,update,delete on table public.byeollog_soop_event_observations to service_role;
grant select,insert,update,delete on table public.byeollog_soop_diagnostic_runs to service_role;

insert into public.byeollog_soop_runtime_controls(workspace_id)
select connection.workspace_id from public.byeollog_soop_connections connection
on conflict(workspace_id) do nothing;

create or replace function public.ensure_soop_runtime_controls_v1()
returns trigger
language plpgsql
security definer
set search_path='public','pg_catalog'
as $$
begin
  insert into public.byeollog_soop_runtime_controls(workspace_id)
  values(new.workspace_id)
  on conflict(workspace_id) do nothing;
  return new;
end;
$$;

revoke all on function public.ensure_soop_runtime_controls_v1() from public,anon,authenticated,service_role;

drop trigger if exists ensure_soop_runtime_controls_v1 on public.byeollog_soop_connections;
create trigger ensure_soop_runtime_controls_v1
after insert or update of workspace_id on public.byeollog_soop_connections
for each row execute function public.ensure_soop_runtime_controls_v1();
