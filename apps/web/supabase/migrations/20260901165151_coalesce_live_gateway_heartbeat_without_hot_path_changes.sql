-- Coalesce unchanged connected heartbeats to one per minute. Donation events,
-- action wake/claim, local outbox flush, and state-transition reports remain
-- event-driven and are intentionally outside this policy.
--
-- The connected incident threshold allows two missed 60-second reports plus
-- one 30-second cron boundary, avoiding false alerts without weakening local
-- supervisor recovery. Offline states retain the existing ten-minute limit.

create or replace function private.check_soop_gateway_heartbeats_v1()
returns void
language plpgsql
security definer
set search_path='private','public','pg_catalog'
as $$
declare
  v_now timestamptz:=clock_timestamp();
  v_row record;
  v_request_id bigint;
begin
  for v_row in
    with health as (
      select control.workspace_id,session.heartbeat_at,session.state,
        case when session.state='connected' then 150 else 600 end as threshold_seconds
      from public.byeollog_soop_runtime_controls control
      left join public.byeollog_soop_gateway_sessions session
        on session.workspace_id=control.workspace_id
      where control.gateway_enabled
    ), stale as (
      select workspace_id,heartbeat_at,state,threshold_seconds
      from health
      where heartbeat_at is null
        or heartbeat_at<v_now-pg_catalog.make_interval(secs=>threshold_seconds)
    ), opened as (
      insert into public.byeollog_soop_gateway_incidents(
        workspace_id,last_observed_at,last_heartbeat_at,last_reported_state,details)
      select workspace_id,v_now,heartbeat_at,state,
        jsonb_build_object('thresholdSeconds',threshold_seconds)
      from stale
      on conflict (workspace_id,kind) where resolved_at is null
      do update set
        last_observed_at=excluded.last_observed_at,
        last_heartbeat_at=excluded.last_heartbeat_at,
        last_reported_state=excluded.last_reported_state,
        details=excluded.details
      returning id,workspace_id,(xmax=0) as newly_opened
    ) select * from opened where newly_opened
  loop
    v_request_id:=private.notify_soop_gateway_incident_v1(
      'opened',v_row.id,v_row.workspace_id,v_now);
    update public.byeollog_soop_gateway_incidents
    set open_notification_request_id=v_request_id where id=v_row.id;
  end loop;

  for v_row in
    with healthy as (
      select control.workspace_id
      from public.byeollog_soop_runtime_controls control
      left join public.byeollog_soop_gateway_sessions session
        on session.workspace_id=control.workspace_id
      where not control.gateway_enabled
        or (
          session.workspace_id is not null
          and session.heartbeat_at>=v_now-pg_catalog.make_interval(
            secs=>case when session.state='connected' then 150 else 600 end)
        )
    )
    update public.byeollog_soop_gateway_incidents incident
    set resolved_at=v_now,last_observed_at=v_now
    from healthy
    where incident.workspace_id=healthy.workspace_id
      and incident.resolved_at is null
      and incident.kind='heartbeat_stale'
    returning incident.id,incident.workspace_id
  loop
    v_request_id:=private.notify_soop_gateway_incident_v1(
      'resolved',v_row.id,v_row.workspace_id,v_now);
    update public.byeollog_soop_gateway_incidents
    set resolved_notification_request_id=v_request_id where id=v_row.id;
  end loop;
end;
$$;

revoke all on function private.check_soop_gateway_heartbeats_v1()
  from public,anon,authenticated,service_role;

comment on function private.check_soop_gateway_heartbeats_v1() is
  'Opens a heartbeat incident after 150 seconds while connected or ten minutes while idle/offline.';
