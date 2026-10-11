begin;
set local lock_timeout='2s';
drop trigger if exists zz_snapshot_upbo_collection on public.byeollog_soop_core_donations;
drop trigger if exists aa_guard_upbo_staging on public.bangsel_collector_staging;
CREATE OR REPLACE FUNCTION public.ingest_soop_external_roulette_result_v4(p_workspace_id uuid, p_chat_event_id text, p_chat_actor_id text, p_chat_actor_name text, p_donor_name_hint text, p_roulette_name text, p_result_text text, p_raw_message text, p_occurred_at timestamp with time zone, p_broadcast_key text, p_provider_bj_id text, p_source_chat_number bigint, p_event_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '8s'
AS $function$
declare v_key text;v_head_at timestamptz;v_owner text;
begin
  if p_workspace_id is null or p_occurred_at is null or p_source_chat_number is null or p_source_chat_number<=0
    or p_event_fingerprint is null or p_event_fingerprint!~'^[0-9a-f]{64}$'
    or p_provider_bj_id is null or lower(btrim(p_provider_bj_id))!~'^[a-z0-9_.-]{2,80}$'
    or not exists(select 1 from public.byeollog_workspaces w
      where w.id=p_workspace_id and w.status='active' and lower(w.soop_id)=lower(btrim(p_provider_bj_id)))
  then raise exception 'SOOP room owner does not match workspace'
    using errcode='23514',constraint='soop_room_owner_mismatch'; end if;

  -- Serialize the check and last pending spin with the existing FIFO writer.
  -- This prevents an extra concurrent result from leaking into exceptions
  -- after the final eligible pre-disable donation has completed.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog:roulette-write:'||p_workspace_id::text,0));
  perform private.expire_roulette_wait_v1(p_workspace_id);
  if not exists(select 1 from public.byeollog_roulette_amount_mappings m
      where m.workspace_id=p_workspace_id and m.enabled) then
    v_key:=coalesce(private.soop_broadcast_key_v1(p_workspace_id,p_source_chat_number),p_broadcast_key);
    select greatest(d.occurred_at,d.last_result_at) into v_head_at
    from public.byeollog_soop_core_donations d
    where d.workspace_id=p_workspace_id
      and private.same_soop_broadcast_v1(p_workspace_id,d.id,d.broadcast_key,btrim(v_key))
      and d.status in ('pending','collecting') and d.roulette_enabled
      and greatest(d.occurred_at,d.last_result_at)>clock_timestamp()-interval '3 minutes'
    and greatest(d.occurred_at,d.last_result_at)>p_occurred_at-interval '3 minutes'
      and d.expected_spins is not null and d.result_count<d.expected_spins
      and d.occurred_at<=p_occurred_at+interval '5 seconds'
      and not exists(select 1 from public.bangsel_roulette_invalidations i
        where i.workspace_id=d.workspace_id and i.source_uid='soop_sdk:'||d.provider_event_id)
    order by d.occurred_at,d.id limit 1;
    -- Only an active wait may keep collection enabled. Expired waits never revive.
    if v_head_at is null or v_head_at<=p_occurred_at-interval '3 minutes' then
      return jsonb_build_object('duplicate',false,'matched',false,'status','roulette_collection_disabled');
    end if;
  end if;

  v_owner:=public.claim_soop_event_ownership_v1(p_workspace_id,p_event_fingerprint,p_provider_bj_id,p_source_chat_number);
  if v_owner not in ('claimed','owned') then
    raise exception 'SOOP event already belongs to another workspace'
      using errcode='23514',constraint='soop_event_workspace_conflict';
  end if;
  return public.ingest_soop_external_roulette_result_v3(
    p_workspace_id,p_chat_event_id,p_chat_actor_id,p_chat_actor_name,p_donor_name_hint,
    p_roulette_name,p_result_text,p_raw_message,p_occurred_at,p_broadcast_key,
    p_provider_bj_id,p_source_chat_number,p_event_fingerprint);
end
$function$
;
CREATE OR REPLACE FUNCTION public.apply_roulette_amount_mapping_to_staging_v1()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_name text;
begin
 if new.raw_payload->>'source_provider'='soop_chat_sdk' then
  select d.roulette_name into v_name from public.byeollog_soop_core_donations d
  where d.workspace_id=new.workspace_id and 'soop_sdk:'||d.provider_event_id=new.source_uid;
  if found then new.event_name:=v_name; end if;
 end if;
 return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.ingest_soop_external_roulette_result_v2(p_workspace_id uuid, p_chat_event_id text, p_chat_actor_id text, p_chat_actor_name text, p_donor_name_hint text, p_roulette_name text, p_result_text text, p_raw_message text, p_occurred_at timestamp with time zone, p_broadcast_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '8s'
AS $function$
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
    'byeollog:roulette-write:'||p_workspace_id::text,0));
  perform private.expire_roulette_wait_v1(p_workspace_id);

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
  where donation.workspace_id=p_workspace_id and private.same_soop_broadcast_v1(p_workspace_id,donation.id,donation.broadcast_key,btrim(p_broadcast_key))
    and donation.status in ('pending','collecting')
    and greatest(donation.occurred_at,donation.last_result_at)>clock_timestamp()-interval '3 minutes'
    and greatest(donation.occurred_at,donation.last_result_at)>p_occurred_at-interval '3 minutes'
    and donation.roulette_enabled and donation.expected_spins is not null
    and not exists(select 1 from public.bangsel_roulette_invalidations i
      where i.workspace_id=donation.workspace_id and i.source_uid='soop_sdk:'||donation.provider_event_id)
    and donation.result_count<donation.expected_spins
    and donation.occurred_at<=p_occurred_at+interval '5 seconds'
  order by donation.occurred_at,donation.id
  limit 1 for update;
  if v_donation.id is not null then
    if greatest(v_donation.occurred_at,v_donation.last_result_at)<=p_occurred_at-interval '3 minutes' then
      update public.byeollog_soop_core_roulette_results result
      set match_state='ambiguous',match_method='fifo_head_stale',review_details=jsonb_build_object('fifoHead',jsonb_build_object('id',v_donation.id,'actor_name',v_donation.actor_name,'amount',v_donation.amount,'occurred_at',v_donation.occurred_at,'result_count',v_donation.result_count,'expected_spins',v_donation.expected_spins))
      where result.id=v_result_id;
      return jsonb_build_object('duplicate',false,'matched',false,
        'status','fifo_blocked_stale_head','candidateCount',1);
    end if;
    if nullif(btrim(p_roulette_name),'') is not null and v_donation.roulette_name is not null
      and lower(v_donation.roulette_name)<>lower(btrim(p_roulette_name)) then
      update public.byeollog_soop_core_roulette_results result
      set match_state='ambiguous',match_method='fifo_head_roulette_mismatch',review_details=jsonb_build_object('fifoHead',jsonb_build_object('id',v_donation.id,'actor_name',v_donation.actor_name,'amount',v_donation.amount,'occurred_at',v_donation.occurred_at,'result_count',v_donation.result_count,'expected_spins',v_donation.expected_spins))
      where result.id=v_result_id;
      return jsonb_build_object('duplicate',false,'matched',false,
        'status','fifo_head_roulette_mismatch','candidateCount',1);
    end if;
    v_method:='fifo_expected_spins';
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
  select jsonb_agg(jsonb_build_object('result',result.result_text,'probability','','receipt_identity',result.receipt_identity)
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
  v_event_name:=v_donation.roulette_name;

  update public.byeollog_soop_core_donations donation set
    result_count=v_count,last_result_at=p_occurred_at,
    status=case when v_complete then 'complete' else 'collecting' end,
    updated_at=clock_timestamp()
  where donation.id=v_donation.id;
  update public.bangsel_donations donation set
    had_roulette=true,roulette_count=v_count,roulette_results=v_results,event_name=v_event_name,
    raw_payload=donation.raw_payload||jsonb_build_object(
      'correlation','soop_chat_sdk','match_method',v_method,
      'expected_spins',v_expected,'correlation_complete',v_complete,'roulette_enabled',v_donation.roulette_enabled)
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
      'expected_spins',v_expected,'correlation_complete',v_complete,'roulette_enabled',v_donation.roulette_enabled),
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
$function$
;
update public.byeollog_soop_runtime_controls set upbo_settings_protocol=0;
notify pgrst,'reload schema';
commit;
