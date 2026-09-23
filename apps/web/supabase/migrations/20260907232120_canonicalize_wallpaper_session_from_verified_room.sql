-- A donation already carries an ownership-attested SOOP room id.  Use that
-- durable event identity for wallpaper rounds instead of sampling the
-- operational heartbeat row, whose 45-second freshness window was shorter
-- than the gateway's 60-second steady-state heartbeat interval.

create or replace function public.ensure_wallpaper_broadcast_session_v3(
  p_workspace_id uuid,p_source_key text,p_occurred_at timestamptz,
  p_release_key text,p_source_chat_number bigint)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_session_id uuid;
  v_label text;
  v_effective_key text;
  v_gateway_connected_at timestamptz;
  v_started_at timestamptz;
begin
  if p_workspace_id is null or p_occurred_at is null
    or char_length(btrim(p_source_key)) not between 1 and 200 or p_source_key~'[[:cntrl:]]'
    or char_length(btrim(p_release_key)) not between 1 and 160 or p_release_key~'[[:cntrl:]]'
    or p_source_chat_number is null or p_source_chat_number<=0
    or not exists(
      select 1 from public.byeollog_workspaces workspace
      where workspace.id=p_workspace_id and workspace.status='active')
  then
    raise exception 'wallpaper broadcast session is invalid' using errcode='22023';
  end if;

  insert into public.byeollog_wallpaper_release_observations(
    workspace_id,release_key,first_seen_at,last_seen_at)
  values(p_workspace_id,btrim(p_release_key),p_occurred_at,p_occurred_at)
  on conflict(workspace_id,release_key) do update set
    last_seen_at=greatest(
      public.byeollog_wallpaper_release_observations.last_seen_at,
      excluded.last_seen_at);

  -- source_chat_number is verified by claim_soop_event_ownership_v1 and again
  -- by record_wallpaper_donation_v5 before this function is reached.
  v_effective_key:='soop-chat:'||p_source_chat_number::text;
  v_started_at:=p_occurred_at;

  select gateway.connected_at into v_gateway_connected_at
  from public.byeollog_soop_gateway_sessions gateway
  where gateway.workspace_id=p_workspace_id
    and gateway.chat_number=p_source_chat_number
    and gateway.connected_at is not null
  order by gateway.updated_at desc
  limit 1;

  if v_gateway_connected_at is not null
    and v_gateway_connected_at>='2026-08-31 14:25:00+00'::timestamptz
    and v_gateway_connected_at<=p_occurred_at+interval '2 minutes'
    and v_gateway_connected_at>=p_occurred_at-interval '24 hours'
  then
    v_started_at:=date_trunc('minute',v_gateway_connected_at);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));

  select session.id into v_session_id
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id
    and session.source_key=v_effective_key
  limit 1;

  -- Preserve the bounded compatibility path for a session created by an old
  -- release immediately before this migration.  New events no longer depend
  -- on heartbeat freshness and therefore cannot create another fallback key.
  if v_session_id is null then
    select session.id into v_session_id
    from public.byeollog_wallpaper_sessions session
    where session.workspace_id=p_workspace_id
      and session.started_at<=p_occurred_at+interval '2 minutes'
      and coalesce(session.closed_at,session.updated_at)>=p_occurred_at-interval '20 minutes'
    order by coalesce(session.closed_at,session.updated_at) desc,session.started_at desc
    limit 1;

    if v_session_id is not null and not exists(
      select 1 from public.byeollog_wallpaper_sessions existing
      where existing.workspace_id=p_workspace_id
        and existing.source_key=v_effective_key)
    then
      update public.byeollog_wallpaper_sessions session
      set source_key=v_effective_key
      where session.id=v_session_id;
    end if;
  end if;

  if v_session_id is not null then
    update public.byeollog_wallpaper_sessions session set
      state='closed',
      closed_at=greatest(session.started_at,p_occurred_at),
      updated_at=clock_timestamp()
    where session.workspace_id=p_workspace_id
      and session.state='active'
      and session.id<>v_session_id;

    update public.byeollog_wallpaper_sessions session set
      label=case when v_started_at<session.started_at
        then to_char(v_started_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송'
        else session.label end,
      started_at=least(session.started_at,v_started_at),
      state='active',
      closed_at=null,
      updated_at=clock_timestamp()
    where session.id=v_session_id;
    return v_session_id;
  end if;

  update public.byeollog_wallpaper_sessions session set
    state='closed',
    closed_at=greatest(session.started_at,p_occurred_at),
    updated_at=clock_timestamp()
  where session.workspace_id=p_workspace_id and session.state='active';

  v_label:=to_char(v_started_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송';
  insert into public.byeollog_wallpaper_sessions(
    workspace_id,source_key,label,started_at)
  values(p_workspace_id,v_effective_key,v_label,v_started_at)
  returning id into v_session_id;

  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  delete from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(
    workspace_id,session_id,position)
  values(p_workspace_id,v_session_id,0);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id;

  delete from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='closed'
    and session.closed_at<clock_timestamp()-interval '30 days';
  return v_session_id;
end
$function$;

revoke all on function public.ensure_wallpaper_broadcast_session_v3(
  uuid,text,timestamptz,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.ensure_wallpaper_broadcast_session_v3(
  uuid,text,timestamptz,text,bigint)
  to service_role;

create or replace function byeollog_automation.record_wallpaper_donation_v5(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz,p_broadcast_key text,
  p_release_key text,p_provider_bj_id text,p_source_chat_number bigint,
  p_event_fingerprint text)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_session_id uuid;
  v_asset jsonb;
  v_source text;
  v_inserted integer;
  v_provider_image_allowed boolean:=false;
begin
  if not exists(
    select 1 from public.byeollog_soop_core_donations donation
    join public.byeollog_workspaces workspace on workspace.id=donation.workspace_id
    join public.byeollog_soop_event_ownership owner
      on owner.event_fingerprint=donation.source_event_fingerprint
     and owner.workspace_id=donation.workspace_id
     and owner.provider_bj_id=donation.source_bj_id
    where donation.id=p_event_id and donation.workspace_id=p_workspace_id
      and donation.source_bj_id=lower(btrim(p_provider_bj_id))
      and donation.source_chat_number=p_source_chat_number
      and donation.source_event_fingerprint=p_event_fingerprint
      and lower(workspace.soop_id)=donation.source_bj_id)
  then
    raise exception 'wallpaper source ownership is invalid'
      using errcode='23514',constraint='wallpaper_source_owner_mismatch';
  end if;

  if p_amount between 1 and 30000 then
    select signature.wallpaper_image into v_asset
    from public.byeollog_signature_balloons signature
    where signature.workspace_id=p_workspace_id
      and signature.balloon_count=p_amount::integer;
    if v_asset is not null then v_source:='signature'; end if;
  end if;

  if v_asset is null and p_ceremony_image_url is not null then
    v_provider_image_allowed:=p_occurred_at between
      clock_timestamp()-interval '2 minutes'
      and clock_timestamp()+interval '30 seconds';
  end if;

  if v_asset is null and p_ceremony_image_url is not null
    and v_provider_image_allowed
  then
    v_source:='soop';
    v_asset:=jsonb_build_object(
      'url',p_ceremony_image_url,
      'roomChatNumber',p_source_chat_number,
      'providerBjId',lower(btrim(p_provider_bj_id)),
      'workspaceId',p_workspace_id);
  end if;

  if v_asset is null then
    v_source:='soop_default';
    v_asset:=jsonb_build_object(
      'url','https://res.sooplive.com/new_player/items/'||case
        when p_amount<=50 then 'ba_step2.png'
        when p_amount<=100 then 'ba_step3.png'
        when p_amount<=500 then 'ba_step4.png'
        when p_amount<=1000 then 'ba_step5.png'
        else 'ba_step6.png' end);
  end if;

  v_session_id:=public.ensure_wallpaper_broadcast_session_v3(
    p_workspace_id,p_broadcast_key,p_occurred_at,p_release_key,
    p_source_chat_number);

  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,
    asset_source,asset,received_at)
  values(
    p_workspace_id,v_session_id,p_event_id,btrim(p_actor_name),p_amount,
    v_source,v_asset,p_occurred_at)
  on conflict(workspace_id,donation_event_id) do nothing;
  get diagnostics v_inserted=row_count;

  if v_inserted=1 then
    update public.byeollog_wallpaper_sessions session set
      revision=session.revision+1,
      tile_count=session.tile_count+1,
      updated_at=clock_timestamp()
    where session.id=v_session_id;
    update public.byeollog_wallpaper_overlay_states overlay set
      revision=overlay.revision+1,updated_at=clock_timestamp()
    where overlay.workspace_id=p_workspace_id and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=p_workspace_id
        and selected.session_id=v_session_id);
  end if;
  return v_inserted=1;
end
$function$;

revoke all on function byeollog_automation.record_wallpaper_donation_v5(
  uuid,uuid,text,bigint,text,timestamptz,text,text,text,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function byeollog_automation.record_wallpaper_donation_v5(
  uuid,uuid,text,bigint,text,timestamptz,text,text,text,bigint,text)
  to service_role;

