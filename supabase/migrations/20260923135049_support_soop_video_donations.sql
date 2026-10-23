-- Video gifts retain wallpaper/statistics/fixed rewards without roulette waits.
-- Replace existing bodies only: ownership checks and EXECUTE ACLs are preserved.
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
      jsonb_build_object('type',case when p_donation_type_label='영상후원' then 'VIDEOBALLOON' else 'SENDBALLOON' end,'source_provider','soop_chat_sdk',
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
$function$
;

CREATE OR REPLACE FUNCTION private.snapshot_soop_roulette_mapping_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_name text;v_spins integer;
begin
  if new.donation_type_label in ('애드벌룬','영상후원') then
    new.roulette_enabled:=false;
    new.roulette_name:=null;
    new.expected_spins:=null;
    new.status:='complete';
    return new;
  end if;
  select mapping.enabled into new.roulette_enabled
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.amount between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons)
  for share;
  new.roulette_enabled:=coalesce(new.roulette_enabled,false);
  if new.roulette_name is not null or new.expected_spins is not null then return new; end if;
  select mapping.roulette_name,mapping.expected_spins into v_name,v_spins
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.amount between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons);
  new.roulette_name:=nullif(btrim(v_name),'');
  new.expected_spins:=v_spins;
  return new;
end $function$
;
