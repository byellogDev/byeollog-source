-- SOOP ceremony image URLs belong to the live room that emitted the event.
-- A past shared-renderer defect could attach one room to two workspaces. Keep
-- donation ingestion available, but never persist that room-owned image while
-- the room identity is missing, stale, or claimed by another live workspace.

create or replace function byeollog_automation.record_wallpaper_donation_v4(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz,p_broadcast_key text,p_release_key text)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_session_id uuid;v_asset jsonb;v_source text;v_inserted integer;
  v_room_chat_number bigint;v_provider_image_allowed boolean:=false;
begin
  if p_workspace_id is null or p_event_id is null or p_amount not between 1 and 1000000000
    or char_length(btrim(p_actor_name)) not between 1 and 120 or p_actor_name~'[[:cntrl:]]'
    or p_occurred_at is null or char_length(btrim(p_broadcast_key)) not between 1 and 200
  then raise exception 'wallpaper donation is invalid' using errcode='22023'; end if;

  if p_amount between 1 and 30000 then
    select signature.wallpaper_image into v_asset
    from public.byeollog_signature_balloons signature
    where signature.workspace_id=p_workspace_id and signature.balloon_count=p_amount::integer;
    if v_asset is not null then v_source:='signature'; end if;
  end if;

  if v_asset is null and p_ceremony_image_url is not null then
    select gateway.chat_number into v_room_chat_number
    from public.byeollog_soop_gateway_sessions gateway
    where gateway.workspace_id=p_workspace_id
      and gateway.state='connected'
      and gateway.chat_number is not null
      and gateway.heartbeat_at>=clock_timestamp()-interval '45 seconds';

    v_provider_image_allowed:=v_room_chat_number is not null and not exists(
      select 1
      from public.byeollog_soop_gateway_sessions other
      where other.workspace_id<>p_workspace_id
        and other.state='connected'
        and other.chat_number=v_room_chat_number
        and other.heartbeat_at>=clock_timestamp()-interval '45 seconds'
    );

    if v_provider_image_allowed then
      v_source:='soop';
      v_asset:=jsonb_build_object(
        'url',p_ceremony_image_url,
        'roomChatNumber',v_room_chat_number,
        'workspaceId',p_workspace_id
      );
    end if;
  end if;

  if v_asset is null then
    v_source:='soop_default';v_asset:=jsonb_build_object('url','https://res.sooplive.com/new_player/items/'||case
      when p_amount<=50 then 'ba_step2.png' when p_amount<=100 then 'ba_step3.png'
      when p_amount<=500 then 'ba_step4.png' when p_amount<=1000 then 'ba_step5.png' else 'ba_step6.png' end);
  end if;

  v_session_id:=public.ensure_wallpaper_broadcast_session_v2(
    p_workspace_id,p_broadcast_key,p_occurred_at,p_release_key);
  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,asset_source,asset,received_at)
  values(p_workspace_id,v_session_id,p_event_id,btrim(p_actor_name),p_amount,v_source,v_asset,p_occurred_at)
  on conflict(workspace_id,donation_event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
    update public.byeollog_wallpaper_sessions session set
      revision=session.revision+1,tile_count=session.tile_count+1,updated_at=clock_timestamp()
    where session.id=v_session_id;
    update public.byeollog_wallpaper_overlay_states overlay set
      revision=overlay.revision+1,updated_at=clock_timestamp()
    where overlay.workspace_id=p_workspace_id and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=p_workspace_id and selected.session_id=v_session_id);
  end if;
  return v_inserted=1;
end
$function$;

revoke all on function byeollog_automation.record_wallpaper_donation_v4(
  uuid,uuid,text,bigint,text,timestamptz,text,text)
  from public,anon,authenticated,service_role;

comment on function byeollog_automation.record_wallpaper_donation_v4(
  uuid,uuid,text,bigint,text,timestamptz,text,text)
  is 'Records workspace-owned wallpaper tiles; SOOP event images require a fresh, uniquely claimed live room.';
