begin;
set local lock_timeout='1s';
set local statement_timeout='10s';
CREATE OR REPLACE FUNCTION public.byeollog_claim_upbo_retries_v1(p_limit integer DEFAULT 3)
 RETURNS SETOF bangsel_collector_staging
 LANGUAGE sql
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
  with exhausted_candidates as (
    select s.workspace_id,s.source_uid from public.bangsel_collector_staging s
    where s.upbo_retry_protocol=1 and s.upbo_retry_attempts>=5
      and ((s.process_status in ('pending','failed') and (s.upbo_retry_after is null or s.upbo_retry_after<=now()))
        or (s.process_status='processing' and s.processing_started_at<now()-interval '11 minutes'))
    order by s.upbo_retry_after nulls first,s.workspace_id,s.source_uid limit 3
    for update of s skip locked
  ), exhausted as (
    update public.bangsel_collector_staging s
    set process_status='needs_review',processing_started_at=null,upbo_retry_after=null,
        process_error=left('자동 처리 재시도 한도에 도달했습니다. 처리 내역을 확인해주세요. '||coalesce(s.process_error,''),2000)
    from exhausted_candidates c where s.workspace_id=c.workspace_id and s.source_uid=c.source_uid
    returning s.source_uid
  ), candidates as (
    select s.workspace_id,s.source_uid from public.bangsel_collector_staging s
    where s.upbo_retry_protocol=1 and s.upbo_retry_attempts<5 and s.upbo_retry_after<=now()
      and (s.process_status in ('pending','failed') or (s.process_status='processing' and s.processing_started_at<now()-interval '10 minutes'))
      and exists(select 1 from public.byeollog_workspaces w where w.id=s.workspace_id and w.status='active')
    order by s.upbo_retry_after,s.workspace_id,s.source_uid limit greatest(1,least(coalesce(p_limit,3),3))
    for update of s skip locked
  )
  update public.bangsel_collector_staging s set upbo_retry_attempts=s.upbo_retry_attempts+1,
    upbo_retry_after=now()+interval '10 minutes',process_status='pending',processing_started_at=null
  from candidates c where s.workspace_id=c.workspace_id and s.source_uid=c.source_uid returning s.*;
$function$
;

CREATE OR REPLACE FUNCTION public.byeollog_upbo_retry_schedule_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  -- Do not enroll pre-migration rows or reset a retry budget on repeated uploads.
  new.upbo_retry_protocol:=old.upbo_retry_protocol;
  if new.upbo_retry_protocol=1 and new.process_status is distinct from old.process_status then
    if new.process_status in ('processed','ignored','needs_review') then new.upbo_retry_after:=null;
    elsif new.process_status='failed' then
      if new.upbo_retry_attempts>=5 then
        new.process_status:='needs_review';new.processing_started_at:=null;new.upbo_retry_after:=null;
        new.process_error:=left('자동 처리 재시도 한도에 도달했습니다. 처리 내역을 확인해주세요. '||coalesce(new.process_error,''),2000);
      else
        new.upbo_retry_after:=now()+make_interval(secs=>least(960,60*(2^new.upbo_retry_attempts)::integer));
      end if;
    elsif new.process_status='processing' then new.upbo_retry_after:=now()+interval '11 minutes';
    end if;
  end if;
  return new;
end $function$
;

CREATE OR REPLACE FUNCTION public.byeollog_ops_observe_v1(p_token text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '3s'
 SET lock_timeout TO '500ms'
AS $function$
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
  'upboNeedsReview',(select count(*) from (select 1 from public.bangsel_collector_staging
    where upbo_retry_protocol=1 and upbo_retry_attempts>=5 and process_status='needs_review' limit 1000) exhausted),
  'databaseRuntime',(select jsonb_build_object('statsReset',stats_reset,'rollbacks',xact_rollback,
    'commits',xact_commit,'blocksRead',blks_read,'blocksHit',blks_hit,'tempBytes',temp_bytes,'deadlocks',deadlocks)
    from pg_stat_database where datname=current_database()),
  'exhaustedAlerts',(select count(*) from private.ops_alert_delivery_v1 where exhausted and created_at>v_now-interval '24 hours'),'usage',v_usage);
end $function$
;
notify pgrst, 'reload schema';
commit;

