set local lock_timeout='3s';
-- Restore the explicitly configured FIFO contract. No recency/name inference.
-- Serialize matching, invalidation and roulette receipt commits per workspace.
-- No historical rewards are automatically reassigned by this migration.
alter table public.byeollog_soop_core_roulette_results add column receipt_identity text;
-- Freeze historical numeric identities BEFORE publishing UUID identities.
-- Preserve old keys so an in-flight/partially registered batch cannot double-add.
with ranked as (
 select id,(row_number() over(partition by workspace_id,donation_id order by occurred_at,id)-1)::text identity
 from public.byeollog_soop_core_roulette_results where donation_id is not null and match_state='matched'
) update public.byeollog_soop_core_roulette_results r set receipt_identity=ranked.identity from ranked
where r.id=ranked.id and r.special_roulette is null;
update public.byeollog_soop_core_roulette_results set receipt_identity='result:'||id::text where receipt_identity is null;
alter table public.byeollog_soop_core_roulette_results alter column receipt_identity set not null;
create or replace function private.assign_soop_result_receipt_identity_v1() returns trigger language plpgsql set search_path='' as $function$
begin new.receipt_identity:='result:'||new.id::text; return new; end $function$;
create trigger assign_soop_result_receipt_identity before insert on public.byeollog_soop_core_roulette_results
for each row execute function private.assign_soop_result_receipt_identity_v1();
revoke all on function private.assign_soop_result_receipt_identity_v1() from public,anon,authenticated;

create or replace function private.same_soop_broadcast_v1(p_workspace uuid,p_donation uuid,p_old_key text,p_new_key text)
returns boolean language sql stable set search_path='' as $function$
 select p_old_key=p_new_key or exists(
  select 1 from public.byeollog_wallpaper_tiles t join public.byeollog_wallpaper_sessions s
  on s.workspace_id=t.workspace_id and s.id=t.session_id
  where t.workspace_id=p_workspace and t.donation_event_id=p_donation and s.source_key=p_new_key
    and s.source_key like 'soop-broadcast:%');
$function$;
revoke all on function private.same_soop_broadcast_v1(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function private.same_soop_broadcast_v1(uuid,uuid,text,text) to service_role;

create or replace function private.soop_broadcast_key_v1(p_workspace uuid,p_chat bigint)
returns text language plpgsql stable set search_path='' as $function$
declare v_key text;
begin
 select 'soop-broadcast:'||s.broadcast_instance_id::text into v_key
 from public.byeollog_soop_gateway_sessions s where s.workspace_id=p_workspace
   and s.last_live_chat_number=p_chat and s.broadcast_instance_id is not null;
 return v_key;
end $function$;
revoke all on function private.soop_broadcast_key_v1(uuid,bigint) from public,anon,authenticated;
grant execute on function private.soop_broadcast_key_v1(uuid,bigint) to service_role;

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
    and donation.roulette_enabled and donation.expected_spins is not null
    and not exists(select 1 from public.bangsel_roulette_invalidations i
      where i.workspace_id=donation.workspace_id and i.source_uid='soop_sdk:'||donation.provider_event_id)
    and donation.result_count<donation.expected_spins
    and donation.occurred_at<=p_occurred_at+interval '5 seconds'
  order by donation.occurred_at,donation.id
  limit 1 for update;
  if v_donation.id is not null then
    if v_donation.occurred_at<p_occurred_at-interval '10 minutes' then
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
$function$;

CREATE OR REPLACE FUNCTION private.snapshot_soop_roulette_mapping_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_name text;v_spins integer;
begin
  select mapping.enabled into new.roulette_enabled
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.amount between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons)
  for share;
  new.roulette_enabled:=coalesce(new.roulette_enabled,false);
  if new.roulette_name is not null or new.expected_spins is not null then
    return new;
  end if;
  select mapping.roulette_name,mapping.expected_spins
  into v_name,v_spins
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.amount between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons);
  new.roulette_name:=nullif(btrim(v_name),'');
  new.expected_spins:=v_spins;
  return new;
end
$function$;

CREATE OR REPLACE FUNCTION public.byeollog_ux_roulette_status_v1(p_workspace_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v jsonb;
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active') then
    raise exception 'workspace authorization failed' using errcode='42501';end if;
  with pending as (select id,actor_name,amount,roulette_name,occurred_at,result_count,expected_spins,broadcast_key,updated_at
    from public.byeollog_soop_core_donations d where workspace_id=p_workspace_id and status in ('pending','collecting')
      and roulette_enabled and expected_spins is not null and result_count<expected_spins
      and not exists(select 1 from public.bangsel_roulette_invalidations i where i.workspace_id=d.workspace_id and i.source_uid='soop_sdk:'||d.provider_event_id))
  select jsonb_build_object('checkedAt',clock_timestamp(),'pendingCount',(select count(*) from pending),
    'pending',coalesce((select jsonb_agg(to_jsonb(p) order by occurred_at,id) from (select * from pending order by occurred_at,id limit 50)p),'[]'::jsonb),
    'byAmount',coalesce((select jsonb_agg(to_jsonb(g)) from (select amount,count(*) as count from pending group by amount)g),'[]'::jsonb),
    'specialPending',coalesce((select jsonb_agg(to_jsonb(s)) from (
      select state.actor_key as soop_id,coalesce(nullif(f.alias,''),nullif(f.current_nickname,''),state.actor_key) as fan,
        state.multiplier,state.expires_at,state.updated_at from private.special_roulette_state state
        join public.byeollog_soop_gateway_sessions gateway on gateway.workspace_id=state.workspace_id and gateway.broadcast_instance_id=state.broadcast_instance_id
        left join public.bangsel_fans f on f.workspace_id=state.workspace_id and f.soop_id=state.actor_key
        where state.workspace_id=p_workspace_id and state.expires_at>clock_timestamp() order by state.updated_at desc limit 100)s),'[]'::jsonb),
    'specialRecent',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select result.result_text,result.occurred_at,result.special_roulette,d.actor_name
      from public.byeollog_soop_core_roulette_results result left join public.byeollog_soop_core_donations d on d.id=result.donation_id and d.workspace_id=result.workspace_id
      where result.workspace_id=p_workspace_id and result.special_roulette is not null
      order by result.occurred_at desc,result.id desc limit 50)r),'[]'::jsonb)) into v;
  return v;
end $function$;

CREATE OR REPLACE FUNCTION public.byeollog_dashboard_counts_v1(p_workspace_id uuid, p_user_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active') then
    raise exception 'workspace authorization failed' using errcode='42501';
  end if;
  return jsonb_build_object(
    'reviewCount',(select count(*) from public.bangsel_collector_staging where workspace_id=p_workspace_id and process_status in ('pending','needs_review','failed')),
    'pendingCount',(select count(*) from public.byeollog_soop_core_donations d where workspace_id=p_workspace_id and status in ('pending','collecting') and roulette_enabled and expected_spins is not null and result_count<expected_spins
      and not exists(select 1 from public.bangsel_roulette_invalidations i where i.workspace_id=d.workspace_id and i.source_uid='soop_sdk:'||d.provider_event_id)),
    'exceptionCount',(select count(*) from public.byeollog_soop_core_roulette_results where workspace_id=p_workspace_id and match_state<>'matched' and review_status='pending'),
    'checkedAt',clock_timestamp());
end $function$;

CREATE OR REPLACE FUNCTION public.ingest_soop_core_donation_v2(p_workspace_id uuid, p_event_id text, p_actor_id text, p_actor_name text, p_amount bigint, p_donation_type_label text, p_ceremony_image_url text, p_occurred_at timestamp with time zone, p_broadcast_key text, p_release_key text, p_provider_bj_id text, p_source_chat_number bigint, p_event_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '8s'
AS $function$
declare
  v_id uuid;v_inserted integer;v_wallpaper boolean:=false;v_source_key text;
  v_fixed_rewards jsonb:='[]'::jsonb;v_source_uid text;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 180
    or char_length(btrim(p_actor_id)) not between 1 and 180
    or char_length(btrim(p_actor_name)) not between 1 and 120
    or p_amount not between 1 and 1000000000 or p_occurred_at is null
    or p_event_fingerprint!~'^[0-9a-f]{64}$' or p_source_chat_number<=0
    or not exists(select 1 from public.byeollog_soop_event_ownership owner
      where owner.event_fingerprint=p_event_fingerprint and owner.workspace_id=p_workspace_id
        and owner.provider_bj_id=lower(btrim(p_provider_bj_id)) and owner.chat_number=p_source_chat_number)
  then raise exception 'core SOOP donation ownership is invalid' using errcode='23514',constraint='core_donation_owner_mismatch'; end if;

  v_source_key:='soop_sdk:'||btrim(p_event_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_name',rule.event_name,'upbo_type',rule.upbo_type,'quantity',rule.quantity)
    order by rule.event_name,rule.upbo_type),'[]'::jsonb)
  into v_fixed_rewards from public.byeollog_fixed_upbo_rules rule
  where rule.workspace_id=p_workspace_id and rule.balloons=p_amount;

  insert into public.byeollog_soop_core_donations(
    workspace_id,provider_event_id,actor_id,actor_name,amount,donation_type_label,
    occurred_at,broadcast_key,source_bj_id,source_chat_number,source_event_fingerprint)
  values(p_workspace_id,btrim(p_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,
    coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),p_occurred_at,btrim(p_broadcast_key),
    lower(btrim(p_provider_bj_id)),p_source_chat_number,p_event_fingerprint)
  on conflict(workspace_id,provider_event_id) do nothing returning id into v_id;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then
    select donation.id into v_id from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.provider_event_id=btrim(p_event_id)
      and donation.source_bj_id=lower(btrim(p_provider_bj_id))
      and donation.source_chat_number=p_source_chat_number
      and donation.source_event_fingerprint=p_event_fingerprint;
    if v_id is null then raise exception 'duplicate donation ownership mismatch' using errcode='23514',constraint='core_donation_duplicate_owner_mismatch'; end if;
    if jsonb_array_length(v_fixed_rewards)>0 then v_source_uid:=v_source_key; end if;
    return jsonb_build_object('duplicate',true,'status','duplicate','donationId',v_id,
      'wallpaperRecorded',false,'sourceUid',v_source_uid,'fixedRuleCount',jsonb_array_length(v_fixed_rewards));
  end if;

  v_wallpaper:=byeollog_automation.record_wallpaper_donation_v5(
    p_workspace_id,v_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at,
    p_broadcast_key,p_release_key,p_provider_bj_id,p_source_chat_number,p_event_fingerprint);
  -- Wallpaper ingestion has now claimed the persistent broadcast identity,
  -- including the first donation before the first connected heartbeat.
  select s.source_key into p_broadcast_key from public.byeollog_wallpaper_tiles t
    join public.byeollog_wallpaper_sessions s on s.id=t.session_id and s.workspace_id=t.workspace_id
    where t.workspace_id=p_workspace_id and t.donation_event_id=v_id;
  if p_broadcast_key is null then raise exception 'Donation broadcast identity is unavailable'; end if;
  update public.byeollog_soop_core_donations set broadcast_key=p_broadcast_key where id=v_id and workspace_id=p_workspace_id;
  insert into public.bangsel_donations(
    workspace_id,source_event_key,source,donation_type,donated_date,donated_time,donated_at,
    soop_id,nickname,balloons,message,had_roulette,roulette_count,roulette_results,event_name,raw_payload)
  values(p_workspace_id,v_source_key,'soop_chat_sdk',coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),
    (p_occurred_at at time zone 'Asia/Seoul')::date,(p_occurred_at at time zone 'Asia/Seoul')::time,
    p_occurred_at,lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,null,false,0,'[]'::jsonb,null,
    jsonb_build_object('source_provider','soop_chat_sdk','provider_event_id',btrim(p_event_id),
      'provider_bj_id',lower(btrim(p_provider_bj_id)),'source_chat_number',p_source_chat_number,
      'event_fingerprint',p_event_fingerprint))
  on conflict(workspace_id,source_event_key) do nothing;
  if jsonb_array_length(v_fixed_rewards)>0 then
    v_source_uid:=v_source_key;
    insert into public.bangsel_collector_staging(
      workspace_id,source_uid,session_id,donated_time_text,nickname,soop_id,balloons,roulette,
      collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,
      roulette_results,fixed_rewards,process_status,source_scope,uploaded_at)
    values(p_workspace_id,v_source_uid,btrim(p_broadcast_key),
      to_char(p_occurred_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
      btrim(p_actor_name),lower(btrim(p_actor_id)),p_amount,'','soop-chat-sdk-core-v2',
      jsonb_build_object('type','SENDBALLOON','source_provider','soop_chat_sdk',
        'provider_event_id',btrim(p_event_id),'provider_bj_id',lower(btrim(p_provider_bj_id)),
        'source_chat_number',p_source_chat_number,'event_fingerprint',p_event_fingerprint,
        'fixed_classification','server'),null,null,0,'unmapped','[]'::jsonb,
      v_fixed_rewards,'pending','soop',clock_timestamp())
    on conflict(workspace_id,source_uid) do update set
      fixed_rewards=excluded.fixed_rewards,process_status=case
        when bangsel_collector_staging.process_status in ('failed','needs_review') then 'pending'
        else bangsel_collector_staging.process_status end,
      process_error=null,uploaded_at=excluded.uploaded_at;
  end if;
  return jsonb_build_object('duplicate',false,'status','recorded','donationId',v_id,
    'wallpaperRecorded',v_wallpaper,'sourceUid',v_source_uid,
    'fixedRuleCount',jsonb_array_length(v_fixed_rewards));
end
$function$;

CREATE OR REPLACE FUNCTION public.ingest_soop_external_roulette_result_v3(p_workspace_id uuid, p_chat_event_id text, p_chat_actor_id text, p_chat_actor_name text, p_donor_name_hint text, p_roulette_name text, p_result_text text, p_raw_message text, p_occurred_at timestamp with time zone, p_broadcast_key text, p_provider_bj_id text, p_source_chat_number bigint, p_event_fingerprint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '8s'
AS $function$
declare
  v_result jsonb;v_updated integer;v_row public.byeollog_soop_core_roulette_results%rowtype;
  v_decision jsonb;v_results jsonb;v_source_uid text;
begin
  if p_workspace_id is null or p_provider_bj_id is null
    or char_length(btrim(p_provider_bj_id)) not between 1 and 180
    or lower(btrim(p_provider_bj_id))!~'^[a-z0-9_.-]+$'
    or p_source_chat_number is null or p_source_chat_number<=0
    or p_event_fingerprint is null or p_event_fingerprint!~'^[0-9a-f]{64}$'
  then raise exception 'SOOP roulette ownership is invalid' using errcode='22023'; end if;
  if not exists(
    select 1 from public.byeollog_workspaces workspace
    join public.byeollog_soop_event_ownership owner
      on owner.workspace_id=workspace.id and owner.event_fingerprint=p_event_fingerprint
     and owner.provider_bj_id=lower(btrim(p_provider_bj_id)) and owner.chat_number=p_source_chat_number
    where workspace.id=p_workspace_id and workspace.status='active'
      and lower(workspace.soop_id)=lower(btrim(p_provider_bj_id)))
  then raise exception 'SOOP roulette ownership is invalid' using errcode='23514',constraint='roulette_owner_mismatch'; end if;

  select r.broadcast_key into v_source_uid from public.byeollog_soop_core_roulette_results r
    where r.workspace_id=p_workspace_id and r.provider_chat_id=btrim(p_chat_event_id);
  p_broadcast_key:=coalesce(v_source_uid,private.soop_broadcast_key_v1(p_workspace_id,p_source_chat_number),p_broadcast_key);
  -- v2 holds the workspace+broadcast FIFO lock until this whole transaction ends.
  v_result:=public.ingest_soop_external_roulette_result_v2(
    p_workspace_id,p_chat_event_id,p_chat_actor_id,p_chat_actor_name,p_donor_name_hint,
    p_roulette_name,p_result_text,p_raw_message,p_occurred_at,p_broadcast_key);
  update public.byeollog_soop_core_roulette_results result set
    source_bj_id=lower(btrim(p_provider_bj_id)),source_chat_number=p_source_chat_number,
    source_event_fingerprint=p_event_fingerprint
  where result.workspace_id=p_workspace_id and result.provider_chat_id=btrim(p_chat_event_id)
    and ((result.source_bj_id is null and result.source_chat_number is null and result.source_event_fingerprint is null)
      or (result.source_bj_id=lower(btrim(p_provider_bj_id))
        and result.source_chat_number=p_source_chat_number and result.source_event_fingerprint=p_event_fingerprint));
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'SOOP roulette result provenance conflicts with stored row'
    using errcode='23514',constraint='roulette_result_owner_mismatch'; end if;
  select result.* into v_row from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.provider_chat_id=btrim(p_chat_event_id);
  if v_row.broadcast_key is distinct from btrim(p_broadcast_key)
    or v_row.result_text is distinct from btrim(p_result_text)
  then raise exception 'SOOP roulette result identity conflicts with stored row' using errcode='23514'; end if;

  -- A retry of an old row never consumes current pending state or current rules.
  if coalesce((v_result->>'duplicate')::boolean,false) or v_row.match_state<>'matched' then
    return v_result;
  end if;
  -- Installing the additive schema must not change the old server's ledger
  -- identities before promotion. An unconfigured workspace stays on its old
  -- result format. Once used, receipts keep the new identities stable even
  -- after every rule and pending multiplier has been removed.
  if not exists(select 1 from public.byeollog_special_roulette_rules rule
      where rule.workspace_id=p_workspace_id and rule.enabled)
    and not exists(select 1 from private.special_roulette_receipts receipt
      where receipt.workspace_id=p_workspace_id)
    and not exists(select 1 from private.special_roulette_state state
      where state.workspace_id=p_workspace_id)
  then return v_result; end if;
  v_decision:=private.resolve_special_roulette_result_v1(v_row.id);
  update public.byeollog_soop_core_roulette_results set special_roulette=v_decision where id=v_row.id;
  select jsonb_agg(jsonb_build_object('result',result.result_text,'probability','','receipt_identity',result.receipt_identity)||
      case when result.special_roulette is null then '{}'::jsonb
        else jsonb_build_object('special_roulette',result.special_roulette) end
      order by result.occurred_at,result.id)
  into v_results from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.donation_id=v_row.donation_id and result.match_state='matched';
  select 'soop_sdk:'||donation.provider_event_id into v_source_uid
  from public.byeollog_soop_core_donations donation
  where donation.id=v_row.donation_id and donation.workspace_id=p_workspace_id;
  update public.bangsel_collector_staging set roulette_results=v_results
  where workspace_id=p_workspace_id and source_uid=v_source_uid;
  update public.bangsel_donations set roulette_results=v_results
  where workspace_id=p_workspace_id and source_event_key=v_source_uid;
  return v_result;
end
$function$;

CREATE OR REPLACE FUNCTION private.resolve_special_roulette_result_v1(p_result_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
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
    and private.same_soop_broadcast_v1(donation.workspace_id,donation.id,donation.broadcast_key,v_result.broadcast_key);
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

-- A configuration edit affects subsequent donations only.
create or replace function public.reapply_roulette_amount_mapping_v1() returns trigger
language plpgsql security definer set search_path='' as $function$
begin return new; end $function$;
create or replace function public.apply_roulette_amount_mapping_to_staging_v1() returns trigger
language plpgsql security definer set search_path='' as $function$
declare v_name text;
begin
 if new.raw_payload->>'source_provider'='soop_chat_sdk' then
  select d.roulette_name into v_name from public.byeollog_soop_core_donations d
  where d.workspace_id=new.workspace_id and 'soop_sdk:'||d.provider_event_id=new.source_uid;
  if found then new.event_name:=v_name; end if;
 end if;
 return new;
end $function$;

CREATE OR REPLACE FUNCTION public.byeollog_reverse_fan_rows_v1(p_workspace_id uuid, p_id uuid)
 RETURNS TABLE(fan_id text, nickname text, donation_count bigint, balloons bigint, refund bigint, paid bigint, paid_at text, payable boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET statement_timeout TO '8s'
AS $function$
 with c as (select * from public.byeollog_reverse_fan_days where workspace_id=p_workspace_id and id=p_id),
 donations as (
  select case when coalesce(btrim(d.soop_id),'')='' then 'unknown:'||d.source_event_key else lower(btrim(d.soop_id)) end fan_id,
   (array_agg(d.nickname order by d.donated_at desc,d.source_event_key desc))[1] nickname,
   count(*) donation_count,sum(d.balloons)::bigint balloons,
   sum((d.balloons::bigint*(r->>'rateBp')::bigint)/10000)::bigint refund,bool_and(coalesce(btrim(d.soop_id),'')<>'') payable
  from c join public.bangsel_donations d on d.workspace_id=c.workspace_id and d.donated_at>=c.starts_at and d.donated_at<c.ends_at
  cross join lateral jsonb_array_elements(c.rules) r
  where d.balloons between (r->>'min')::integer and (r->>'max')::integer
   and d.donation_type not in ('구독','도전성공')
   and coalesce(lower(btrim(d.soop_id)),'')<>'__challenge_settle__'
  group by 1
 ), payments as (
  select p.key fan_id,p.value from c cross join lateral jsonb_each(c.payments) p
 )
 select coalesce(d.fan_id,p.fan_id),coalesce(nullif(d.nickname,''),p.value->>'nickname',d.fan_id,p.fan_id),
  coalesce(d.donation_count,0),coalesce(d.balloons,0),coalesce(d.refund,0),coalesce((p.value->>'amount')::bigint,0),p.value->>'at',coalesce(d.payable,false)
 from donations d full join payments p on p.fan_id=d.fan_id;
$function$;

CREATE OR REPLACE FUNCTION public.byeollog_commit_upbo_group_v1(p_workspace_id uuid, p_group jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '8s'
AS $function$
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
  -- Same lock as voiding and matching. Covers old and new web processors.
  if coalesce(p_group->>'source','')<>'collector_fixed_rule' then
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
    -- An old in-flight processor must retry after the web promotion rather
    -- than writing positional keys for a newly identified result.
    if coalesce(p_group->>'receiptProtocol','')<>'2' and exists(
      select 1 from unnest(v_keys) k join public.bangsel_collector_staging s
       on s.workspace_id=p_workspace_id and s.source_uid=split_part(k,'|',1)
      cross join lateral jsonb_array_elements(s.roulette_results) r
      where split_part(k,'|',2)~'^[0-9]+$' and r->>'receipt_identity' like 'result:%') then
      raise exception '룰렛 처리기 업데이트 후 재시도합니다.' using errcode='40001';
    end if;
    if exists(select 1 from public.bangsel_roulette_invalidations i
      cross join unnest(v_keys) k where i.workspace_id=p_workspace_id
      and (left(k,length(i.source_uid)+1)=i.source_uid||'|'
        or left(k,length(i.source_uid)+8)='weflab:'||i.source_uid||'|')) then
      raise exception '무효 처리된 룰렛은 업보에 등록할 수 없습니다.' using errcode='23514';
    end if;
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
end $function$;

create or replace function public.bangsel_void_roulette_ws(p_workspace_id uuid,p_source_uid text,p_reason text default null)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $function$
declare
 v_prefix text;v_removed int:=0;v_tasks int:=0;v_new int;v_key text;v_deleted int;v_already boolean;
 rec record;v_task public.bangsel_tasks%rowtype;
begin
 if p_workspace_id is null or nullif(btrim(p_source_uid),'') is null then raise exception 'source is required'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
 if not exists(select 1 from public.bangsel_collector_staging where workspace_id=p_workspace_id and source_uid=p_source_uid) then raise exception 'Collector source not found'; end if;
 v_prefix:=case when p_source_uid like 'soop_sdk:%' or p_source_uid like 'weflab:%' then p_source_uid else 'weflab:'||p_source_uid end||'|';
 select exists(select 1 from public.bangsel_roulette_invalidations where workspace_id=p_workspace_id and source_uid=p_source_uid) into v_already;
 -- Task locks protect manual completion/quantity edits and other contributions.
 perform t.id from public.bangsel_tasks t where t.workspace_id=p_workspace_id and exists(
  select 1 from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id and i.task_id=t.id and starts_with(i.source_event_key,v_prefix)) order by t.id for update;
 if exists(select 1 from public.bangsel_task_import_items i join public.bangsel_tasks t on t.id=i.task_id and t.workspace_id=i.workspace_id
  where i.workspace_id=p_workspace_id and starts_with(i.source_event_key,v_prefix) and t.done_qty>0) then
  raise exception '완료 처리된 업보가 연결되어 있어 룰렛을 무효화할 수 없습니다.';
 end if;
 for rec in select i.task_id,count(*)::int remove_count from public.bangsel_task_import_items i
  where i.workspace_id=p_workspace_id and starts_with(i.source_event_key,v_prefix) group by i.task_id order by i.task_id loop
  select * into v_task from public.bangsel_tasks where workspace_id=p_workspace_id and id=rec.task_id;
  v_new:=v_task.total_qty-rec.remove_count;
  -- A manually reduced quantity cannot safely be attributed to this donation.
  if v_new<0 then raise exception '수량이 변경된 업보입니다. 연결된 수량을 확인해주세요.'; end if;
  delete from public.bangsel_task_import_items where workspace_id=p_workspace_id and task_id=rec.task_id and starts_with(source_event_key,v_prefix);
  get diagnostics v_deleted=row_count; v_removed:=v_removed+v_deleted;
  select source_event_key into v_key from public.bangsel_task_import_items where workspace_id=p_workspace_id and task_id=rec.task_id order by source_event_key limit 1;
  if v_new=0 then
   if v_key is not null then raise exception '다른 후원의 수량이 연결된 업보입니다. 수량을 확인해주세요.'; end if;
   delete from public.bangsel_tasks where workspace_id=p_workspace_id and id=rec.task_id;
  else
   update public.bangsel_tasks set total_qty=v_new,
    source_event_key=case when starts_with(coalesce(source_event_key,''),v_prefix) or starts_with(coalesce(source_event_key,''),p_workspace_id::text||':'||v_prefix)
      then case when v_key is null then null else p_workspace_id::text||':'||v_key end else source_event_key end
    where workspace_id=p_workspace_id and id=rec.task_id;
  end if;
  v_tasks:=v_tasks+1;
 end loop;
 insert into public.bangsel_roulette_invalidations(workspace_id,source_uid,reason) values(p_workspace_id,p_source_uid,nullif(btrim(coalesce(p_reason,'')),'')) on conflict(workspace_id,source_uid) do nothing;
 update public.byeollog_soop_core_donations set status='expired',updated_at=clock_timestamp()
 where workspace_id=p_workspace_id and 'soop_sdk:'||provider_event_id=p_source_uid;
 -- Cancel only a still-pending multiplier sourced by this invalidated result.
 -- Previously consumed multipliers are not guessed/replayed.
 delete from private.special_roulette_state s using public.byeollog_soop_core_roulette_results r,public.byeollog_soop_core_donations d
 where s.workspace_id=p_workspace_id and r.workspace_id=s.workspace_id and d.workspace_id=r.workspace_id and r.donation_id=d.id
   and 'soop_sdk:'||d.provider_event_id=p_source_uid and s.source_event_key='soop_result:'||r.provider_chat_id;
 return jsonb_build_object('ok',true,'already_voided',v_already,'removed_links',v_removed,'affected_tasks',v_tasks);
end $function$;
revoke all on function public.bangsel_void_roulette_ws(uuid,text,text) from public,anon,authenticated;
grant execute on function public.bangsel_void_roulette_ws(uuid,text,text) to service_role;


