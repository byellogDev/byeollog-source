-- Successful SOOP challenge-mission settlements are system donation rows, not
-- donor gifts. Capture only fresh collector inserts without changing the Agent,
-- render them as their own wallpaper card kind, and backfill Hurogi's Aug 30 card.

alter table public.byeollog_wallpaper_tiles
  add column display_kind text not null default 'donation',
  add constraint byeollog_wallpaper_tiles_display_kind_check check (
    display_kind in ('donation','challenge_success')
  );

create or replace function byeollog_automation.capture_wallpaper_challenge_success_v1()
returns trigger
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;v_event_id uuid;v_hash text;v_inserted integer;v_broadcast_key text;
begin
  if new.donation_type<>'도전성공' or new.soop_id<>'__challenge_settle__'
    or new.balloons not between 1 and 1000000000 or new.donated_at is null
    or new.donated_at<clock_timestamp()-interval '2 hours'
    or new.donated_at>clock_timestamp()+interval '5 minutes'
  then return new; end if;
  v_hash:=md5('wallpaper-challenge-success:'||new.workspace_id::text||':'||new.source_event_key);
  v_event_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-'||substr(v_hash,13,4)||'-'||substr(v_hash,17,4)||'-'||substr(v_hash,21,12))::uuid;
  v_broadcast_key:='collector-broadcast:'||left(coalesce(nullif(new.raw_payload->>'no',''),nullif(new.raw_payload->>'start',''),to_char(new.donated_at at time zone 'Asia/Seoul','YYYY-MM-DD-HH24')),180);
  v_session_id:=public.ensure_wallpaper_broadcast_session_v2(
    new.workspace_id,v_broadcast_key,new.donated_at,'collector-challenge-success-v1');
  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,display_kind,asset_source,asset,received_at)
  values(
    new.workspace_id,v_session_id,v_event_id,'도전미션 성공',new.balloons,'challenge_success','soop',
    jsonb_build_object('url','https://res.sooplive.com/images/chat/mission/m_challenge_mission_settle_01.png'),new.donated_at)
  on conflict(workspace_id,donation_event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
    update public.byeollog_wallpaper_sessions session set
      revision=session.revision+1,tile_count=session.tile_count+1,updated_at=clock_timestamp()
    where session.id=v_session_id;
    update public.byeollog_wallpaper_overlay_states overlay set
      revision=overlay.revision+1,updated_at=clock_timestamp()
    where overlay.workspace_id=new.workspace_id and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=new.workspace_id and selected.session_id=v_session_id);
  end if;
  return new;
end
$function$;

revoke all on function byeollog_automation.capture_wallpaper_challenge_success_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists bangsel_donations_wallpaper_challenge_success_v1 on public.bangsel_donations;
create trigger bangsel_donations_wallpaper_challenge_success_v1
after insert on public.bangsel_donations
for each row
when (new.donation_type='도전성공' and new.soop_id='__challenge_settle__')
execute function byeollog_automation.capture_wallpaper_challenge_success_v1();

do $function$
declare v_workspace_id uuid;v_session_id uuid;v_row public.bangsel_donations%rowtype;v_event_id uuid;v_hash text;v_inserted integer;
begin
  select workspace.id into v_workspace_id from public.byeollog_workspaces workspace
  where workspace.slug='observer_a' limit 1;
  if v_workspace_id is null then return; end if;
  select session.id into v_session_id from public.byeollog_wallpaper_sessions session
  where session.workspace_id=v_workspace_id and session.source_key='broadcast:observer_a:2026-08-30-1200'
  limit 1;
  if v_session_id is null then return; end if;
  select donation.* into v_row from public.bangsel_donations donation
  where donation.workspace_id=v_workspace_id and donation.donation_type='도전성공'
    and donation.soop_id='__challenge_settle__'
    and donation.donated_at>='2026-08-30 03:00+00'::timestamptz
    and donation.donated_at<'2026-08-31 03:00+00'::timestamptz
  order by donation.donated_at limit 1;
  if not found then return; end if;
  v_hash:=md5('wallpaper-challenge-success:'||v_workspace_id::text||':'||v_row.source_event_key);
  v_event_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-'||substr(v_hash,13,4)||'-'||substr(v_hash,17,4)||'-'||substr(v_hash,21,12))::uuid;
  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,display_kind,asset_source,asset,received_at)
  values(
    v_workspace_id,v_session_id,v_event_id,'도전미션 성공',v_row.balloons,'challenge_success','soop',
    jsonb_build_object('url','https://res.sooplive.com/images/chat/mission/m_challenge_mission_settle_01.png'),v_row.donated_at)
  on conflict(workspace_id,donation_event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
    update public.byeollog_wallpaper_sessions session set
      revision=session.revision+1,tile_count=session.tile_count+1,updated_at=clock_timestamp()
    where session.id=v_session_id;
    update public.byeollog_wallpaper_overlay_states overlay set
      revision=overlay.revision+1,updated_at=clock_timestamp()
    where overlay.workspace_id=v_workspace_id and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=v_workspace_id and selected.session_id=v_session_id);
  end if;
end
$function$;

comment on column public.byeollog_wallpaper_tiles.display_kind is
  'Wallpaper label contract: ordinary donor card or successful challenge-mission settlement card.';
comment on function byeollog_automation.capture_wallpaper_challenge_success_v1() is
  'Captures only fresh system CHALLENGE_SETTLE collector rows into the wallpaper ledger; historical imports are ignored.';
