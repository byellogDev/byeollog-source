-- Keep live donation/action monitoring strict while allowing the local SOOP
-- worker to coalesce idle/offline heartbeats. Connected sessions still open
-- an incident after 45 seconds; non-live states use a ten-minute threshold.

create or replace function private.notify_soop_gateway_incident_v1(
  p_event text,
  p_incident_id uuid,
  p_workspace_id uuid,
  p_observed_at timestamptz
)
returns bigint
language plpgsql
security definer
set search_path='private','public','vault','net','pg_catalog'
as $$
declare
  v_url text;
  v_token text;
  v_request_id bigint;
  v_workspace_tag text:=substr(md5(p_workspace_id::text),1,12);
  v_message text;
begin
  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name='soop_gateway_alert_webhook_url'
  order by created_at desc limit 1;
  if coalesce(v_url,'')!~'^https://[^[:space:]]+$' then return null; end if;
  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where name='soop_gateway_alert_webhook_token'
  order by created_at desc limit 1;
  v_message:=case when p_event='opened'
    then format('[별록] SOOP 게이트웨이 하트비트가 상태별 허용 시간을 초과했습니다. workspace=%s',v_workspace_tag)
    else format('[별록] SOOP 게이트웨이 하트비트가 복구되었습니다. workspace=%s',v_workspace_tag)
  end;
  select net.http_post(
    url:=v_url,
    headers:=jsonb_strip_nulls(jsonb_build_object(
      'Content-Type','application/json',
      'Authorization',case when coalesce(v_token,'')='' then null else 'Bearer '||v_token end)),
    body:=jsonb_build_object(
      'text',v_message,'content',v_message,
      'event','soop_gateway_heartbeat_'||p_event,
      'incidentId',p_incident_id,'workspaceTag',v_workspace_tag,
      'observedAt',p_observed_at),
    timeout_milliseconds:=5000
  ) into v_request_id;
  return v_request_id;
exception when others then
  return null;
end;
$$;

revoke all on function private.notify_soop_gateway_incident_v1(
  text,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

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
        case when session.state='connected' then 45 else 600 end as threshold_seconds
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
            secs=>case when session.state='connected' then 45 else 600 end)
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
  'Opens a heartbeat incident after 45 seconds while connected or ten minutes while idle/offline.';
