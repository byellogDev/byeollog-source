-- Close operational reliability gaps without adding work to donation ingest,
-- overlay claim/finish, action claim/finish, or Agent Realtime hot paths.
set local lock_timeout='3s';
set local statement_timeout='20s';

-- Foreign-key indexes keep parent deletes and validation from scanning child
-- tables as the service grows. These columns were reported by the database
-- advisor and are intentionally separate from queue claim indexes.
create index if not exists native_roulette_chat_buffer_v2_consumed_event_workspace_idx
  on byeollog_automation.native_roulette_chat_buffer_v2(consumed_event_id,workspace_id);
create index if not exists native_roulette_overlay_outbox_v2_event_workspace_idx
  on byeollog_automation.native_roulette_overlay_outbox_v2(event_id,workspace_id);
create index if not exists native_roulette_revisions_overlay_asset_key_idx
  on byeollog_automation.native_roulette_revisions(overlay_asset_key);
create index if not exists byeollog_soop_connections_connected_by_user_idx
  on public.byeollog_soop_connections(connected_by_user_id);
create index if not exists byeollog_soop_runtime_controls_experiment_draft_idx
  on public.byeollog_soop_runtime_controls(overlay_experiment_draft_id);

-- Rows whose delivery contract has already expired cannot be displayed by an
-- Agent. Mark them terminal instead of leaving them as false queue pressure.
update byeollog_automation.native_roulette_overlay_outbox_v2
set status='failed',
    processed_at=coalesce(processed_at,clock_timestamp()),
    client_id=null,
    lease_expires_at=null,
    last_error=coalesce(nullif(last_error,''),'expired_before_delivery')
where status in ('pending','processing')
  and expires_at < clock_timestamp()
  and (status='pending' or lease_expires_at is null or lease_expires_at < clock_timestamp());

create or replace function private.expire_stale_native_overlay_v1(
  p_batch_limit integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='100ms'
set statement_timeout='1000ms'
as $function$
declare
  v_limit integer := least(greatest(coalesce(p_batch_limit,500),1),1000);
  v_expired bigint := 0;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog:expire-stale-native-overlay:v1',0)
  ) then
    return jsonb_build_object('ok',true,'skipped','already_running');
  end if;

  with candidates as (
    select outbox.id
    from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.status in ('pending','processing')
      and outbox.expires_at < clock_timestamp()
      and (outbox.status='pending' or outbox.lease_expires_at is null
        or outbox.lease_expires_at < clock_timestamp())
    order by outbox.expires_at,outbox.id
    limit v_limit
    for update skip locked
  ), updated as (
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    set status='failed',processed_at=coalesce(outbox.processed_at,clock_timestamp()),
        client_id=null,lease_expires_at=null,
        last_error=coalesce(nullif(outbox.last_error,''),'expired_before_delivery')
    from candidates
    where outbox.id=candidates.id
    returning 1
  )
  select count(*) into v_expired from updated;

  return jsonb_build_object('ok',true,'expired',v_expired,'batchLimit',v_limit);
end
$function$;

revoke all on function private.expire_stale_native_overlay_v1(integer)
  from public,anon,authenticated,service_role;

comment on function private.expire_stale_native_overlay_v1(integer) is
  'Bounded asynchronous cleanup for overlay rows that are already impossible to deliver.';

do $schedule$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job
  where jobname='byeollog-expire-stale-native-overlay-v1';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
  perform cron.schedule(
    'byeollog-expire-stale-native-overlay-v1',
    '3,18,33,48 * * * *',
    $cron$select private.expire_stale_native_overlay_v1(500)$cron$
  );
end
$schedule$;

-- The archival table only receives rows after the 14-day raw retention
-- boundary. This view combines archived history with the current raw window,
-- so SLO checks work from the first live event without changing ingest.
create or replace view private.soop_event_observation_daily_live_v1
with (security_invoker=true)
as
with combined as (
  select daily.observed_on,daily.workspace_id,daily.event_type,daily.outcome,
    daily.event_count,daily.deduplicated_count,
    daily.gateway_to_server_ms_sum,daily.gateway_to_server_ms_max,
    daily.server_to_overlay_ms_sum,daily.server_to_overlay_count,daily.server_to_overlay_ms_max,
    daily.server_to_action_ms_sum,daily.server_to_action_count,daily.server_to_action_ms_max,
    daily.first_observed_at,daily.last_observed_at
  from private.soop_event_observation_daily_v1 daily
  union all
  select
    (observation.server_received_at at time zone 'Asia/Seoul')::date,
    observation.workspace_id,observation.event_type,observation.outcome,
    count(*)::bigint,
    count(*) filter(where observation.deduplicated)::bigint,
    sum(greatest(0,round(extract(epoch from (observation.server_received_at-observation.gateway_received_at))*1000)::bigint))::bigint,
    max(greatest(0,round(extract(epoch from (observation.server_received_at-observation.gateway_received_at))*1000)::integer))::integer,
    coalesce(sum(greatest(0,round(extract(epoch from (observation.overlay_queued_at-observation.server_received_at))*1000)::bigint)) filter(where observation.overlay_queued_at is not null),0)::bigint,
    count(*) filter(where observation.overlay_queued_at is not null)::bigint,
    coalesce(max(greatest(0,round(extract(epoch from (observation.overlay_queued_at-observation.server_received_at))*1000)::integer)) filter(where observation.overlay_queued_at is not null),0)::integer,
    coalesce(sum(greatest(0,round(extract(epoch from (observation.action_queued_at-observation.server_received_at))*1000)::bigint)) filter(where observation.action_queued_at is not null),0)::bigint,
    count(*) filter(where observation.action_queued_at is not null)::bigint,
    coalesce(max(greatest(0,round(extract(epoch from (observation.action_queued_at-observation.server_received_at))*1000)::integer)) filter(where observation.action_queued_at is not null),0)::integer,
    min(observation.server_received_at),max(observation.server_received_at)
  from public.byeollog_soop_event_observations observation
  group by 1,2,3,4
)
select observed_on,workspace_id,event_type,outcome,
  sum(event_count)::bigint as event_count,
  sum(deduplicated_count)::bigint as deduplicated_count,
  sum(gateway_to_server_ms_sum)::bigint as gateway_to_server_ms_sum,
  max(gateway_to_server_ms_max)::integer as gateway_to_server_ms_max,
  sum(server_to_overlay_ms_sum)::bigint as server_to_overlay_ms_sum,
  sum(server_to_overlay_count)::bigint as server_to_overlay_count,
  max(server_to_overlay_ms_max)::integer as server_to_overlay_ms_max,
  sum(server_to_action_ms_sum)::bigint as server_to_action_ms_sum,
  sum(server_to_action_count)::bigint as server_to_action_count,
  max(server_to_action_ms_max)::integer as server_to_action_ms_max,
  min(first_observed_at) as first_observed_at,
  max(last_observed_at) as last_observed_at
from combined
group by observed_on,workspace_id,event_type,outcome;

revoke all on table private.soop_event_observation_daily_live_v1
  from public,anon,authenticated,service_role;

comment on view private.soop_event_observation_daily_live_v1 is
  'On-demand SLO view over both the current raw window and exactly-once archived daily history.';

-- These public SECURITY DEFINER compatibility versions have no callers in the
-- current web or Agent release. Remove their executable surface while keeping
-- the latest v16/v6 APIs intact.
do $revoke$
declare target record;
begin
  for target in
    select procedure.oid
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public'
      and procedure.proname in (
        'save_guided_rule_v11','save_guided_rule_v12','save_guided_rule_v13',
        'save_guided_rule_v14','save_guided_rule_v15',
        'dispatch_guided_rule_test_v2','dispatch_guided_rule_test_v3',
        'dispatch_guided_rule_test_v4','dispatch_guided_rule_test_v5'
      )
  loop
    execute pg_catalog.format(
      'revoke all on function %s from public,anon,authenticated,service_role',
      target.oid::regprocedure
    );
  end loop;
end
$revoke$;


