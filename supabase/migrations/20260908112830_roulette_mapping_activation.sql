-- Disable reward registration without removing a FIFO slot.
-- Each donation retains its activation snapshot across edits and retries.
begin;
set local lock_timeout='3s';
alter table public.byeollog_roulette_amount_mappings add column enabled boolean not null default true;
alter table public.byeollog_soop_core_donations add column roulette_enabled boolean not null default true;
comment on column public.byeollog_roulette_amount_mappings.enabled is 'Controls roulette rewards for future donations; FIFO result slots are preserved.';
comment on column public.byeollog_soop_core_donations.roulette_enabled is 'Server-owned donation-time mapping activation snapshot; not retroactive.';

create or replace function private.snapshot_soop_roulette_mapping_v2()
returns trigger
language plpgsql
set search_path=''
as $function$
declare v_name text;v_spins integer;
begin
  select mapping.enabled into new.roulette_enabled
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and mapping.balloons=new.amount
  for share;
  new.roulette_enabled:=coalesce(new.roulette_enabled,true);
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
$function$;


create or replace function private.resolve_special_roulette_result_v1(p_result_id uuid)
returns jsonb
language plpgsql security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_result public.byeollog_soop_core_roulette_results%rowtype;
  v_donation public.byeollog_soop_core_donations%rowtype;
  v_receipt private.special_roulette_receipts%rowtype;
  v_actor text;v_key text;v_instance uuid;v_now timestamptz:=clock_timestamp();
  v_pending integer;v_applied integer:=1;v_control boolean:=false;v_stacking boolean:=false;
begin
  if p_result_id is null then raise exception 'special roulette result is required' using errcode='22023'; end if;
  select result.* into v_result from public.byeollog_soop_core_roulette_results result
  where result.id=p_result_id and result.match_state='matched';
  if v_result.id is null then raise exception 'special roulette result is not matched' using errcode='22023'; end if;
  select donation.* into v_donation from public.byeollog_soop_core_donations donation
  where donation.id=v_result.donation_id and donation.workspace_id=v_result.workspace_id
    and donation.broadcast_key=v_result.broadcast_key;
  if v_donation.id is null or not exists(
    select 1 from public.byeollog_workspaces workspace
    join public.byeollog_soop_event_ownership donation_owner
      on donation_owner.workspace_id=workspace.id
     and donation_owner.event_fingerprint=v_donation.source_event_fingerprint
     and donation_owner.provider_bj_id=v_donation.source_bj_id
     and donation_owner.chat_number=v_donation.source_chat_number
    join public.byeollog_soop_event_ownership result_owner
      on result_owner.workspace_id=workspace.id
     and result_owner.event_fingerprint=v_result.source_event_fingerprint
     and result_owner.provider_bj_id=v_result.source_bj_id
     and result_owner.chat_number=v_result.source_chat_number
    where workspace.id=v_result.workspace_id and workspace.status='active'
      and lower(workspace.soop_id)=v_result.source_bj_id
      and v_donation.source_bj_id=v_result.source_bj_id
      and v_donation.source_chat_number=v_result.source_chat_number
  ) then raise exception 'special roulette donation ownership is invalid'
    using errcode='23514',constraint='special_roulette_donation_owner_mismatch'; end if;

  -- The relay connection key changes on process restart. The donation's
  -- wallpaper session is the server-issued broadcast identity and survives
  -- reconnects; a reused SOOP chat number must never reuse this state.
  select substring(session.source_key from 16)::uuid into v_instance
  from public.byeollog_wallpaper_tiles tile
  join public.byeollog_wallpaper_sessions session
    on session.id=tile.session_id and session.workspace_id=tile.workspace_id
  where tile.workspace_id=v_result.workspace_id and tile.donation_event_id=v_donation.id
    and session.source_key~'^soop-broadcast:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if v_instance is null then raise exception 'special roulette broadcast identity is unavailable'
    using errcode='23514',constraint='special_roulette_broadcast_missing'; end if;

  v_actor:=lower(nullif(btrim(coalesce(v_donation.actor_id,'')),''));
  v_key:='soop_result:'||v_result.provider_chat_id;
  if char_length(v_key) not between 1 and 200
    or char_length(v_result.broadcast_key) not between 1 and 200
    or char_length(v_result.result_text) not between 1 and 120
    or (v_actor is not null and char_length(v_actor)>180)
  then raise exception 'special roulette identity is invalid' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog:special-roulette:'||v_result.workspace_id::text||':'||v_instance::text||':'||coalesce(v_actor,v_key),4102));
  select receipt.* into v_receipt from private.special_roulette_receipts receipt
  where receipt.workspace_id=v_result.workspace_id and receipt.source_event_key=v_key;
  if found then
    if v_receipt.broadcast_key is distinct from v_result.broadcast_key
      or v_receipt.broadcast_instance_id is distinct from v_instance
      or v_receipt.actor_key is distinct from v_actor
      or v_receipt.result_text is distinct from v_result.result_text
    then raise exception 'special roulette receipt identity conflicts' using errcode='23514'; end if;
  else
    if not exists(select 1 from public.byeollog_soop_gateway_sessions gateway
      where gateway.workspace_id=v_result.workspace_id and gateway.broadcast_instance_id=v_instance
        and gateway.last_live_chat_number=v_result.source_chat_number
        and (gateway.broadcast_offline_since is null or gateway.broadcast_offline_since>v_now-interval '20 minutes'))
    then raise exception 'special roulette broadcast identity is stale'
      using errcode='23514',constraint='special_roulette_broadcast_mismatch'; end if;
    select true,rule.allow_stacking into v_control,v_stacking
    from public.byeollog_special_roulette_rules rule
    where rule.workspace_id=v_result.workspace_id
      and rule.result_text=normalize(btrim(v_result.result_text),NFC) and rule.enabled
      and v_donation.roulette_enabled;
    v_control:=coalesce(v_control,false);v_stacking:=coalesce(v_stacking,false);
    -- A missing donor identifier cannot create or consume another donor's state.
    if v_actor is not null then
      delete from private.special_roulette_state state
      where state.workspace_id=v_result.workspace_id and state.broadcast_instance_id=v_instance
        and state.actor_key=v_actor and state.expires_at<=v_now;
      select state.multiplier into v_pending from private.special_roulette_state state
      where state.workspace_id=v_result.workspace_id and state.broadcast_instance_id=v_instance
        and state.actor_key=v_actor for update;
      if v_control then
        v_pending:=case when v_stacking then least(100,coalesce(v_pending,1)*2) else 2 end;
        insert into private.special_roulette_state(workspace_id,broadcast_instance_id,actor_key,multiplier,source_event_key,expires_at,updated_at)
        values(v_result.workspace_id,v_instance,v_actor,v_pending,v_key,v_now+interval '12 hours',v_now)
        on conflict(workspace_id,broadcast_instance_id,actor_key) do update set
          multiplier=excluded.multiplier,source_event_key=excluded.source_event_key,
          expires_at=excluded.expires_at,updated_at=excluded.updated_at;
      else
        v_applied:=coalesce(v_pending,1);v_pending:=null;
        delete from private.special_roulette_state state
        where state.workspace_id=v_result.workspace_id and state.broadcast_instance_id=v_instance and state.actor_key=v_actor;
      end if;
    end if;
    insert into private.special_roulette_receipts(workspace_id,source_event_key,broadcast_key,broadcast_instance_id,actor_key,result_text,
      control_event,allow_stacking,applied_multiplier,pending_multiplier)
    values(v_result.workspace_id,v_key,v_result.broadcast_key,v_instance,v_actor,v_result.result_text,
      v_control,v_stacking,v_applied,v_pending) returning * into v_receipt;
  end if;
  return jsonb_build_object('version',1,'sourceEventKey',v_receipt.source_event_key,
    'appliedMultiplier',v_receipt.applied_multiplier,'controlEvent',v_receipt.control_event,
    'pendingMultiplier',v_receipt.pending_multiplier);
end
$function$;


notify pgrst,'reload schema';
commit;

