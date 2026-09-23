-- Apply before the matching server release. No historical row is enrolled.
set lock_timeout='2s';
alter table public.bangsel_collector_staging add column if not exists upbo_retry_protocol integer;
alter table public.bangsel_collector_staging add column if not exists upbo_retry_attempts integer not null default 0;
alter table public.bangsel_collector_staging add column if not exists upbo_retry_after timestamptz;
-- Eligibility remains OFF through schema/code rollout. Enable the INSERT default
-- only after old server executions have drained (see ops/Enable-UpboRetries.sql).
alter table public.bangsel_collector_staging alter column upbo_retry_protocol drop default;
alter table public.bangsel_collector_staging alter column upbo_retry_after set default (now()+interval '2 minutes');

create or replace function public.byeollog_commit_upbo_group_v1(p_workspace_id uuid,p_group jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='8s'
as $$
declare
  v_keys text[]; v_new text[]; v_ids uuid[]; v_task public.bangsel_tasks%rowtype;
  v_added integer; v_base integer; v_tracked integer;
begin
  if p_workspace_id is null or jsonb_typeof(p_group) is distinct from 'object'
    or jsonb_typeof(p_group->'keys') is distinct from 'array'
    or length(coalesce(p_group->>'type','')) not between 1 and 2000
    or length(coalesce(p_group->>'fan','')) not between 1 and 2000
    or jsonb_array_length(p_group->'keys') not between 1 and 10000 then
    raise exception 'invalid upbo group' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(p_group->'keys') k where jsonb_typeof(k) is distinct from 'string') then
    raise exception 'invalid upbo keys' using errcode='22023';
  end if;
  select array_agg(distinct k order by k) into v_keys from jsonb_array_elements_text(p_group->'keys') k;
  if exists(select 1 from unnest(v_keys) k where length(k) not between 1 and 4000) then
    raise exception 'invalid upbo key size' using errcode='22023';
  end if;
  -- One short transaction per fan/event/type, not a global ingress lock.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    jsonb_build_array(p_workspace_id,p_group->>'soop_id',p_group->>'event',p_group->>'type')::text,1701));
  select array_agg(k order by k) into v_new from unnest(v_keys) k
    where not exists(select 1 from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id and i.source_event_key=k);
  if coalesce(cardinality(v_new),0)=0 then return jsonb_build_object('taskId',null,'added',0); end if;

  select array_agg(t.id) into v_ids from (
    select id from public.bangsel_tasks where workspace_id=p_workspace_id and done_qty=0
      and fan_soop_id=p_group->>'soop_id' and event=coalesce(p_group->>'event','') and type=p_group->>'type'
      order by id limit 2 for update
  ) t;
  if cardinality(v_ids)=1 then
    select * into v_task from public.bangsel_tasks where id=v_ids[1] and workspace_id=p_workspace_id;
    v_base:=v_task.total_qty;
    select count(*) into v_tracked from public.bangsel_task_import_items where workspace_id=p_workspace_id and task_id=v_task.id;
    if v_tracked=0 and v_task.source_event_key=any(v_keys)
      and v_task.source in ('weflab_roulette_grouped','soop_chat_sdk_grouped','collector_fixed_grouped') then
      v_base:=0; -- Preserve the existing orphan-before-ledger recovery rule.
    end if;
  else
    insert into public.bangsel_tasks(workspace_id,fan,fan_soop_id,event,type,total_qty,done_qty,memo,added_date,source,source_event_key)
      values(p_workspace_id,p_group->>'fan',nullif(p_group->>'soop_id',''),coalesce(p_group->>'event',''),p_group->>'type',1,0,'',
        (p_group->>'added_date')::date,coalesce(p_group->>'taskSource','weflab_roulette_grouped'),p_workspace_id::text||':'||v_new[1])
      returning * into v_task;
    v_base:=0;
  end if;
  insert into public.bangsel_task_import_items(workspace_id,source_event_key,task_id,source)
    select p_workspace_id,k,v_task.id,coalesce(p_group->>'source','weflab_roulette') from unnest(v_new) k;
  get diagnostics v_added=row_count;
  update public.bangsel_tasks set total_qty=greatest(1,v_base+v_added) where id=v_task.id and workspace_id=p_workspace_id;
  return jsonb_build_object('taskId',v_task.id,'added',v_added);
end $$;
revoke all on function public.byeollog_commit_upbo_group_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_commit_upbo_group_v1(uuid,jsonb) to service_role;

create or replace function public.byeollog_claim_upbo_retries_v1(p_limit integer default 3)
returns setof public.bangsel_collector_staging language sql security invoker set search_path='' set statement_timeout='5s'
as $$
  with candidates as (
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
$$;
revoke all on function public.byeollog_claim_upbo_retries_v1(integer) from public,anon,authenticated;
grant execute on function public.byeollog_claim_upbo_retries_v1(integer) to service_role;

create or replace function public.byeollog_upbo_retry_schedule_v1()
returns trigger language plpgsql security invoker set search_path=''
as $$
begin
  -- Do not enroll pre-migration rows or reset a retry budget on repeated uploads.
  new.upbo_retry_protocol:=old.upbo_retry_protocol;
  if new.upbo_retry_protocol=1 and new.process_status is distinct from old.process_status then
    if new.process_status in ('processed','ignored','needs_review') then new.upbo_retry_after:=null;
    elsif new.process_status='failed' then
      new.upbo_retry_after:=case when new.upbo_retry_attempts<5 then now()+make_interval(secs=>least(960,60*(2^new.upbo_retry_attempts)::integer)) else null end;
    elsif new.process_status='processing' then new.upbo_retry_after:=now()+interval '11 minutes';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.byeollog_upbo_retry_schedule_v1() from public,anon,authenticated;
grant execute on function public.byeollog_upbo_retry_schedule_v1() to service_role;
create trigger byeollog_upbo_retry_schedule before update on public.bangsel_collector_staging
  for each row execute function public.byeollog_upbo_retry_schedule_v1();
-- Build the partial index CONCURRENTLY outside this migration transaction,
-- before activation. See ops/Create-UpboRetryIndex.sql (no blocking index scan).
