set local lock_timeout='2s';
create table private.ops_discord_snapshot_v1 (
 singleton boolean primary key default true check(singleton),
 received_at timestamptz not null,
 measured_at timestamptz not null,
 payload jsonb not null check(pg_column_size(payload)<=20000)
);
alter table private.ops_discord_snapshot_v1 enable row level security;
revoke all on private.ops_discord_snapshot_v1 from public,anon,authenticated,service_role;

create function public.byeollog_ops_publish_snapshot_v1(p_token text,p_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='2s' set lock_timeout='300ms' as $fn$
declare cfg private.ops_monitor_v1; clean jsonb:='{}'; k text; v jsonb; measured timestamptz; previous timestamptz; total_conn integer;active_conn integer;
begin
 if p_token is null or p_token!~'^[a-f0-9]{64}$' then raise exception 'Unauthorized' using errcode='42501';end if;
 select * into cfg from private.ops_monitor_v1 where singleton and token_sha256=encode(extensions.digest(p_token,'sha256'),'hex');
 if not found then raise exception 'Unauthorized' using errcode='42501';end if;
 if p_snapshot is null or jsonb_typeof(p_snapshot)<>'object' or pg_column_size(p_snapshot)>20000 then raise exception 'invalid snapshot' using errcode='22023';end if;
 measured:=(p_snapshot->>'at')::timestamptz;
 if measured is null or not isfinite(measured) or measured<clock_timestamp()-interval '10 minutes' or measured>clock_timestamp()+interval '30 seconds' then raise exception 'invalid measurement time' using errcode='22023';end if;
 if not pg_try_advisory_xact_lock(70910073913) then return jsonb_build_object('ok',true,'throttled',true);end if;
 select received_at into previous from private.ops_discord_snapshot_v1 where singleton;
 if previous>clock_timestamp()-interval '45 seconds' then return jsonb_build_object('ok',true,'throttled',true);end if;
 -- Fixed fields only: no IDs, paths, tokens, logs or names are stored here.
 foreach k in array array['cpuPercent','diskPercent','memoryAvailablePercent','pids','pidLimit','pidPercent','pending','oldestAgeSeconds','memoryPending','workerAgeSeconds','channelCount','channelErrors','deadLetters','corrupt','flushAgeSeconds','backupCompleted','backupTargets','backupFailed','oldestBackupAgeSeconds','supabaseStatus','supabaseLatencyMs','websiteStatus','liveChannels','queuedActions5m','retryActions5m','exhaustedAlerts'] loop
  v:=p_snapshot->'sample'->k;
  if jsonb_typeof(v)='number' and v::text ~ '^[0-9]+([.][0-9]+)?$' and (v::text)::numeric<=9007199254740991 then clean:=clean||jsonb_build_object(k,v);end if;
 end loop;
 foreach k in array array['healthAt','backupAt','lastEventAt','lastDeliveryAt','websiteCheckedAt'] loop
  v:=p_snapshot->'sample'->k;
  if jsonb_typeof(v)='string' and length(v#>>'{}')<=40 then
   begin
    if isfinite((v#>>'{}')::timestamptz) and (v#>>'{}')::timestamptz<=clock_timestamp()+interval '30 seconds' then clean:=clean||jsonb_build_object(k,(v#>>'{}')::timestamptz);end if;
   exception when invalid_datetime_format or datetime_field_overflow then null;end;
  end if;
 end loop;
 if p_snapshot->'sample'->>'container' in ('running:healthy','running:unhealthy','running:starting','running:missing','exited:missing','restarting:missing') then clean:=clean||jsonb_build_object('container',p_snapshot->'sample'->>'container');end if;
 if jsonb_typeof(p_snapshot->'bad')='array' then
  select coalesce(jsonb_agg(x),'[]') into v from jsonb_array_elements_text(p_snapshot->'bad') x where x in ('supabase','website','health_stale','backup_failed','backup_stale','cpu','db_space','storage_space','queued_actions','retry_actions','db_alert_failed','disk','memory','pids','queue','delivery_age','memory_queue','container','worker_heartbeat','quarantined_events','memory_queue_age','flush_stalled','channel_state');
 else v:='[]';end if;
 select count(*),count(*) filter(where state='active' and pid<>pg_backend_pid()) into total_conn,active_conn from pg_catalog.pg_stat_activity where datname=current_database();
 insert into private.ops_discord_snapshot_v1 values(true,clock_timestamp(),measured,jsonb_build_object('sample',clean,'bad',v,'usage',cfg.usage,'usageAt',cfg.usage_at,'dbConnections',total_conn,'dbActive',active_conn))
 on conflict(singleton) do update set received_at=excluded.received_at,measured_at=excluded.measured_at,payload=excluded.payload;
 return jsonb_build_object('ok',true);
end
$fn$;
revoke all on function public.byeollog_ops_publish_snapshot_v1(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.byeollog_ops_publish_snapshot_v1(text,jsonb) to anon,service_role;

create function public.byeollog_ops_read_snapshot_v1()
returns jsonb language sql stable security definer set search_path='' set statement_timeout='1500ms' as $fn$
 select jsonb_build_object('serverTime',statement_timestamp(),'snapshot',(select jsonb_build_object('receivedAt',received_at,'measuredAt',measured_at,'payload',payload) from private.ops_discord_snapshot_v1 where singleton));
$fn$;
revoke all on function public.byeollog_ops_read_snapshot_v1() from public,anon,authenticated;
grant execute on function public.byeollog_ops_read_snapshot_v1() to service_role;
comment on function public.byeollog_ops_publish_snapshot_v1(text,jsonb) is 'Dedicated 256-bit monitor token required. Bounded aggregate-only snapshot, throttled to one write per 45 seconds. Does not update monitor heartbeat.';
notify pgrst,'reload schema';
