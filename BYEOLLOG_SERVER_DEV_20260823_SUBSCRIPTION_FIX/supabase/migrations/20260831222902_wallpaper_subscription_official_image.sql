-- Preserve SOOP's official subscription ceremony image instead of degrading
-- every subscription wallpaper to a text-only card. The Collector already
-- keeps the provider field in raw_payload; this migration validates its host,
-- updates the capture trigger, and repairs existing matched wallpaper tiles.

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
  v_existing_session_id uuid;
  v_event_id uuid;
  v_hash text;
  v_inserted integer;
  v_broadcast_key text;
  v_image_url text;
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
  v_image_url:=left(btrim(coalesce(
    nullif(new.raw_payload->>'imageUrl',''),
    nullif(new.raw_payload->>'image_url',''),
    nullif(new.raw_payload->>'img',''),
    nullif(new.raw_payload->>'image','')
  )),2048);
  if v_image_url like '//%' then v_image_url:='https:'||v_image_url;
  elsif v_image_url like '/%' then v_image_url:='https://res.sooplive.com'||v_image_url;
  elsif v_image_url~*'^http://' then v_image_url:='https://'||substr(v_image_url,8);
  end if;
  v_image_url:=regexp_replace(v_image_url,'#.*$','');
  if v_image_url='' or v_image_url~'[[:cntrl:]]'
    or v_image_url!~*'^https://([a-z0-9-]+\.)*(sooplive\.com|afreecatv\.com|afreecatvcdn\.com)/'
  then v_image_url:=null; end if;

  v_hash:=md5('wallpaper-subscription:'||new.workspace_id::text||':'||new.source_uid);
  v_event_id:=(substr(v_hash,1,8)||'-'||substr(v_hash,9,4)||'-'||substr(v_hash,13,4)||'-'||substr(v_hash,17,4)||'-'||substr(v_hash,21,12))::uuid;

  if v_image_url is not null then
    update public.byeollog_wallpaper_tiles tile set
      asset_source='soop',asset=jsonb_build_object('url',v_image_url)
    where tile.workspace_id=new.workspace_id
      and tile.donation_event_id=v_event_id
      and tile.display_kind='subscription'
      and (tile.asset_source<>'soop' or tile.asset->>'url' is distinct from v_image_url)
    returning tile.session_id into v_existing_session_id;
    if v_existing_session_id is not null then
      update public.byeollog_wallpaper_sessions session set
        revision=session.revision+1,updated_at=clock_timestamp()
      where session.id=v_existing_session_id;
      update public.byeollog_wallpaper_overlay_states overlay set
        revision=overlay.revision+1,updated_at=clock_timestamp()
      where overlay.workspace_id=new.workspace_id and exists(
        select 1 from public.byeollog_wallpaper_overlay_sessions selected
        where selected.workspace_id=new.workspace_id and selected.session_id=v_existing_session_id);
      return new;
    end if;
  end if;

  v_broadcast_key:='collector-broadcast:'||left(coalesce(
    nullif(new.raw_payload->>'no',''),
    nullif(new.raw_payload->>'start',''),
    nullif(new.broadcast_start_local::text,''),
    to_char(new.uploaded_at at time zone 'Asia/Seoul','YYYY-MM-DD-HH24')
  ),180);
  v_session_id:=public.ensure_wallpaper_broadcast_session_v2(
    new.workspace_id,v_broadcast_key,new.uploaded_at,'collector-subscription-v2');

  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,display_kind,asset_source,asset,received_at)
  values(
    new.workspace_id,v_session_id,v_event_id,v_actor_name,v_months,'subscription',
    case when v_image_url is null then 'none' else 'soop' end,
    case when v_image_url is null then '{}'::jsonb else jsonb_build_object('url',v_image_url) end,
    new.uploaded_at)
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

with source_rows as (
  select
    staging.workspace_id,
    (
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),1,8)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),9,4)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),13,4)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),17,4)||'-'||
      substr(md5('wallpaper-subscription:'||staging.workspace_id::text||':'||staging.source_uid),21,12)
    )::uuid as event_id,
    case
      when image.raw_url like '//%' then 'https:'||image.raw_url
      when image.raw_url like '/%' then 'https://res.sooplive.com'||image.raw_url
      when image.raw_url~*'^http://' then 'https://'||substr(image.raw_url,8)
      else image.raw_url
    end as image_url
  from public.bangsel_collector_staging staging
  cross join lateral (select left(btrim(coalesce(
    nullif(staging.raw_payload->>'imageUrl',''),
    nullif(staging.raw_payload->>'image_url',''),
    nullif(staging.raw_payload->>'img',''),
    nullif(staging.raw_payload->>'image','')
  )),2048) as raw_url) image
  where staging.validation='subscription'
    and coalesce(staging.raw_payload->>'collector_event_kind','')='subscription'
    and coalesce(staging.source_uid,'')<>''
), valid_source_rows as (
  select workspace_id,event_id,regexp_replace(image_url,'#.*$','') as image_url
  from source_rows
  where image_url<>'' and image_url!~'[[:cntrl:]]'
    and image_url~*'^https://([a-z0-9-]+\.)*(sooplive\.com|afreecatv\.com|afreecatvcdn\.com)/'
), updated_tiles as (
  update public.byeollog_wallpaper_tiles tile set
    asset_source='soop',asset=jsonb_build_object('url',source.image_url)
  from valid_source_rows source
  where tile.workspace_id=source.workspace_id
    and tile.donation_event_id=source.event_id
    and tile.display_kind='subscription'
    and (tile.asset_source<>'soop' or tile.asset->>'url' is distinct from source.image_url)
  returning tile.workspace_id,tile.session_id
), updated_sessions as (
  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,updated_at=clock_timestamp()
  where session.id in (select distinct session_id from updated_tiles)
  returning session.id,session.workspace_id
)
update public.byeollog_wallpaper_overlay_states overlay set
  revision=overlay.revision+1,updated_at=clock_timestamp()
where exists(
  select 1 from updated_sessions session
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=session.workspace_id and selected.session_id=session.id
  where session.workspace_id=overlay.workspace_id);

comment on function byeollog_automation.capture_wallpaper_subscription_v1() is
  'Captures fresh Collector subscriptions with an allow-listed SOOP official ceremony image and text-only fallback in the current 20-minute broadcast session.';
comment on column public.byeollog_wallpaper_tiles.display_kind is
  'Wallpaper label contract: donation, successful challenge mission, or subscription-month card with an optional official SOOP image.';
