begin;
set local lock_timeout='1s';
set local statement_timeout='10s';

-- The gateway uses this boundary for external result chats only. A disabled
-- workspace produces no ownership, result, staging or exception writes. The
-- normal donation and wallpaper ingestion functions remain unchanged.
create or replace function public.ingest_soop_external_roulette_result_v4(
  p_workspace_id uuid,p_chat_event_id text,p_chat_actor_id text,p_chat_actor_name text,
  p_donor_name_hint text,p_roulette_name text,p_result_text text,p_raw_message text,
  p_occurred_at timestamptz,p_broadcast_key text,p_provider_bj_id text,
  p_source_chat_number bigint,p_event_fingerprint text)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s'
as $function$
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
  if not exists(select 1 from public.byeollog_roulette_amount_mappings m
      where m.workspace_id=p_workspace_id and m.enabled) then
    v_key:=coalesce(private.soop_broadcast_key_v1(p_workspace_id,p_source_chat_number),p_broadcast_key);
    select d.occurred_at into v_head_at
    from public.byeollog_soop_core_donations d
    where d.workspace_id=p_workspace_id
      and private.same_soop_broadcast_v1(p_workspace_id,d.id,d.broadcast_key,btrim(v_key))
      and d.status in ('pending','collecting') and d.roulette_enabled
      and d.expected_spins is not null and d.result_count<d.expected_spins
      and d.occurred_at<=p_occurred_at+interval '5 seconds'
      and not exists(select 1 from public.bangsel_roulette_invalidations i
        where i.workspace_id=d.workspace_id and i.source_uid='soop_sdk:'||d.provider_event_id)
    order by d.occurred_at,d.id limit 1;
    -- Reuse the existing FIFO ten-minute eligibility limit. Never skip a
    -- stale FIFO head or revive pending donations from another broadcast.
    if v_head_at is null or v_head_at<p_occurred_at-interval '10 minutes' then
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
$function$;
revoke all on function public.ingest_soop_external_roulette_result_v4(uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.ingest_soop_external_roulette_result_v4(uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text) to service_role;
commit;
