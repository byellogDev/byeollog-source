-- Use the first successful SOOP live connection as the wallpaper broadcast
-- start. Donations may arrive much later and must not rename the round to the
-- first donation time. A gateway reconnect within 20 minutes keeps the same
-- connected_at value; an existing earlier session start is never moved later.

create or replace function public.ensure_wallpaper_broadcast_session_v2(
  p_workspace_id uuid,p_source_key text,p_occurred_at timestamptz,p_release_key text)
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
  v_chat_number bigint;
  v_gateway_connected_at timestamptz;
  v_started_at timestamptz;
begin
  if p_workspace_id is null or p_occurred_at is null
    or char_length(btrim(p_source_key)) not between 1 and 200 or p_source_key~'[[:cntrl:]]'
    or char_length(btrim(p_release_key)) not between 1 and 160 or p_release_key~'[[:cntrl:]]'
    or not exists(select 1 from public.byeollog_workspaces workspace where workspace.id=p_workspace_id and workspace.status='active')
  then raise exception 'wallpaper broadcast session is invalid' using errcode='22023'; end if;
  insert into public.byeollog_wallpaper_release_observations(workspace_id,release_key,first_seen_at,last_seen_at)
  values(p_workspace_id,btrim(p_release_key),p_occurred_at,p_occurred_at)
  on conflict(workspace_id,release_key) do update set
    last_seen_at=greatest(public.byeollog_wallpaper_release_observations.last_seen_at,excluded.last_seen_at);
  select gateway.chat_number,gateway.connected_at into v_chat_number,v_gateway_connected_at
  from public.byeollog_soop_gateway_sessions gateway
  where gateway.workspace_id=p_workspace_id and gateway.state='connected'
    and gateway.heartbeat_at>=clock_timestamp()-interval '45 seconds';
  v_effective_key:=case when v_chat_number is not null then 'soop-chat:'||v_chat_number::text else btrim(p_source_key) end;
  v_started_at:=p_occurred_at;
  if v_gateway_connected_at is not null
    -- Older gateway builds reported the worker boot time here. Accept only
    -- values produced after this connection-time rollout.
    and v_gateway_connected_at>='2026-08-31 14:25:00+00'::timestamptz
    and v_gateway_connected_at<=p_occurred_at+interval '2 minutes'
    and v_gateway_connected_at>=p_occurred_at-interval '24 hours'
  then v_started_at:=date_trunc('minute',v_gateway_connected_at); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  select session.id into v_session_id
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.source_key=v_effective_key
  limit 1;
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
      where existing.workspace_id=p_workspace_id and existing.source_key=v_effective_key
    ) then
      update public.byeollog_wallpaper_sessions session set source_key=v_effective_key
      where session.id=v_session_id;
    end if;
  end if;
  if v_session_id is not null then
    update public.byeollog_wallpaper_sessions session set
      state='closed',closed_at=greatest(session.started_at,p_occurred_at),updated_at=clock_timestamp()
    where session.workspace_id=p_workspace_id and session.state='active' and session.id<>v_session_id;
    update public.byeollog_wallpaper_sessions session set
      label=case when v_started_at<session.started_at
        then to_char(v_started_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송'
        else session.label end,
      started_at=least(session.started_at,v_started_at),
      state='active',closed_at=null,updated_at=clock_timestamp()
    where session.id=v_session_id;
    return v_session_id;
  end if;
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=greatest(session.started_at,p_occurred_at),updated_at=clock_timestamp()
  where session.workspace_id=p_workspace_id and session.state='active';
  v_label:=to_char(v_started_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송';
  insert into public.byeollog_wallpaper_sessions(workspace_id,source_key,label,started_at)
  values(p_workspace_id,v_effective_key,v_label,v_started_at)
  returning id into v_session_id;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  delete from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
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

revoke all on function public.ensure_wallpaper_broadcast_session_v2(uuid,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ensure_wallpaper_broadcast_session_v2(uuid,text,timestamptz,text)
  to service_role;

-- The 2026-08-31 observer_a round began at 19:00 KST. It was originally created
-- by its first donation at 19:50, before connection-time tracking existed.
update public.byeollog_wallpaper_sessions session set
  label='08월 31일 19:00 방송',
  started_at='2026-08-31 10:00:00+00'::timestamptz,
  updated_at=clock_timestamp()
from public.byeollog_workspaces workspace
where workspace.id=session.workspace_id and workspace.slug='observer_a'
  and session.state='active'
  and session.started_at between '2026-08-31 10:45:00+00'::timestamptz
    and '2026-08-31 10:55:00+00'::timestamptz;

comment on function public.ensure_wallpaper_broadcast_session_v2(uuid,text,timestamptz,text) is
  'Creates or reconnects a 20-minute wallpaper broadcast round using the first successful SOOP gateway connection time instead of the first donation time.';


