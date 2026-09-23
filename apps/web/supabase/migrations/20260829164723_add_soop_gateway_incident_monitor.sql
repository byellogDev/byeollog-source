-- Persistent SOOP gateway incident monitor.
-- A 30-second database-side check opens an incident after 45 seconds without a
-- heartbeat and resolves it automatically when the gateway becomes healthy.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create table if not exists public.byeollog_soop_gateway_incidents (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  kind text not null default 'heartbeat_stale',
  opened_at timestamptz not null default clock_timestamp(),
  last_observed_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  last_heartbeat_at timestamptz,
  last_reported_state text,
  details jsonb not null default '{}'::jsonb,
  open_notification_request_id bigint,
  resolved_notification_request_id bigint,
  check (kind='heartbeat_stale'),
  check (last_reported_state is null or char_length(last_reported_state) between 1 and 40),
  check (jsonb_typeof(details)='object' and pg_column_size(details)<=4096),
  check (resolved_at is null or resolved_at>=opened_at)
);

create unique index if not exists byeollog_soop_gateway_incidents_one_open_idx
  on public.byeollog_soop_gateway_incidents(workspace_id,kind)
  where resolved_at is null;
create index if not exists byeollog_soop_gateway_incidents_recent_idx
  on public.byeollog_soop_gateway_incidents(opened_at desc);

alter table public.byeollog_soop_gateway_incidents enable row level security;
revoke all on table public.byeollog_soop_gateway_incidents from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_soop_gateway_incidents to service_role;

drop policy if exists byeollog_soop_gateway_incidents_deny_browser on public.byeollog_soop_gateway_incidents;
create policy byeollog_soop_gateway_incidents_deny_browser
on public.byeollog_soop_gateway_incidents
for all to anon,authenticated
using (false)
with check (false);

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
    then format('[별록] SOOP 게이트웨이 하트비트가 45초 이상 중단되었습니다. workspace=%s',v_workspace_tag)
    else format('[별록] SOOP 게이트웨이 하트비트가 복구되었습니다. workspace=%s',v_workspace_tag)
  end;
  select net.http_post(
    url:=v_url,
    headers:=jsonb_strip_nulls(jsonb_build_object('Content-Type','application/json','Authorization',case when coalesce(v_token,'')='' then null else 'Bearer '||v_token end)),
    body:=jsonb_build_object('text',v_message,'content',v_message,'event','soop_gateway_heartbeat_'||p_event,'incidentId',p_incident_id,'workspaceTag',v_workspace_tag,'observedAt',p_observed_at),
    timeout_milliseconds:=5000
  ) into v_request_id;
  return v_request_id;
exception when others then
  return null;
end;
$$;

revoke all on function private.notify_soop_gateway_incident_v1(text,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

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
    with stale as (
      select control.workspace_id,session.heartbeat_at,session.state
      from public.byeollog_soop_runtime_controls control
      left join public.byeollog_soop_gateway_sessions session on session.workspace_id=control.workspace_id
      where control.gateway_enabled
        and (session.workspace_id is null or session.heartbeat_at<v_now-interval '45 seconds')
    ), opened as (
      insert into public.byeollog_soop_gateway_incidents(workspace_id,last_observed_at,last_heartbeat_at,last_reported_state,details)
      select workspace_id,v_now,heartbeat_at,state,jsonb_build_object('thresholdSeconds',45)
      from stale
      on conflict (workspace_id,kind) where resolved_at is null
      do update set last_observed_at=excluded.last_observed_at,last_heartbeat_at=excluded.last_heartbeat_at,last_reported_state=excluded.last_reported_state
      returning id,workspace_id,(xmax=0) as newly_opened
    ) select * from opened where newly_opened
  loop
    v_request_id:=private.notify_soop_gateway_incident_v1('opened',v_row.id,v_row.workspace_id,v_now);
    update public.byeollog_soop_gateway_incidents set open_notification_request_id=v_request_id where id=v_row.id;
  end loop;

  for v_row in
    update public.byeollog_soop_gateway_incidents incident
    set resolved_at=v_now,last_observed_at=v_now
    from public.byeollog_soop_runtime_controls control
    left join public.byeollog_soop_gateway_sessions session on session.workspace_id=control.workspace_id
    where incident.workspace_id=control.workspace_id
      and incident.resolved_at is null
      and incident.kind='heartbeat_stale'
      and (not control.gateway_enabled or (session.workspace_id is not null and session.heartbeat_at>=v_now-interval '45 seconds'))
    returning incident.id,incident.workspace_id
  loop
    v_request_id:=private.notify_soop_gateway_incident_v1('resolved',v_row.id,v_row.workspace_id,v_now);
    update public.byeollog_soop_gateway_incidents set resolved_notification_request_id=v_request_id where id=v_row.id;
  end loop;
end;
$$;

revoke all on function private.check_soop_gateway_heartbeats_v1() from public,anon,authenticated,service_role;

do $$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='byeollog-soop-gateway-heartbeat-monitor-v1'
  loop perform cron.unschedule(v_job_id); end loop;
  perform cron.schedule(
    'byeollog-soop-gateway-heartbeat-monitor-v1',
    '30 seconds',
    'select private.check_soop_gateway_heartbeats_v1()'
  );
end;
$$;

comment on table public.byeollog_soop_gateway_incidents is 'Service-only SOOP gateway heartbeat incidents. No chat or viewer content is stored.';
