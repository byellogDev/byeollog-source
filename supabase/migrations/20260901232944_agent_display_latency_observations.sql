-- Privacy-preserving Agent display latency telemetry.
--
-- The Browser Source reports only a display kind and a non-PII correlation
-- identity after the first painted frame.  Reporting is deliberately outside
-- the donation/action hot path: a missing metric can never block an action or
-- wallpaper update.  Raw observations are retained for 14 days.

create table private.agent_display_observations_v1 (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  device_id uuid not null,
  observation_kind text not null check (
    observation_kind in ('action_first_frame','wallpaper_ready')
  ),
  execution_id uuid,
  wallpaper_revision bigint,
  source_created_at timestamptz not null,
  agent_observed_at timestamptz not null,
  server_received_at timestamptz not null default clock_timestamp(),
  local_latency_ms integer not null check (local_latency_ms between 0 and 120000),
  end_to_end_ms integer not null check (end_to_end_ms between 0 and 3600000),
  check (
    (observation_kind='action_first_frame' and execution_id is not null and wallpaper_revision is null)
    or
    (observation_kind='wallpaper_ready' and execution_id is null and wallpaper_revision is not null and wallpaper_revision>=0)
  )
)

alter table private.agent_display_observations_v1 enable row level security

revoke all on table private.agent_display_observations_v1
  from public,anon,authenticated,service_role

create unique index agent_display_observations_action_once_idx
  on private.agent_display_observations_v1(device_id,execution_id)
  where observation_kind='action_first_frame'

create unique index agent_display_observations_wallpaper_once_idx
  on private.agent_display_observations_v1(device_id,wallpaper_revision)
  where observation_kind='wallpaper_ready'

create index agent_display_observations_workspace_time_idx
  on private.agent_display_observations_v1(workspace_id,server_received_at desc)

create or replace function public.g3a_agent_direct_display_observation_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text,
  p_observation_kind text,
  p_execution_id uuid,
  p_wallpaper_revision bigint,
  p_agent_observed_at timestamptz,
  p_local_latency_ms integer
)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_source_created_at timestamptz;
  v_received_at timestamptz := clock_timestamp();
  v_end_to_end_ms integer;
begin
  perform 1
  from byeollog_automation.agent_direct_runtime_context_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash
  );

  -- PC clocks are not authoritative. Keep a broad corruption bound, while the
  -- reported local duration itself is monotonic and tightly bounded below.
  if p_agent_observed_at is null
     or p_agent_observed_at < v_received_at-interval '1 day'
     or p_agent_observed_at > v_received_at+interval '1 day'
     or p_local_latency_ms is null
     or p_local_latency_ms not between 0 and 120000 then
    raise exception 'agent display observation parameters are invalid' using errcode='22023';
  end if;

  if p_observation_kind='action_first_frame' then
    if p_execution_id is null or p_wallpaper_revision is not null then
      raise exception 'action display observation identity is invalid' using errcode='22023';
    end if;
    select execution.created_at into v_source_created_at
    from byeollog_automation.executions execution
    where execution.id=p_execution_id
      and execution.workspace_id=p_workspace_id
      and execution.execution_target='local_agent'
      and execution.agent_device_id=p_device_id;
  elsif p_observation_kind='wallpaper_ready' then
    if p_execution_id is not null or p_wallpaper_revision is null or p_wallpaper_revision<0 then
      raise exception 'wallpaper display observation identity is invalid' using errcode='22023';
    end if;
    select overlay.updated_at into v_source_created_at
    from public.byeollog_wallpaper_overlay_states overlay
    where overlay.workspace_id=p_workspace_id
      and overlay.revision=p_wallpaper_revision;
  else
    raise exception 'agent display observation kind is invalid' using errcode='22023';
  end if;

  if v_source_created_at is null then
    return false;
  end if;

  v_end_to_end_ms := greatest(0,least(3600000,
    round(extract(epoch from (v_received_at-v_source_created_at))*1000)::integer));

  insert into private.agent_display_observations_v1(
    workspace_id,device_id,observation_kind,execution_id,wallpaper_revision,
    source_created_at,agent_observed_at,server_received_at,local_latency_ms,end_to_end_ms
  ) values (
    p_workspace_id,p_device_id,p_observation_kind,p_execution_id,p_wallpaper_revision,
    v_source_created_at,p_agent_observed_at,v_received_at,p_local_latency_ms,v_end_to_end_ms
  )
  on conflict do nothing;
  return true;
end
$function$

revoke all on function public.g3a_agent_direct_display_observation_v1(
  uuid,uuid,text,text,uuid,bigint,timestamptz,integer
) from public,anon,authenticated

grant execute on function public.g3a_agent_direct_display_observation_v1(
  uuid,uuid,text,text,uuid,bigint,timestamptz,integer
) to authenticated

create or replace function private.expire_agent_display_observations_v1(
  p_batch_limit integer default 500
)
returns integer
language plpgsql
security definer
set search_path = ''
set lock_timeout = '1s'
set statement_timeout = '5s'
as $function$
declare
  v_deleted integer;
begin
  if p_batch_limit not between 1 and 5000 then
    raise exception 'display observation retention batch is invalid' using errcode='22023';
  end if;
  with candidates as (
    select observation.id
    from private.agent_display_observations_v1 observation
    where observation.server_received_at < clock_timestamp()-interval '14 days'
    order by observation.server_received_at,observation.id
    limit p_batch_limit
  )
  delete from private.agent_display_observations_v1 observation
  using candidates
  where observation.id=candidates.id;
  get diagnostics v_deleted=row_count;
  return v_deleted;
end
$function$

revoke all on function private.expire_agent_display_observations_v1(integer)
  from public,anon,authenticated,service_role

select cron.schedule(
  'byeollog-agent-display-observation-retention-v1',
  '11,26,41,56 * * * *',
  $$select private.expire_agent_display_observations_v1(500)$$
)

comment on table private.agent_display_observations_v1 is
  'Non-PII first-frame and wallpaper-ready latency samples retained for 14 days.'

comment on function public.g3a_agent_direct_display_observation_v1(
  uuid,uuid,text,text,uuid,bigint,timestamptz,integer
) is 'Authenticated, best-effort Agent display telemetry; never part of the action or wallpaper hot path.'
