-- Live ad balloons are wallpaper inputs, not monetary star-balloon rewards.
-- Preserve the existing mapping behavior for all previously supported kinds.
create or replace function private.snapshot_soop_roulette_mapping_v2()
returns trigger language plpgsql set search_path='' as $$
declare v_name text;v_spins integer;
begin
  if new.donation_type_label='애드벌룬' then
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
end $$;

create or replace function public.ingest_soop_wallpaper_adballoon_v1(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_donation_type_label text,p_ceremony_image_url text,
  p_occurred_at timestamptz,p_broadcast_key text,p_release_key text,
  p_provider_bj_id text,p_source_chat_number bigint,p_event_fingerprint text
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare v_id uuid;v_wallpaper boolean;v_broadcast_key text;
begin
  if p_workspace_id is null or p_donation_type_label is distinct from '애드벌룬'
    or not coalesce(char_length(btrim(p_event_id)) between 1 and 180,false)
    or not coalesce(char_length(btrim(p_actor_id)) between 1 and 180,false)
    or not coalesce(char_length(btrim(p_actor_name)) between 1 and 120,false)
    or not coalesce(p_amount between 1 and 1000000000,false) or p_occurred_at is null
    or not coalesce(char_length(btrim(p_broadcast_key)) between 1 and 200,false)
    or not coalesce(p_event_fingerprint ~ '^[0-9a-f]{64}$',false)
    or not coalesce(p_source_chat_number>0,false)
    or not exists(
      select 1 from public.byeollog_soop_event_ownership owner
      join public.byeollog_workspaces workspace on workspace.id=owner.workspace_id
      where owner.event_fingerprint=p_event_fingerprint and owner.workspace_id=p_workspace_id
        and owner.provider_bj_id=lower(btrim(p_provider_bj_id))
        and owner.chat_number=p_source_chat_number and lower(workspace.soop_id)=owner.provider_bj_id)
  then raise exception 'wallpaper adballoon ownership or content is invalid' using errcode='23514'; end if;

  -- The core record supplies wallpaper's existing same-workspace source FK.
  -- No bangsel_donations/staging/fixed-reward/roulette write is performed.
  insert into public.byeollog_soop_core_donations(
    workspace_id,provider_event_id,actor_id,actor_name,amount,donation_type_label,
    occurred_at,broadcast_key,source_bj_id,source_chat_number,source_event_fingerprint,
    status,roulette_enabled)
  values(p_workspace_id,btrim(p_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,'애드벌룬',
    p_occurred_at,btrim(p_broadcast_key),lower(btrim(p_provider_bj_id)),p_source_chat_number,p_event_fingerprint,
    'complete',false)
  on conflict(workspace_id,provider_event_id) do nothing returning id into v_id;
  if v_id is null then
    select donation.id into v_id from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.provider_event_id=btrim(p_event_id)
      and donation.source_bj_id=lower(btrim(p_provider_bj_id))
      and donation.source_chat_number=p_source_chat_number
      and donation.source_event_fingerprint=p_event_fingerprint
      and donation.donation_type_label='애드벌룬' and donation.amount=p_amount
      and donation.actor_id=lower(btrim(p_actor_id));
    if v_id is null then raise exception 'duplicate adballoon ownership mismatch' using errcode='23514'; end if;
    return jsonb_build_object('duplicate',true,'status','duplicate','donationId',v_id,
      'wallpaperRecorded',false,'sourceUid',null,'fixedRuleCount',0);
  end if;
  v_wallpaper:=byeollog_automation.record_wallpaper_donation_v5(
    p_workspace_id,v_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at,
    p_broadcast_key,p_release_key,p_provider_bj_id,p_source_chat_number,p_event_fingerprint);
  select s.source_key into v_broadcast_key from public.byeollog_wallpaper_tiles t
    join public.byeollog_wallpaper_sessions s on s.id=t.session_id and s.workspace_id=t.workspace_id
    where t.workspace_id=p_workspace_id and t.donation_event_id=v_id;
  if v_broadcast_key is null then raise exception 'Adballoon broadcast identity is unavailable'; end if;
  update public.byeollog_soop_core_donations set broadcast_key=v_broadcast_key
    where id=v_id and workspace_id=p_workspace_id;
  return jsonb_build_object('duplicate',false,'status','recorded','donationId',v_id,
    'wallpaperRecorded',v_wallpaper,'sourceUid',null,'fixedRuleCount',0);
end $$;
revoke all on function public.ingest_soop_wallpaper_adballoon_v1(uuid,text,text,text,bigint,text,text,timestamptz,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.ingest_soop_wallpaper_adballoon_v1(uuid,text,text,text,bigint,text,text,timestamptz,text,text,text,bigint,text) to service_role;
