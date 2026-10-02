begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

alter table public.byeollog_soop_core_donations add column if not exists wait_expired_at timestamptz;
create index if not exists byeollog_roulette_wait_deadline_idx
 on public.byeollog_soop_core_donations ((greatest(occurred_at,last_result_at)),workspace_id)
 where status in ('pending','collecting') and roulette_enabled and expected_spins is not null and result_count<expected_spins;

-- Only the connection wait ends. Donation amounts, collected results and ledgers survive.
create or replace function private.expire_roulette_wait_v1(p_workspace uuid,p_now timestamptz default clock_timestamp())
returns integer language plpgsql security invoker set search_path='' as $fn$
declare d record; n integer:=0; receipt jsonb;
begin
 if p_workspace is null or p_now is null then raise exception 'workspace and time required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace::text,0));
 for d in select id,provider_event_id,greatest(occurred_at,last_result_at)+interval '3 minutes' as deadline
  from public.byeollog_soop_core_donations
  where workspace_id=p_workspace and status in ('pending','collecting')
    and roulette_enabled and expected_spins is not null and result_count<expected_spins
    and greatest(occurred_at,last_result_at)<=p_now-interval '3 minutes'
  order by greatest(occurred_at,last_result_at),id limit 1000 for update
 loop
  update public.byeollog_soop_core_donations set status='expired',wait_expired_at=d.deadline,updated_at=p_now where id=d.id and workspace_id=p_workspace;
  receipt:=jsonb_build_object('state','expired','reason','result_timeout','ended_at',d.deadline,'wait_seconds',180);
  update public.bangsel_donations set raw_payload=coalesce(raw_payload,'{}'::jsonb)||jsonb_build_object('roulette_wait',receipt)
    where workspace_id=p_workspace and source_event_key='soop_sdk:'||d.provider_event_id;
  update public.bangsel_collector_staging set raw_payload=coalesce(raw_payload,'{}'::jsonb)||jsonb_build_object('roulette_wait',receipt)
    where workspace_id=p_workspace and source_uid='soop_sdk:'||d.provider_event_id;
  n:=n+1;
 end loop;
 return n;
end $fn$;
revoke all on function private.expire_roulette_wait_v1(uuid,timestamptz) from public,anon,authenticated,service_role;

create or replace function private.roulette_wait_timeout_tick_v1()
returns integer language plpgsql security definer set search_path='' set statement_timeout='3s' set lock_timeout='200ms' as $fn$
declare w record; n integer:=0; t timestamptz:=clock_timestamp();
begin
 for w in select workspace_id from public.byeollog_soop_core_donations
  where status in ('pending','collecting') and roulette_enabled and expected_spins is not null and result_count<expected_spins
    and greatest(occurred_at,last_result_at)<=t-interval '3 minutes'
  group by workspace_id order by min(greatest(occurred_at,last_result_at)),workspace_id limit 20
 loop
  if pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||w.workspace_id::text,0)) then
   n:=n+private.expire_roulette_wait_v1(w.workspace_id,t);
  end if;
 end loop;
 return n;
end $fn$;
revoke all on function private.roulette_wait_timeout_tick_v1() from public,anon,authenticated,service_role;

-- Preserve the live function bodies and ACLs. Fail closed if an expected insertion point drifted.
do $patch$
declare f text; signature regprocedure;
begin
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v2';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$    'byeollog:roulette-write:'||p_workspace_id::text,0));$old$,'')))/length($old$    'byeollog:roulette-write:'||p_workspace_id::text,0));$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v2'; end if;
 execute replace(f,$old$    'byeollog:roulette-write:'||p_workspace_id::text,0));$old$,$new$    'byeollog:roulette-write:'||p_workspace_id::text,0));
  perform private.expire_roulette_wait_v1(p_workspace_id);$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v4';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$    'byeollog:roulette-write:'||p_workspace_id::text,0));$old$,'')))/length($old$    'byeollog:roulette-write:'||p_workspace_id::text,0));$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v4'; end if;
 execute replace(f,$old$    'byeollog:roulette-write:'||p_workspace_id::text,0));$old$,$new$    'byeollog:roulette-write:'||p_workspace_id::text,0));
  perform private.expire_roulette_wait_v1(p_workspace_id);$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v2';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$    and donation.status in ('pending','collecting')$old$,'')))/length($old$    and donation.status in ('pending','collecting')$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v2'; end if;
 execute replace(f,$old$    and donation.status in ('pending','collecting')$old$,$new$    and donation.status in ('pending','collecting')
    and greatest(donation.occurred_at,donation.last_result_at)>clock_timestamp()-interval '3 minutes'
    and greatest(donation.occurred_at,donation.last_result_at)>p_occurred_at-interval '3 minutes'$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v2';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$if v_donation.occurred_at<p_occurred_at-interval '10 minutes' then$old$,'')))/length($old$if v_donation.occurred_at<p_occurred_at-interval '10 minutes' then$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v2'; end if;
 execute replace(f,$old$if v_donation.occurred_at<p_occurred_at-interval '10 minutes' then$old$,$new$if greatest(v_donation.occurred_at,v_donation.last_result_at)<=p_occurred_at-interval '3 minutes' then$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v4';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$      and d.status in ('pending','collecting') and d.roulette_enabled$old$,'')))/length($old$      and d.status in ('pending','collecting') and d.roulette_enabled$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v4'; end if;
 execute replace(f,$old$      and d.status in ('pending','collecting') and d.roulette_enabled$old$,$new$      and d.status in ('pending','collecting') and d.roulette_enabled
      and greatest(d.occurred_at,d.last_result_at)>clock_timestamp()-interval '3 minutes'
    and greatest(d.occurred_at,d.last_result_at)>p_occurred_at-interval '3 minutes'$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v4';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$select d.occurred_at into v_head_at$old$,'')))/length($old$select d.occurred_at into v_head_at$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v4'; end if;
 execute replace(f,$old$select d.occurred_at into v_head_at$old$,$new$select greatest(d.occurred_at,d.last_result_at) into v_head_at$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v4';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$v_head_at<p_occurred_at-interval '10 minutes'$old$,'')))/length($old$v_head_at<p_occurred_at-interval '10 minutes'$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v4'; end if;
 execute replace(f,$old$v_head_at<p_occurred_at-interval '10 minutes'$old$,$new$v_head_at<=p_occurred_at-interval '3 minutes'$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v4';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$-- Reuse the existing FIFO ten-minute eligibility limit. Never skip a
    -- stale FIFO head or revive pending donations from another broadcast.$old$,'')))/length($old$-- Reuse the existing FIFO ten-minute eligibility limit. Never skip a
    -- stale FIFO head or revive pending donations from another broadcast.$old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v4'; end if;
 execute replace(f,$old$-- Reuse the existing FIFO ten-minute eligibility limit. Never skip a
    -- stale FIFO head or revive pending donations from another broadcast.$old$,$new$-- Only an active wait may keep collection enabled. Expired waits never revive.$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$  insert into public.byeollog_soop_core_roulette_results($old$,'')))/length($old$  insert into public.byeollog_soop_core_roulette_results($old$)<>1 then raise exception 'unexpected function definition: ingest_soop_external_roulette_result_v1'; end if;
 execute replace(f,$old$  insert into public.byeollog_soop_core_roulette_results($old$,$new$  perform private.expire_roulette_wait_v1(p_workspace_id);
  insert into public.byeollog_soop_core_roulette_results($new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_ux_roulette_status_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$  with pending as ($old$,'')))/length($old$  with pending as ($old$)<>1 then raise exception 'unexpected function definition: byeollog_ux_roulette_status_v1'; end if;
 execute replace(f,$old$  with pending as ($old$,$new$  perform private.expire_roulette_wait_v1(p_workspace_id);
  with pending as ($new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_ux_roulette_status_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$and roulette_enabled and expected_spins is not null and result_count<expected_spins$old$,'')))/length($old$and roulette_enabled and expected_spins is not null and result_count<expected_spins$old$)<>1 then raise exception 'unexpected function definition: byeollog_ux_roulette_status_v1'; end if;
 execute replace(f,$old$and roulette_enabled and expected_spins is not null and result_count<expected_spins$old$,$new$and roulette_enabled and expected_spins is not null and result_count<expected_spins
      and greatest(d.occurred_at,d.last_result_at)>clock_timestamp()-interval '3 minutes'$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_dashboard_counts_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$  return jsonb_build_object($old$,'')))/length($old$  return jsonb_build_object($old$)<>1 then raise exception 'unexpected function definition: byeollog_dashboard_counts_v1'; end if;
 execute replace(f,$old$  return jsonb_build_object($old$,$new$  perform private.expire_roulette_wait_v1(p_workspace_id);
  return jsonb_build_object($new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_dashboard_counts_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$and roulette_enabled and expected_spins is not null and result_count<expected_spins$old$,'')))/length($old$and roulette_enabled and expected_spins is not null and result_count<expected_spins$old$)<>1 then raise exception 'unexpected function definition: byeollog_dashboard_counts_v1'; end if;
 execute replace(f,$old$and roulette_enabled and expected_spins is not null and result_count<expected_spins$old$,$new$and roulette_enabled and expected_spins is not null and result_count<expected_spins
      and greatest(d.occurred_at,d.last_result_at)>clock_timestamp()-interval '3 minutes'$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_ux_roulette_status_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$select id,actor_name,amount,roulette_name,occurred_at,result_count,expected_spins,broadcast_key,updated_at$old$,'')))/length($old$select id,actor_name,amount,roulette_name,occurred_at,result_count,expected_spins,broadcast_key,updated_at$old$)<>1 then raise exception 'unexpected function definition: byeollog_ux_roulette_status_v1'; end if;
 execute replace(f,$old$select id,actor_name,amount,roulette_name,occurred_at,result_count,expected_spins,broadcast_key,updated_at$old$,$new$select id,actor_name,amount,roulette_name,occurred_at,last_result_at,greatest(occurred_at,last_result_at)+interval '3 minutes' as wait_expires_at,result_count,expected_spins,broadcast_key,updated_at$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_ux_roulette_status_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$'byAmount',coalesce$old$,'')))/length($old$'byAmount',coalesce$old$)<>1 then raise exception 'unexpected function definition: byeollog_ux_roulette_status_v1'; end if;
 execute replace(f,$old$'byAmount',coalesce$old$,$new$'waitSeconds',180,
    'expiredRecent',coalesce((select jsonb_agg(to_jsonb(e)) from (select id,actor_name,amount,occurred_at,result_count,expected_spins,wait_expired_at
      from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and wait_expired_at is not null order by wait_expired_at desc,id desc limit 50)e),'[]'::jsonb),
    'byAmount',coalesce$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_ux_history_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$'validation',to_jsonb(s)->'validation'$old$,'')))/length($old$'validation',to_jsonb(s)->'validation'$old$)<>1 then raise exception 'unexpected function definition: byeollog_ux_history_v1'; end if;
 execute replace(f,$old$'validation',to_jsonb(s)->'validation'$old$,$new$'roulette_wait',s.raw_payload->'roulette_wait','validation',to_jsonb(s)->'validation'$new$);
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='byeollog_ux_history_v1';
 f:=pg_get_functiondef(signature);
 if (length(f)-length(replace(f,$old$'nickname',d.nickname$old$,'')))/length($old$'nickname',d.nickname$old$)<>1 then raise exception 'unexpected function definition: byeollog_ux_history_v1'; end if;
 execute replace(f,$old$'nickname',d.nickname$old$,$new$'roulette_wait',d.raw_payload->'roulette_wait','nickname',d.nickname$new$);
end $patch$;

-- Network-free cleanup. Eligibility and dashboard reads enforce the deadline immediately;
-- the background materialization may lag by up to one 30-second tick.
select cron.schedule('byeollog-roulette-wait-timeout-v1','30 seconds','select private.roulette_wait_timeout_tick_v1()');
commit;
