-- Subscription events are intentionally excluded from bangsel_donations, so
-- capture them directly from the authenticated Collector staging ledger. Each
-- source UID maps to one idempotent wallpaper tile and joins the same 20-minute
-- broadcast-session window as donation wallpaper tiles.

alter table public.byeollog_wallpaper_tiles
  drop constraint byeollog_wallpaper_tiles_display_kind_check,
  add constraint byeollog_wallpaper_tiles_display_kind_check check (
    display_kind in ('donation','challenge_success','subscription')
  ),
  drop constraint byeollog_wallpaper_tiles_asset_source_check,
  add constraint byeollog_wallpaper_tiles_asset_source_check check (
    asset_source in ('roulette','signature','soop','soop_default','none')
  );

create or replace function byeollog_automation.capture_wallpaper_subscription_v1()
returns trigger
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_months integer;
  v_actor_name text;
  v_session_id uuid;
  v_event_id uuid;
  v_hash text;
  v_inserted integer;
  v_broadcast_key text;
begin
  if new.validation<>'subscription'
    or coalesce(new.raw_payload->>'collector_event_kind','')<>'subscription'
    or coalesce(new.source_uid,'')=''
    or new.uploaded_at is null
    or new.uploaded_at<clock_timestamp()-interval '2 hours'
    or new.uploaded_at>clock_timestamp()+interval '5 minutes'
    or coalesce(new.raw_payload->>'subscription_months','')!~'^[1-9][0-9]{0,8}$'
  then return new; end if;

  v_months:=(new.raw_payload->>'subscription_months')::integer;
  if v_months not between 1 and 1000000000 then return new; end if;

  v_actor_name:=left(btrim(coalesce(nullif(new.nickname,''),nullif(new.soop_id,''),'익명')),120);
  if v_actor_name='' or v_actor_name~'[[:cntrl:]]' then v_actor_name:='익명'; end if;
  v_hash:=md5('wallpaper-subscription:'||new.workspace_id::text||':'||new.source_uid);
  v_event_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-'||substr(v_hash,13,4)||'-'||substr(v_hash,17,4)||'-'||substr(v_hash,21,12))::uuid;
  v_broadcast_key:='collector-broadcast:'||left(coalesce(
    nullif(new.raw_payload->>'no',''),
    nullif(new.raw_payload->>'start',''),
    nullif(new.broadcast_start_local::text,''),
    to_char(new.uploaded_at at time zone 'Asia/Seoul','YYYY-MM-DD-HH24')
  ),180);
  v_session_id:=public.ensure_wallpaper_broadcast_session_v2(
    new.workspace_id,v_broadcast_key,new.uploaded_at,'collector-subscription-v1');

  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,display_kind,asset_source,asset,received_at)
  values(
    new.workspace_id,v_session_id,v_event_id,v_actor_name,v_months,'subscription','none','{}'::jsonb,new.uploaded_at)
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

revoke all on function byeollog_automation.capture_wallpaper_subscription_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists bangsel_collector_staging_wallpaper_subscription_v1
  on public.bangsel_collector_staging;
create trigger bangsel_collector_staging_wallpaper_subscription_v1
after insert or update of validation,raw_payload,nickname,soop_id,uploaded_at,broadcast_start_local
on public.bangsel_collector_staging
for each row
when (new.validation='subscription')
execute function byeollog_automation.capture_wallpaper_subscription_v1();

create or replace function public.save_wallpaper_visible_keys_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_visible_keys text[])
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_keys text[];
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_visible_keys is null
    or cardinality(p_visible_keys)>500
    or exists(select 1 from unnest(p_visible_keys) key where key!~'^(donation|challenge_success|subscription):[1-9][0-9]{0,9}$')
  then raise exception 'wallpaper visible keys request is invalid' using errcode='22023'; end if;
  select coalesce(array_agg(distinct key order by key),'{}'::text[]) into v_keys
  from unnest(p_visible_keys) key;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper visibility revision conflict' using errcode='40001'; end if;
  update public.byeollog_wallpaper_overlay_states overlay set
    visible_group_keys=v_keys,hide_below=0,hidden_amounts='{}'::integer[],
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_visible_keys_v1(uuid,uuid,bigint,text[])
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_visible_keys_v1(uuid,uuid,bigint,text[])
  to service_role;

comment on function byeollog_automation.capture_wallpaper_subscription_v1() is
  'Captures fresh Collector subscription events as idempotent, image-free wallpaper cards in the current 20-minute broadcast session.';
comment on column public.byeollog_wallpaper_tiles.display_kind is
  'Wallpaper label contract: donation, successful challenge mission, or image-free subscription-month card.';
