-- Bound diagnostic and delivery working sets without touching donation ingest,
-- overlay claim/finish, or action claim/finish functions. Maintenance is
-- intentionally asynchronous, lock-bounded, and batch-bounded.

create table if not exists private.soop_event_observation_daily_v1 (
  observed_on date not null,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  event_type text not null,
  outcome text not null,
  event_count bigint not null default 0 check (event_count >= 0),
  deduplicated_count bigint not null default 0 check (deduplicated_count >= 0),
  gateway_to_server_ms_sum bigint not null default 0 check (gateway_to_server_ms_sum >= 0),
  gateway_to_server_ms_max integer not null default 0 check (gateway_to_server_ms_max >= 0),
  server_to_overlay_ms_sum bigint not null default 0 check (server_to_overlay_ms_sum >= 0),
  server_to_overlay_count bigint not null default 0 check (server_to_overlay_count >= 0),
  server_to_overlay_ms_max integer not null default 0 check (server_to_overlay_ms_max >= 0),
  server_to_action_ms_sum bigint not null default 0 check (server_to_action_ms_sum >= 0),
  server_to_action_count bigint not null default 0 check (server_to_action_count >= 0),
  server_to_action_ms_max integer not null default 0 check (server_to_action_ms_max >= 0),
  first_observed_at timestamptz not null,
  last_observed_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (observed_on,workspace_id,event_type,outcome)
);

alter table private.soop_event_observation_daily_v1 enable row level security;
create index if not exists soop_event_observation_daily_v1_workspace_day_idx
  on private.soop_event_observation_daily_v1(workspace_id,observed_on desc);
revoke all on table private.soop_event_observation_daily_v1
  from public,anon,authenticated,service_role;

comment on table private.soop_event_observation_daily_v1 is
  'Long-lived daily diagnostics aggregated exactly once from raw SOOP event observations immediately before retention deletion.';

create or replace function private.run_operational_retention_v1(
  p_batch_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='100ms'
set statement_timeout='1500ms'
as $function$
declare
  v_batch_limit integer := least(greatest(coalesce(p_batch_limit,500),1),1000);
  v_workspace_id uuid;
  v_observations bigint := 0;
  v_chat_buffer bigint := 0;
  v_chat_waits bigint := 0;
  v_outbox bigint := 0;
  v_executions bigint := 0;
  v_cron_runs bigint := 0;
begin
  -- Avoid overlapping maintenance transactions. Returning quickly is safer
  -- than waiting while a prior bounded batch finishes.
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog:operational-retention:v1',0)
  ) then
    return jsonb_build_object('ok',true,'skipped','already_running');
  end if;

  -- Raw observations remain available for 14 days. Pick one workspace through
  -- the existing (workspace_id, server_received_at) index so no hot-path index
  -- is added to every event insert. DELETE RETURNING + aggregate upsert makes
  -- archiving exactly-once within this transaction.
  select candidate.workspace_id
  into v_workspace_id
  from public.byeollog_workspaces workspace
  cross join lateral (
    select observation.workspace_id,observation.server_received_at
    from public.byeollog_soop_event_observations observation
    where observation.workspace_id=workspace.id
      and observation.server_received_at < clock_timestamp()-interval '14 days'
    order by observation.server_received_at
    limit 1
  ) candidate
  order by candidate.server_received_at,candidate.workspace_id
  limit 1;

  if v_workspace_id is not null then
    with candidates as (
      select observation.id
      from public.byeollog_soop_event_observations observation
      where observation.workspace_id=v_workspace_id
        and observation.server_received_at < clock_timestamp()-interval '14 days'
      order by observation.server_received_at,observation.id
      limit v_batch_limit
      for update skip locked
    ), deleted as (
      delete from public.byeollog_soop_event_observations observation
      using candidates
      where observation.id=candidates.id
      returning observation.*
    ), aggregated as (
      select
        (server_received_at at time zone 'Asia/Seoul')::date as observed_on,
        workspace_id,event_type,outcome,
        count(*)::bigint as event_count,
        count(*) filter(where deduplicated)::bigint as deduplicated_count,
        sum(greatest(0,round(extract(epoch from (server_received_at-gateway_received_at))*1000)::bigint))::bigint as gateway_sum,
        max(greatest(0,round(extract(epoch from (server_received_at-gateway_received_at))*1000)::integer))::integer as gateway_max,
        coalesce(sum(greatest(0,round(extract(epoch from (overlay_queued_at-server_received_at))*1000)::bigint)) filter(where overlay_queued_at is not null),0)::bigint as overlay_sum,
        count(*) filter(where overlay_queued_at is not null)::bigint as overlay_count,
        coalesce(max(greatest(0,round(extract(epoch from (overlay_queued_at-server_received_at))*1000)::integer)) filter(where overlay_queued_at is not null),0)::integer as overlay_max,
        coalesce(sum(greatest(0,round(extract(epoch from (action_queued_at-server_received_at))*1000)::bigint)) filter(where action_queued_at is not null),0)::bigint as action_sum,
        count(*) filter(where action_queued_at is not null)::bigint as action_count,
        coalesce(max(greatest(0,round(extract(epoch from (action_queued_at-server_received_at))*1000)::integer)) filter(where action_queued_at is not null),0)::integer as action_max,
        min(server_received_at) as first_observed_at,
        max(server_received_at) as last_observed_at
      from deleted
      group by 1,2,3,4
    ), archived as (
      insert into private.soop_event_observation_daily_v1 as daily (
        observed_on,workspace_id,event_type,outcome,event_count,deduplicated_count,
        gateway_to_server_ms_sum,gateway_to_server_ms_max,
        server_to_overlay_ms_sum,server_to_overlay_count,server_to_overlay_ms_max,
        server_to_action_ms_sum,server_to_action_count,server_to_action_ms_max,
        first_observed_at,last_observed_at,updated_at
      )
      select observed_on,workspace_id,event_type,outcome,event_count,deduplicated_count,
        gateway_sum,gateway_max,overlay_sum,overlay_count,overlay_max,
        action_sum,action_count,action_max,first_observed_at,last_observed_at,
        clock_timestamp()
      from aggregated
      on conflict (observed_on,workspace_id,event_type,outcome) do update set
        event_count=daily.event_count+excluded.event_count,
        deduplicated_count=daily.deduplicated_count+excluded.deduplicated_count,
        gateway_to_server_ms_sum=daily.gateway_to_server_ms_sum+excluded.gateway_to_server_ms_sum,
        gateway_to_server_ms_max=greatest(daily.gateway_to_server_ms_max,excluded.gateway_to_server_ms_max),
        server_to_overlay_ms_sum=daily.server_to_overlay_ms_sum+excluded.server_to_overlay_ms_sum,
        server_to_overlay_count=daily.server_to_overlay_count+excluded.server_to_overlay_count,
        server_to_overlay_ms_max=greatest(daily.server_to_overlay_ms_max,excluded.server_to_overlay_ms_max),
        server_to_action_ms_sum=daily.server_to_action_ms_sum+excluded.server_to_action_ms_sum,
        server_to_action_count=daily.server_to_action_count+excluded.server_to_action_count,
        server_to_action_ms_max=greatest(daily.server_to_action_ms_max,excluded.server_to_action_ms_max),
        first_observed_at=least(daily.first_observed_at,excluded.first_observed_at),
        last_observed_at=greatest(daily.last_observed_at,excluded.last_observed_at),
        updated_at=clock_timestamp()
      returning event_count
    )
    select coalesce(sum(event_count),0) into v_observations from archived;
  end if;

  -- Chat correlation is only valid for a 15-second window. Ten minutes leaves
  -- ample allowance for relay delay while preventing this transient buffer
  -- from becoming the largest table again.
  with candidates as (
    select buffer.ctid
    from byeollog_automation.native_roulette_chat_buffer_v2 buffer
    where buffer.received_at < clock_timestamp()-interval '10 minutes'
    order by buffer.received_at
    limit v_batch_limit
    for update skip locked
  ), deleted as (
    delete from byeollog_automation.native_roulette_chat_buffer_v2 buffer
    using candidates
    where buffer.ctid=candidates.ctid
    returning 1
  )
  select count(*) into v_chat_buffer from deleted;

  with candidates as (
    select wait.ctid
    from byeollog_automation.native_roulette_chat_waits_v2 wait
    where wait.expires_at < clock_timestamp()-interval '1 day'
    order by wait.expires_at
    limit v_batch_limit
    for update skip locked
  ), deleted as (
    delete from byeollog_automation.native_roulette_chat_waits_v2 wait
    using candidates
    where wait.ctid=candidates.ctid
    returning 1
  )
  select count(*) into v_chat_waits from deleted;

  -- Never touch pending or processing delivery rows. TTS attempt rows are
  -- removed by their existing ON DELETE CASCADE only after terminal delivery
  -- records have aged seven days.
  with candidates as (
    select outbox.id
    from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.status in ('succeeded','failed')
      and coalesce(outbox.processed_at,outbox.created_at)
        < clock_timestamp()-interval '7 days'
    order by coalesce(outbox.processed_at,outbox.created_at),outbox.id
    limit v_batch_limit
    for update skip locked
  ), deleted as (
    delete from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    using candidates
    where outbox.id=candidates.id
    returning 1
  )
  select count(*) into v_outbox from deleted;

  -- Execution rows and action parameters remain permanent. Only oversized
  -- successful result payloads are summarized after 30 days; failed results
  -- and errors remain intact for diagnosis.
  with candidates as (
    select execution.id
    from byeollog_automation.executions execution
    where execution.status='succeeded'
      and execution.finished_at < clock_timestamp()-interval '30 days'
      and execution.result is not null
      and execution.result->>'compacted' is distinct from 'true'
      and pg_catalog.pg_column_size(execution.result)>4096
    order by execution.finished_at,execution.id
    limit v_batch_limit
    for update skip locked
  ), updated as (
    update byeollog_automation.executions execution
    set result=jsonb_build_object(
      'compacted',true,
      'originalBytes',pg_catalog.pg_column_size(execution.result),
      'completed',true
    )
    from candidates
    where execution.id=candidates.id
    returning 1
  )
  select count(*) into v_executions from updated;

  -- pg_cron does not prune run history itself. Keep successful runs for two
  -- days and failures for fourteen days, deleting only finished runs.
  with candidates as (
    select run.runid
    from cron.job_run_details run
    where run.end_time is not null
      and (
        (run.status='succeeded' and run.end_time < clock_timestamp()-interval '2 days')
        or (run.status is distinct from 'succeeded'
          and run.end_time < clock_timestamp()-interval '14 days')
      )
    order by run.runid
    limit v_batch_limit
    for update skip locked
  ), deleted as (
    delete from cron.job_run_details run
    using candidates
    where run.runid=candidates.runid
    returning 1
  )
  select count(*) into v_cron_runs from deleted;

  return jsonb_build_object(
    'ok',true,'batchLimit',v_batch_limit,
    'observationsArchived',v_observations,
    'chatBufferDeleted',v_chat_buffer,
    'chatWaitsDeleted',v_chat_waits,
    'terminalOutboxDeleted',v_outbox,
    'executionResultsCompacted',v_executions,
    'cronRunsDeleted',v_cron_runs
  );
end
$function$;

revoke all on function private.run_operational_retention_v1(integer)
  from public,anon,authenticated,service_role;

comment on function private.run_operational_retention_v1(integer) is
  'Bounded asynchronous retention. It is not called by donation, overlay, wallpaper, or action hot paths.';

-- Four small batches per hour provide enough drain capacity for the current
-- growth model while lock_timeout and statement_timeout protect live work.
select cron.schedule(
  'byeollog-operational-retention-v1',
  '7,22,37,52 * * * *',
  $$select private.run_operational_retention_v1(500)$$
);
