-- Initial registration grace and ordered operational notifications only.
-- Existing live/offline thresholds, customer data, transport and cron schedules stay unchanged.
create table private.soop_gateway_startup_watch_v1 (
 workspace_id uuid primary key,
 first_seen_at timestamptz not null default clock_timestamp()
);
alter table private.soop_gateway_startup_watch_v1 enable row level security;
revoke all on private.soop_gateway_startup_watch_v1 from public,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION private.check_soop_gateway_heartbeats_v1()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_row record;
  v_request_id bigint;
begin
  -- Record the first observed missing heartbeat once; settings edits cannot extend it.
  insert into private.soop_gateway_startup_watch_v1(workspace_id,first_seen_at)
    select c.workspace_id,v_now from public.byeollog_soop_runtime_controls c
    left join public.byeollog_soop_gateway_sessions s using(workspace_id)
    where c.gateway_enabled and s.heartbeat_at is null
    on conflict(workspace_id) do nothing;
  delete from private.soop_gateway_startup_watch_v1 w where not exists (
    select 1 from public.byeollog_soop_runtime_controls c
    left join public.byeollog_soop_gateway_sessions s using(workspace_id)
    where c.workspace_id=w.workspace_id and c.gateway_enabled and s.heartbeat_at is null);
  for v_row in
    with health as (
      select control.workspace_id,session.heartbeat_at,session.state,startup.first_seen_at,
        case when session.heartbeat_at is null or session.state='connected' then 150 else 600 end as threshold_seconds
      from public.byeollog_soop_runtime_controls control
      left join public.byeollog_soop_gateway_sessions session
        on session.workspace_id=control.workspace_id
      left join private.soop_gateway_startup_watch_v1 startup on startup.workspace_id=control.workspace_id
      where control.gateway_enabled
    ), stale as (
      select workspace_id,heartbeat_at,state,threshold_seconds
      from health
      where (heartbeat_at is null and first_seen_at<=v_now-interval '150 seconds')
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
$function$
;

CREATE OR REPLACE FUNCTION private.ops_enqueue_alert_v1(p_key text, p_topic text, p_message text)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_id bigint;
begin
 if p_key ~ '^(gateway|ncp):[^:]+:resolved$' then
  if not exists(select 1 from private.ops_alert_delivery_v1 where source_key=regexp_replace(p_key,':resolved$',':opened')) then return null;end if;
 else
 -- At most one alert of the same kind every fifteen minutes, including flaps.
 if exists(select 1 from private.ops_alert_delivery_v1 where topic=p_topic and created_at>clock_timestamp()-interval '15 minutes') then return null;end if;
 end if;
 insert into private.ops_alert_delivery_v1(source_key,topic,message)
 values(p_key,p_topic,p_message) on conflict(source_key) do nothing returning id into v_id;
 return v_id;
end $function$
;

CREATE OR REPLACE FUNCTION private.ops_alert_tick_v1()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare r record; v_opened private.ops_alert_delivery_v1%rowtype; v_url text; v_request bigint; v_now timestamptz:=clock_timestamp(); v_incident uuid;
begin
 if not pg_try_advisory_xact_lock(70909061433) then return;end if;
 -- A heartbeat independent of streaming detects a stopped NCP monitor/host.
 for r in select * from private.ops_monitor_v1 where last_seen_at is not null loop
  if r.last_seen_at<v_now-interval '12 minutes' and r.incident_id is null then
   v_incident:=gen_random_uuid();
   update private.ops_monitor_v1 set incident_id=v_incident where singleton;
   perform private.ops_enqueue_alert_v1('ncp:'||v_incident||':opened','ncp:opened','[별록 장애] 네이버클라우드 감시 신호가 12분 이상 도착하지 않았습니다. 서버·네트워크·감시 서비스 확인이 필요합니다.');
  elsif r.last_seen_at>=v_now-interval '6 minutes' and r.incident_id is not null then
   update private.ops_monitor_v1 set incident_id=null where singleton;
   perform private.ops_enqueue_alert_v1('ncp:'||r.incident_id||':resolved','ncp:resolved','[별록 복구] 네이버클라우드 감시 신호가 복구되었습니다.');
  end if;
 end loop;
 select decrypted_secret into v_url from vault.decrypted_secrets where name='soop_gateway_alert_webhook_url' order by created_at desc limit 1;
 if coalesce(v_url,'') !~ '^https://discord[.]com/api(/v[0-9]+)?/webhooks/[0-9]+/[A-Za-z0-9_-]+$' then return;end if;
 for r in select d.*,h.status_code,h.timed_out from private.ops_alert_delivery_v1 d left join net._http_response h on h.id=d.request_id
  where d.delivered_at is null and not d.exhausted and d.next_attempt_at<=v_now and (
    d.source_key !~ '^(gateway|ncp):[^:]+:resolved$' or d.request_id is not null
    or d.created_at<v_now-interval '24 hours'
    or not exists(select 1 from private.ops_alert_delivery_v1 o where o.source_key=regexp_replace(d.source_key,':resolved$',':opened'))
    or exists(select 1 from private.ops_alert_delivery_v1 o where o.source_key=regexp_replace(d.source_key,':resolved$',':opened') and (o.delivered_at is not null or o.exhausted))
  ) order by d.next_attempt_at,d.id limit 5 for update of d skip locked loop
  if r.status_code between 200 and 299 and not coalesce(r.timed_out,false) then
   update private.ops_alert_delivery_v1 set delivered_at=v_now,last_status=r.status_code where id=r.id;continue;
  end if;
  if r.attempts>=12 or r.created_at<v_now-interval '24 hours' or r.status_code in (401,403,404) then
   update private.ops_alert_delivery_v1 set exhausted=true,last_status=r.status_code where id=r.id;continue;
  end if;
  -- Request results are allowed two minutes to arrive. Retry at most five per tick.
  if r.request_id is not null and r.status_code is null and r.attempted_at>v_now-interval '2 minutes' then continue;end if;
  -- pg_net requests are asynchronous; enqueue ordering alone is insufficient.
  if r.source_key ~ '^(gateway|ncp):[^:]+:resolved$' then
   select * into v_opened from private.ops_alert_delivery_v1 where source_key=regexp_replace(r.source_key,':resolved$',':opened');
   if not found or v_opened.exhausted then
    update private.ops_alert_delivery_v1 set exhausted=true where id=r.id;continue;
   end if;
   if v_opened.delivered_at is null then continue;end if;
  end if;
  begin
   select net.http_post(url:=v_url||'?wait=true',headers:=jsonb_build_object('Content-Type','application/json'),
    body:=jsonb_build_object('content',r.message,'allowed_mentions',jsonb_build_object('parse',jsonb_build_array())),timeout_milliseconds:=5000) into v_request;
   update private.ops_alert_delivery_v1 set request_id=v_request,attempts=attempts+1,attempted_at=v_now,
     next_attempt_at=v_now+make_interval(secs=>greatest(120,least(900,(30*power(2,least(r.attempts,5)))::integer))),last_status=r.status_code where id=r.id;
  exception when others then
   update private.ops_alert_delivery_v1 set attempts=attempts+1,next_attempt_at=v_now+interval '5 minutes' where id=r.id;
  end;
 end loop;
 -- Only monitor-owned notification history; no customer data retention changes.
 delete from private.ops_alert_delivery_v1 where created_at<v_now-interval '14 days';
end $function$
;
revoke all on function private.check_soop_gateway_heartbeats_v1() from public,anon,authenticated,service_role;
revoke all on function private.ops_enqueue_alert_v1(text,text,text) from public,anon,authenticated,service_role;
revoke all on function private.ops_alert_tick_v1() from public,anon,authenticated,service_role;
