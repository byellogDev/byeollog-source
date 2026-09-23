-- A SOOP chat number proves which live room emitted an event, but it is not a
-- permanent broadcast identifier.  Keep a server-issued broadcast instance
-- across gateway reconnects/restarts and rotate it only after a confirmed
-- offline gap (or when the verified room number changes).

alter table public.byeollog_soop_gateway_sessions
  add column if not exists broadcast_instance_id uuid,
  add column if not exists last_live_chat_number bigint,
  add column if not exists broadcast_offline_since timestamptz;

alter table public.byeollog_soop_gateway_sessions
  drop constraint if exists byeollog_soop_gateway_last_live_chat_number_check;
alter table public.byeollog_soop_gateway_sessions
  add constraint byeollog_soop_gateway_last_live_chat_number_check
  check(last_live_chat_number is null or last_live_chat_number>0);

create unique index if not exists byeollog_soop_gateway_broadcast_instance_idx
  on public.byeollog_soop_gateway_sessions(broadcast_instance_id)
  where broadcast_instance_id is not null;

-- Preserve the currently active round during rollout.  Historical rounds are
-- deliberately not rewritten; only the one current instance receives the new
-- immutable key.
update public.byeollog_soop_gateway_sessions gateway set
  last_live_chat_number=coalesce(
    gateway.chat_number,
    (select substring(session.source_key from '^soop-chat:([0-9]+)$')::bigint
     from public.byeollog_wallpaper_sessions session
     where session.workspace_id=gateway.workspace_id
       and session.state='active'
       and session.source_key~'^soop-chat:[0-9]+$'
     order by session.updated_at desc
     limit 1)),
  broadcast_instance_id=coalesce(
    gateway.broadcast_instance_id,
    case when gateway.chat_number is not null or exists(
      select 1 from public.byeollog_wallpaper_sessions session
      where session.workspace_id=gateway.workspace_id
        and session.state='active'
        and session.source_key~'^soop-chat:[0-9]+$')
    then extensions.gen_random_uuid() end),
  broadcast_offline_since=case
    when gateway.state='waiting_for_live' and gateway.last_error_code='broadcast_offline'
    then clock_timestamp()
    else gateway.broadcast_offline_since end;

update public.byeollog_wallpaper_sessions session set
  source_key='soop-broadcast:'||gateway.broadcast_instance_id::text,
  updated_at=clock_timestamp()
from public.byeollog_soop_gateway_sessions gateway
where session.workspace_id=gateway.workspace_id
  and session.state='active'
  and gateway.broadcast_instance_id is not null
  and gateway.last_live_chat_number is not null
  and session.source_key='soop-chat:'||gateway.last_live_chat_number::text
  and not exists(
    select 1 from public.byeollog_wallpaper_sessions existing
    where existing.workspace_id=session.workspace_id
      and existing.source_key='soop-broadcast:'||gateway.broadcast_instance_id::text);

create or replace function private.track_soop_broadcast_instance_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_now timestamptz:=clock_timestamp();
begin
  if tg_op='INSERT' then
    if new.state='connected' and new.chat_number is not null then
      new.broadcast_instance_id:=extensions.gen_random_uuid();
      new.last_live_chat_number:=new.chat_number;
      new.broadcast_offline_since:=null;
    elsif new.state='waiting_for_live' and new.last_error_code='broadcast_offline' then
      new.broadcast_offline_since:=v_now;
    end if;
    return new;
  end if;

  if new.state='connected' and new.chat_number is not null then
    if old.broadcast_instance_id is null
      or old.last_live_chat_number is distinct from new.chat_number
      or (old.broadcast_offline_since is not null
        and v_now-old.broadcast_offline_since>interval '20 minutes')
    then
      new.broadcast_instance_id:=extensions.gen_random_uuid();
    else
      new.broadcast_instance_id:=old.broadcast_instance_id;
    end if;
    new.last_live_chat_number:=new.chat_number;
    new.broadcast_offline_since:=null;
  else
    new.broadcast_instance_id:=old.broadcast_instance_id;
    new.last_live_chat_number:=old.last_live_chat_number;
    if new.state='waiting_for_live' and new.last_error_code='broadcast_offline' then
      new.broadcast_offline_since:=coalesce(old.broadcast_offline_since,v_now);
    else
      new.broadcast_offline_since:=old.broadcast_offline_since;
    end if;
  end if;
  return new;
end
$function$;

revoke all on function private.track_soop_broadcast_instance_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists track_soop_broadcast_instance_v1
  on public.byeollog_soop_gateway_sessions;
create trigger track_soop_broadcast_instance_v1
before insert or update of state,chat_number,heartbeat_at,last_error_code
  on public.byeollog_soop_gateway_sessions
for each row execute function private.track_soop_broadcast_instance_v1();

create or replace function public.claim_soop_broadcast_instance_v1(
  p_workspace_id uuid,p_provider_bj_id text,p_source_chat_number bigint)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='3s'
as $function$
declare
  v_instance_id uuid;
  v_expected_bj_id text;
  v_gateway public.byeollog_soop_gateway_sessions%rowtype;
  v_now timestamptz:=clock_timestamp();
begin
  if p_workspace_id is null
    or char_length(btrim(p_provider_bj_id)) not between 1 and 180
    or lower(btrim(p_provider_bj_id))!~'^[a-z0-9_.-]+$'
    or p_source_chat_number is null or p_source_chat_number<=0
  then
    raise exception 'SOOP broadcast instance claim is invalid' using errcode='22023';
  end if;

  select lower(workspace.soop_id) into v_expected_bj_id
  from public.byeollog_workspaces workspace
  where workspace.id=p_workspace_id and workspace.status='active';
  if v_expected_bj_id is null or v_expected_bj_id<>lower(btrim(p_provider_bj_id)) then
    raise exception 'SOOP broadcast owner does not match workspace'
      using errcode='23514',constraint='soop_broadcast_owner_mismatch';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));

  select gateway.* into v_gateway
  from public.byeollog_soop_gateway_sessions gateway
  where gateway.workspace_id=p_workspace_id
  for update;
  if not found then
    raise exception 'SOOP gateway session is unavailable'
      using errcode='55000';
  end if;

  if v_gateway.broadcast_instance_id is null
    or v_gateway.last_live_chat_number is distinct from p_source_chat_number
    or (v_gateway.broadcast_offline_since is not null
      and v_now-v_gateway.broadcast_offline_since>interval '20 minutes')
  then
    v_instance_id:=extensions.gen_random_uuid();
  else
    v_instance_id:=v_gateway.broadcast_instance_id;
  end if;

  update public.byeollog_soop_gateway_sessions gateway set
    broadcast_instance_id=v_instance_id,
    last_live_chat_number=p_source_chat_number,
    broadcast_offline_since=null
  where gateway.workspace_id=p_workspace_id;
  return v_instance_id;
end
$function$;

revoke all on function public.claim_soop_broadcast_instance_v1(uuid,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_soop_broadcast_instance_v1(uuid,text,bigint)
  to service_role;

create or replace function public.ensure_wallpaper_broadcast_session_v4(
  p_workspace_id uuid,p_source_key text,p_occurred_at timestamptz,
  p_release_key text,p_provider_bj_id text,p_source_chat_number bigint)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_session_id uuid;
  v_broadcast_instance_id uuid;
  v_label text;
  v_effective_key text;
  v_gateway_connected_at timestamptz;
  v_started_at timestamptz;
begin
  if p_workspace_id is null or p_occurred_at is null
    or char_length(btrim(p_source_key)) not between 1 and 200 or p_source_key~'[[:cntrl:]]'
    or char_length(btrim(p_release_key)) not between 1 and 160 or p_release_key~'[[:cntrl:]]'
    or char_length(btrim(p_provider_bj_id)) not between 1 and 180
    or p_source_chat_number is null or p_source_chat_number<=0
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

  v_broadcast_instance_id:=public.claim_soop_broadcast_instance_v1(
    p_workspace_id,p_provider_bj_id,p_source_chat_number);
  v_effective_key:='soop-broadcast:'||v_broadcast_instance_id::text;
  v_started_at:=p_occurred_at;

  select gateway.connected_at into v_gateway_connected_at
  from public.byeollog_soop_gateway_sessions gateway
  where gateway.workspace_id=p_workspace_id
    and gateway.broadcast_instance_id=v_broadcast_instance_id
    and gateway.state='connected'
    and gateway.chat_number=p_source_chat_number
    and gateway.connected_at is not null
  limit 1;

  if v_gateway_connected_at is not null
    and v_gateway_connected_at>='2026-08-31 14:25:00+00'::timestamptz
    and v_gateway_connected_at<=p_occurred_at+interval '2 minutes'
  then
    v_started_at:=date_trunc('minute',v_gateway_connected_at);
  end if;

  select session.id into v_session_id
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id
    and session.source_key=v_effective_key
  limit 1;

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

revoke all on function public.ensure_wallpaper_broadcast_session_v4(
  uuid,text,timestamptz,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.ensure_wallpaper_broadcast_session_v4(
  uuid,text,timestamptz,text,text,bigint)
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

  v_session_id:=public.ensure_wallpaper_broadcast_session_v4(
    p_workspace_id,p_broadcast_key,p_occurred_at,p_release_key,
    p_provider_bj_id,p_source_chat_number);

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
