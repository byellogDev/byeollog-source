-- Optional per-tile wallpaper layout. Null coordinates keep the existing
-- automatic packing behavior, so this migration is backward compatible.

alter table public.byeollog_wallpaper_tiles
  add column layout_x integer,
  add column layout_y integer,
  add column layout_width integer,
  add column layout_height integer,
  add column layout_updated_at timestamptz,
  add constraint byeollog_wallpaper_tiles_layout_complete_check check (
    (layout_x is null and layout_y is null and layout_width is null and layout_height is null)
    or
    (layout_x is not null and layout_y is not null and layout_width is not null and layout_height is not null)
  ),
  add constraint byeollog_wallpaper_tiles_layout_bounds_check check (
    layout_x is null or (
      layout_x between 0 and 1919
      and layout_y between 0 and 1079
      and layout_width between 80 and 1920
      and layout_height between 60 and 1080
      and layout_x + layout_width <= 1920
      and layout_y + layout_height <= 1080
    )
  );

create or replace function public.save_wallpaper_layout_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_expected_revision bigint,
  p_tiles jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_revision bigint;
  v_tile_count integer;
  v_matched_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);

  if p_session_id is null or p_expected_revision is null or p_expected_revision < 0
    or p_tiles is null
    or jsonb_typeof(p_tiles) <> 'array'
    or jsonb_array_length(p_tiles) > 108
  then raise exception 'wallpaper layout request is invalid' using errcode='22023'; end if;

  select session.revision into v_revision
  from public.byeollog_wallpaper_sessions session
  where session.id=p_session_id and session.workspace_id=p_workspace_id and session.state='active'
  for update;
  if not found then raise exception 'wallpaper session was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then
    raise exception 'wallpaper layout revision conflict' using errcode='40001';
  end if;

  select count(*) into v_tile_count from jsonb_array_elements(p_tiles) item;
  if exists(
    select 1 from jsonb_array_elements(p_tiles) item
    where jsonb_typeof(item)<>'object'
      or jsonb_typeof(item->'id')<>'string'
      or jsonb_typeof(item->'x')<>'number'
      or jsonb_typeof(item->'y')<>'number'
      or jsonb_typeof(item->'width')<>'number'
      or jsonb_typeof(item->'height')<>'number'
      or (item->>'x')!~'^[-]?[0-9]+$'
      or (item->>'y')!~'^[-]?[0-9]+$'
      or (item->>'width')!~'^[0-9]+$'
      or (item->>'height')!~'^[0-9]+$'
  ) then raise exception 'wallpaper tile layout is invalid' using errcode='22023'; end if;

  if exists(
    select 1
    from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
    where tile.x<0 or tile.y<0 or tile.width<80 or tile.height<60
      or tile.x+tile.width>1920 or tile.y+tile.height>1080
  ) then raise exception 'wallpaper tile layout is out of bounds' using errcode='22023'; end if;

  if (
    select count(distinct tile.id)
    from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
  )<>v_tile_count then raise exception 'wallpaper tile layout contains duplicates' using errcode='22023'; end if;

  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
    on tile.id=stored.id
  where stored.workspace_id=p_workspace_id and stored.session_id=p_session_id;
  if v_matched_count<>v_tile_count then
    raise exception 'wallpaper tile does not belong to the active session' using errcode='22023';
  end if;

  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,layout_y=tile.y,layout_width=tile.width,layout_height=tile.height,
    layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
  where stored.id=tile.id and stored.workspace_id=p_workspace_id and stored.session_id=p_session_id;

  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,updated_at=clock_timestamp()
  where session.id=p_session_id
  returning session.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_layout_v1(uuid,uuid,uuid,bigint,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_layout_v1(uuid,uuid,uuid,bigint,jsonb)
  to service_role;

create or replace function public.clear_wallpaper_layout_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  select session.revision into v_revision
  from public.byeollog_wallpaper_sessions session
  where session.id=p_session_id and session.workspace_id=p_workspace_id and session.state='active'
  for update;
  if not found then raise exception 'wallpaper session was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then
    raise exception 'wallpaper layout revision conflict' using errcode='40001';
  end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=null,layout_y=null,layout_width=null,layout_height=null,layout_updated_at=null
  where stored.workspace_id=p_workspace_id and stored.session_id=p_session_id
    and stored.layout_x is not null;
  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,updated_at=clock_timestamp()
  where session.id=p_session_id
  returning session.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.clear_wallpaper_layout_v1(uuid,uuid,uuid,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.clear_wallpaper_layout_v1(uuid,uuid,uuid,bigint)
  to service_role;
