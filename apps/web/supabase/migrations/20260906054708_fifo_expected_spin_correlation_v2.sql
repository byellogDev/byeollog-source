-- Deterministic FIFO correlation for configured external roulettes.
--
-- The amount mapping is snapshotted when the donation is inserted so an
-- operator editing a roulette later cannot change an in-flight job.  Results
-- stay on the oldest configured job until its expected spin count is full.
-- Unconfigured donations retain the conservative legacy matching fallback.

alter table public.byeollog_soop_core_donations
  add column if not exists roulette_name text;
alter table public.byeollog_soop_core_donations
  add column if not exists expected_spins integer;

alter table public.byeollog_soop_core_donations
  drop constraint if exists byeollog_soop_core_donations_roulette_name_check;
alter table public.byeollog_soop_core_donations
  add constraint byeollog_soop_core_donations_roulette_name_check
  check (roulette_name is null or (
    char_length(btrim(roulette_name)) between 1 and 120
    and roulette_name !~ '[[:cntrl:]]'
  ));

alter table public.byeollog_soop_core_donations
  drop constraint if exists byeollog_soop_core_donations_expected_spins_check;
alter table public.byeollog_soop_core_donations
  add constraint byeollog_soop_core_donations_expected_spins_check
  check (expected_spins is null or expected_spins between 1 and 1000);

alter table public.byeollog_soop_core_donations
  drop constraint if exists byeollog_soop_core_donations_status_check;
alter table public.byeollog_soop_core_donations
  add constraint byeollog_soop_core_donations_status_check
  check (status in ('pending','collecting','complete','expired'));

create index if not exists byeollog_soop_core_donations_fifo_v2_idx
  on public.byeollog_soop_core_donations(
    workspace_id,broadcast_key,occurred_at,id
  ) include(expected_spins,result_count,roulette_name)
  where status in ('pending','collecting') and expected_spins is not null;

comment on column public.byeollog_soop_core_donations.roulette_name is
  'Donation-time snapshot of the configured external roulette lane.';
comment on column public.byeollog_soop_core_donations.expected_spins is
  'Donation-time expected spin snapshot. NULL keeps conservative legacy matching.';

create or replace function private.snapshot_soop_roulette_mapping_v2()
returns trigger
language plpgsql
set search_path=''
as $function$
declare v_name text;v_spins integer;
begin
  if new.roulette_name is not null or new.expected_spins is not null then
    return new;
  end if;
  select mapping.roulette_name,mapping.expected_spins
  into v_name,v_spins
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and mapping.balloons=new.amount;
  new.roulette_name:=nullif(btrim(v_name),'');
  new.expected_spins:=v_spins;
  return new;
end
$function$;

revoke all on function private.snapshot_soop_roulette_mapping_v2()
  from public,anon,authenticated,service_role;
drop trigger if exists snapshot_soop_roulette_mapping_v2
  on public.byeollog_soop_core_donations;
create trigger snapshot_soop_roulette_mapping_v2
before insert on public.byeollog_soop_core_donations
for each row execute function private.snapshot_soop_roulette_mapping_v2();

create or replace function public.ingest_soop_external_roulette_result_v2(
  p_workspace_id uuid,p_chat_event_id text,p_chat_actor_id text,p_chat_actor_name text,
  p_donor_name_hint text,p_roulette_name text,p_result_text text,p_raw_message text,
  p_occurred_at timestamptz,p_broadcast_key text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare
  v_result_id uuid;v_donation public.byeollog_soop_core_donations%rowtype;
  v_candidates integer:=0;v_method text;v_results jsonb;v_count integer;v_event_name text;
  v_expected integer;v_validation text;v_complete boolean:=false;
begin
  if p_workspace_id is null or char_length(btrim(p_chat_event_id)) not between 1 and 180
    or char_length(btrim(p_chat_actor_id)) not between 1 and 180
    or char_length(btrim(p_chat_actor_name)) not between 1 and 120
    or char_length(btrim(p_result_text)) not between 1 and 120
    or char_length(btrim(p_raw_message)) not between 1 and 300 or p_occurred_at is null
    or char_length(btrim(p_broadcast_key)) not between 1 and 200
  then raise exception 'external roulette result is invalid' using errcode='22023'; end if;

  -- The gateway already sequences each workspace.  This database lock also
  -- protects direct retries and overlapping serverless invocations.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog:soop-roulette-fifo-v2:'||p_workspace_id::text||':'||btrim(p_broadcast_key),0));

  insert into public.byeollog_soop_core_roulette_results(
    workspace_id,provider_chat_id,chat_actor_id,chat_actor_name,donor_name_hint,
    roulette_name,result_text,raw_message,occurred_at,broadcast_key)
  values(p_workspace_id,btrim(p_chat_event_id),lower(btrim(p_chat_actor_id)),btrim(p_chat_actor_name),
    nullif(btrim(p_donor_name_hint),''),nullif(btrim(p_roulette_name),''),btrim(p_result_text),
    btrim(p_raw_message),p_occurred_at,btrim(p_broadcast_key))
  on conflict(workspace_id,provider_chat_id) do nothing returning id into v_result_id;
  if v_result_id is null then
    return jsonb_build_object('duplicate',true,'matched',false,'status','duplicate');
  end if;

  -- For configured roulettes, the oldest incomplete donation owns the lane.
  -- Both one-spin bursts and multi-spin jobs use the same queue rule.  A
  -- parsed donor hint is deliberately not allowed to skip an older configured
  -- job: the configured queue is deterministic FIFO by contract.
  select donation.* into v_donation
  from public.byeollog_soop_core_donations donation
  where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
    and donation.status in ('pending','collecting')
    and donation.expected_spins is not null
    and donation.result_count<donation.expected_spins
    and donation.occurred_at<=p_occurred_at+interval '5 seconds'
  order by donation.occurred_at,donation.id
  limit 1 for update;
  if v_donation.id is not null then
    if v_donation.occurred_at<p_occurred_at-interval '10 minutes' then
      update public.byeollog_soop_core_roulette_results result
      set match_state='ambiguous',match_method='fifo_head_stale'
      where result.id=v_result_id;
      return jsonb_build_object('duplicate',false,'matched',false,
        'status','fifo_blocked_stale_head','candidateCount',1);
    end if;
    if nullif(btrim(p_roulette_name),'') is not null and v_donation.roulette_name is not null
      and lower(v_donation.roulette_name)<>lower(btrim(p_roulette_name)) then
      update public.byeollog_soop_core_roulette_results result
      set match_state='ambiguous',match_method='fifo_head_roulette_mismatch'
      where result.id=v_result_id;
      return jsonb_build_object('duplicate',false,'matched',false,
        'status','fifo_head_roulette_mismatch','candidateCount',1);
    end if;
    v_method:='fifo_expected_spins';
  end if;

  -- Accounts without confirmed expected-spin mappings retain the prior
  -- conservative matching behavior.  They never bypass a configured head.
  if v_donation.id is null then
    v_candidates:=0;
    if nullif(btrim(p_donor_name_hint),'') is not null then
      select donation.* into v_donation
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status in ('pending','collecting') and donation.expected_spins is null
        and donation.occurred_at between p_occurred_at-interval '10 minutes' and p_occurred_at+interval '5 seconds'
        and lower(donation.actor_name)=lower(btrim(p_donor_name_hint))
      order by donation.occurred_at,donation.id
      limit 1 for update;
      if v_donation.id is not null then v_method:='legacy_donor_name_fifo'; end if;
    end if;
  end if;
  if v_donation.id is null then
    select count(*)::integer into v_candidates
    from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
      and donation.status='collecting' and donation.expected_spins is null
      and donation.last_result_at between p_occurred_at-interval '30 seconds' and p_occurred_at+interval '5 seconds'
      and not exists(
        select 1 from public.byeollog_soop_core_donations newer
        where newer.workspace_id=p_workspace_id and newer.broadcast_key=btrim(p_broadcast_key)
          and newer.status='pending' and newer.expected_spins is null
          and newer.occurred_at>donation.last_result_at
          and newer.occurred_at<=p_occurred_at+interval '5 seconds');
    if v_candidates=1 then
      select donation.* into v_donation
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status='collecting' and donation.expected_spins is null
        and donation.last_result_at between p_occurred_at-interval '30 seconds' and p_occurred_at+interval '5 seconds'
        and not exists(
          select 1 from public.byeollog_soop_core_donations newer
          where newer.workspace_id=p_workspace_id and newer.broadcast_key=btrim(p_broadcast_key)
            and newer.status='pending' and newer.expected_spins is null
            and newer.occurred_at>donation.last_result_at
            and newer.occurred_at<=p_occurred_at+interval '5 seconds')
      limit 1 for update;
      v_method:='sequence_continuation';
    elsif v_candidates=0 then
      select count(*)::integer into v_candidates
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status='pending' and donation.expected_spins is null
        and donation.occurred_at between p_occurred_at-interval '120 seconds' and p_occurred_at+interval '5 seconds';
      if v_candidates=1 then
        select donation.* into v_donation
        from public.byeollog_soop_core_donations donation
        where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
          and donation.status='pending' and donation.expected_spins is null
          and donation.occurred_at between p_occurred_at-interval '120 seconds' and p_occurred_at+interval '5 seconds'
        limit 1 for update;
        v_method:='unique_recent';
      end if;
    end if;
  end if;

  if v_donation.id is null then
    update public.byeollog_soop_core_roulette_results result set
      match_state=case when v_candidates>1 then 'ambiguous' else 'unmatched' end
    where result.id=v_result_id;
    return jsonb_build_object('duplicate',false,'matched',false,
      'status',case when v_candidates>1 then 'ambiguous' else 'unmatched' end,
      'candidateCount',v_candidates);
  end if;

  update public.byeollog_soop_core_roulette_results result set
    donation_id=v_donation.id,match_state='matched',match_method=v_method
  where result.id=v_result_id;
  select jsonb_agg(jsonb_build_object('result',result.result_text,'probability','')
      order by result.occurred_at,result.id),
    count(*)::integer,
    max(result.roulette_name) filter(where result.roulette_name is not null)
  into v_results,v_count,v_event_name
  from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.donation_id=v_donation.id
    and result.match_state='matched';

  v_expected:=v_donation.expected_spins;
  v_complete:=v_expected is not null and v_count>=v_expected;
  v_validation:=case
    when v_expected is null then 'matched'
    when v_count<v_expected then 'short'
    when v_count=v_expected then 'matched'
    else 'over'
  end;
  v_event_name:=coalesce(v_donation.roulette_name,v_event_name,v_donation.amount::text||'개 룰렛');

  update public.byeollog_soop_core_donations donation set
    result_count=v_count,last_result_at=p_occurred_at,
    status=case when v_complete then 'complete' else 'collecting' end,
    updated_at=clock_timestamp()
  where donation.id=v_donation.id;
  update public.bangsel_donations donation set
    had_roulette=true,roulette_count=v_count,roulette_results=v_results,event_name=v_event_name,
    raw_payload=donation.raw_payload||jsonb_build_object(
      'correlation','soop_chat_sdk','match_method',v_method,
      'expected_spins',v_expected,'correlation_complete',v_complete)
  where donation.workspace_id=p_workspace_id
    and donation.source_event_key='soop_sdk:'||v_donation.provider_event_id;
  insert into public.bangsel_collector_staging(
    workspace_id,source_uid,session_id,donated_time_text,nickname,soop_id,balloons,roulette,
    collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,
    roulette_results,process_status,source_scope,uploaded_at)
  values(p_workspace_id,'soop_sdk:'||v_donation.provider_event_id,v_donation.broadcast_key,
    to_char(v_donation.occurred_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    v_donation.actor_name,v_donation.actor_id,v_donation.amount,
    (v_results->0->>'result'),'soop-chat-sdk-core-v2',
    jsonb_build_object('type','SENDBALLOON','source_provider','soop_chat_sdk',
      'provider_event_id',v_donation.provider_event_id,'correlation_method',v_method,
      'expected_spins',v_expected,'correlation_complete',v_complete),
    v_event_name,v_expected,v_count,v_validation,v_results,'pending','soop',clock_timestamp())
  on conflict(workspace_id,source_uid) do update set
    roulette=excluded.roulette,collector_version=excluded.collector_version,
    raw_payload=excluded.raw_payload,event_name=excluded.event_name,
    expected_spins=excluded.expected_spins,actual_spins=excluded.actual_spins,
    validation=excluded.validation,roulette_results=excluded.roulette_results,
    process_status='pending',processed_at=null,processing_started_at=null,process_error=null,
    uploaded_at=excluded.uploaded_at;
  return jsonb_build_object('duplicate',false,'matched',true,'status','matched',
    'matchMethod',v_method,'donationId',v_donation.id,
    'sourceUid',case when v_expected is null or v_complete
      then 'soop_sdk:'||v_donation.provider_event_id else null end,
    'resultCount',v_count,'expectedSpins',v_expected,'queueComplete',v_complete,
    'validation',v_validation);
end
$function$;

revoke all on function public.ingest_soop_external_roulette_result_v2(
  uuid,text,text,text,text,text,text,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_external_roulette_result_v2(
  uuid,text,text,text,text,text,text,text,timestamptz,text)
  to service_role;

comment on function public.ingest_soop_external_roulette_result_v2(
  uuid,text,text,text,text,text,text,text,timestamptz,text) is
  'Correlates configured one- and multi-spin external roulette results through a serialized FIFO queue; unknown mappings fail closed.';

notify pgrst, 'reload schema';
