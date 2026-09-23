-- Operational telemetry only. No donation, roulette, Agent or backup writes.
create table private.ops_monitor_v1 (
  singleton boolean primary key default true check(singleton),
  token_sha256 text not null check(token_sha256 ~ '^[a-f0-9]{64}$'),
  last_seen_at timestamptz,
  incident_id uuid,
  usage_at timestamptz,
  usage jsonb not null default '{}'::jsonb
);
create table private.ops_alert_delivery_v1 (
  id bigint generated always as identity primary key,
  source_key text not null unique check(length(source_key)<=160),
  topic text not null check(length(topic)<=100),
  message text not null check(length(message)<=1500),
  created_at timestamptz not null default clock_timestamp(),
  request_id bigint,
  attempted_at timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default clock_timestamp(),
  delivered_at timestamptz,
  exhausted boolean not null default false,
  last_status integer
);
create index ops_alert_delivery_due_v1 on private.ops_alert_delivery_v1(next_attempt_at)
 where delivered_at is null and not exhausted;
create index ops_alert_delivery_topic_v1 on private.ops_alert_delivery_v1(topic,created_at desc);
alter table private.ops_monitor_v1 enable row level security;
alter table private.ops_alert_delivery_v1 enable row level security;
revoke all on private.ops_monitor_v1,private.ops_alert_delivery_v1 from public,anon,authenticated,service_role;
revoke all on sequence private.ops_alert_delivery_v1_id_seq from public,anon,authenticated,service_role;

create function private.ops_enqueue_alert_v1(p_key text,p_topic text,p_message text)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_id bigint;
begin
 -- At most one alert of the same kind every fifteen minutes, including flaps.
 if exists(select 1 from private.ops_alert_delivery_v1 where topic=p_topic and created_at>clock_timestamp()-interval '15 minutes') then return null;end if;
 insert into private.ops_alert_delivery_v1(source_key,topic,message)
 values(p_key,p_topic,p_message) on conflict(source_key) do nothing returning id into v_id;
 return v_id;
end $$;
revoke all on function private.ops_enqueue_alert_v1(text,text,text) from public,anon,authenticated,service_role;

create or replace function private.notify_soop_gateway_incident_v1(p_event text,p_incident_id uuid,p_workspace_id uuid,p_observed_at timestamptz)
returns bigint language plpgsql security definer set search_path='' as $$
declare v_tag text:=substr(md5(p_workspace_id::text),1,12);
begin
 if p_event not in ('opened','resolved') then return null;end if;
 perform private.ops_enqueue_alert_v1('gateway:'||p_incident_id||':'||p_event,'gateway:'||v_tag||':'||p_event,
   case when p_event='opened' then '[별록 장애] 수집 연결 상태가 허용 시간을 초과했습니다.' else '[별록 복구] 수집 연결 상태가 복구되었습니다.' end
   ||' 계정 태그='||v_tag||' / 감지='||p_observed_at::text);
 -- This is now queued, not an HTTP request yet. Never mislabel an outbox ID.
 return null;
exception when others then return null;
end $$;
revoke all on function private.notify_soop_gateway_incident_v1(text,uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create function private.ops_alert_tick_v1()
returns void language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare r record; v_url text; v_request bigint; v_now timestamptz:=clock_timestamp(); v_incident uuid;
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
  where d.delivered_at is null and not d.exhausted and d.next_attempt_at<=v_now order by d.next_attempt_at limit 5 for update of d skip locked loop
  if r.status_code between 200 and 299 and not coalesce(r.timed_out,false) then
   update private.ops_alert_delivery_v1 set delivered_at=v_now,last_status=r.status_code where id=r.id;continue;
  end if;
  if r.attempts>=12 or r.created_at<v_now-interval '24 hours' or r.status_code in (401,403,404) then
   update private.ops_alert_delivery_v1 set exhausted=true,last_status=r.status_code where id=r.id;continue;
  end if;
  -- Request results are allowed two minutes to arrive. Retry at most five per tick.
  if r.request_id is not null and r.status_code is null and r.attempted_at>v_now-interval '2 minutes' then continue;end if;
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
end $$;
revoke all on function private.ops_alert_tick_v1() from public,anon,authenticated,service_role;

create function public.byeollog_ops_observe_v1(p_token text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='500ms' as $$
declare v_config private.ops_monitor_v1%rowtype; v_now timestamptz:=clock_timestamp();v_usage jsonb;v_live integer;v_pending integer;v_retry integer;
begin
 -- Machine authentication: a dedicated 256-bit token, never a DB admin key.
 if p_token is null or length(p_token)<>64 or p_token !~ '^[a-f0-9]{64}$' then raise exception 'Unauthorized' using errcode='42501';end if;
 select * into v_config from private.ops_monitor_v1 where singleton and token_sha256=encode(extensions.digest(p_token,'sha256'),'hex');
 if not found then raise exception 'Unauthorized' using errcode='42501';end if;
 if not pg_try_advisory_xact_lock(70909061434) then
  return jsonb_build_object('ok',true,'sampledAt',v_config.last_seen_at,'throttled',true,'usage',v_config.usage);
 end if;
 -- A valid token cannot turn this into a high-frequency stats scan.
 if v_config.last_seen_at>v_now-interval '30 seconds' then
  return jsonb_build_object('ok',true,'sampledAt',v_config.last_seen_at,'throttled',true,'usage',v_config.usage);
 end if;
 v_usage:=v_config.usage;
 if v_config.usage_at is null or v_config.usage_at<v_now-interval '1 hour' then
  select jsonb_build_object('sampledAt',v_now,'databaseBytes',pg_database_size(current_database()),
   'storageBytes',coalesce((select sum(case when metadata->>'size' ~ '^[0-9]{1,18}$' then (metadata->>'size')::bigint else 0 end) from storage.objects),0),
   'donationInserts',coalesce((select n_tup_ins from pg_stat_all_tables where schemaname='public' and relname='bangsel_donations'),0),
   'dbStatsReset',(select stats_reset from pg_stat_database where datname=current_database()),
   'dbTransactions',(select xact_commit+xact_rollback from pg_stat_database where datname=current_database())) into v_usage;
 end if;
 select count(*) into v_live from public.byeollog_soop_gateway_sessions s join public.byeollog_soop_runtime_controls c using(workspace_id)
 where c.gateway_enabled and s.state='connected' and s.heartbeat_at>v_now-interval '90 seconds';
 -- Bound scan using the existing workspace/target partial index. Old/offline
 -- user-paused work is excluded to avoid false outage alerts.
 select count(*) filter(where status='queued'),count(*) filter(where status='retry_scheduled') into v_pending,v_retry from (
  select e.status from public.byeollog_soop_gateway_sessions s
  join public.byeollog_soop_runtime_controls c using(workspace_id)
  cross join lateral (select e.status from byeollog_automation.executions e where e.workspace_id=s.workspace_id and e.execution_target='local_agent'
   and e.status in ('queued','retry_scheduled','running') and e.created_at between v_now-interval '1 hour' and v_now-interval '5 minutes'
   and e.next_attempt_at<=v_now limit 1000) e
  where c.gateway_enabled and s.state='connected' and s.heartbeat_at>v_now-interval '90 seconds'
 ) x;
 update private.ops_monitor_v1 set last_seen_at=v_now,usage=v_usage,usage_at=(v_usage->>'sampledAt')::timestamptz where singleton;
 return jsonb_build_object('ok',true,'sampledAt',v_now,'liveChannels',v_live,'queuedActions5m',v_pending,'retryActions5m',v_retry,
  'exhaustedAlerts',(select count(*) from private.ops_alert_delivery_v1 where exhausted and created_at>v_now-interval '24 hours'),'usage',v_usage);
end $$;
revoke all on function public.byeollog_ops_observe_v1(text) from public,anon,authenticated,service_role;
grant execute on function public.byeollog_ops_observe_v1(text) to anon,service_role;
comment on function public.byeollog_ops_observe_v1(text) is 'Dedicated machine-token-authenticated aggregate telemetry. No donor/chat identifiers or business writes. Fails closed before metrics access.';

select cron.schedule('byeollog-ops-alert-delivery-v1','* * * * *','select private.ops_alert_tick_v1()');


