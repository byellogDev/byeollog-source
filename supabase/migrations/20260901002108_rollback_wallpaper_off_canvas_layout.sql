-- Restore wallpaper placement to the actual 1920x1080 OBS canvas.
-- Existing off-canvas layouts are clamped before the strict constraint returns.

create temporary table _wallpaper_off_canvas_workspaces on commit drop as
select distinct workspace_id
from public.byeollog_wallpaper_tiles
where layout_x is not null
  and (layout_x < 0 or layout_y < 0 or layout_x + layout_width > 1920 or layout_y + layout_height > 1080);

with normalized as (
  select id,
    least(layout_width,1920) as next_width,
    least(layout_height,1080) as next_height,
    greatest(0,least(layout_x,1920-least(layout_width,1920))) as next_x,
    greatest(0,least(layout_y,1080-least(layout_height,1080))) as next_y
  from public.byeollog_wallpaper_tiles
  where layout_x is not null
    and (layout_x < 0 or layout_y < 0 or layout_x + layout_width > 1920 or layout_y + layout_height > 1080)
)
update public.byeollog_wallpaper_tiles tile set
  layout_x=normalized.next_x,
  layout_y=normalized.next_y,
  layout_width=normalized.next_width,
  layout_height=normalized.next_height,
  layout_updated_at=clock_timestamp()
from normalized
where tile.id=normalized.id;

update public.byeollog_wallpaper_overlay_states overlay set
  revision=overlay.revision+1,
  updated_at=clock_timestamp()
where overlay.workspace_id in (select workspace_id from _wallpaper_off_canvas_workspaces);

alter table public.byeollog_wallpaper_tiles
  drop constraint if exists byeollog_wallpaper_tiles_layout_bounds_check;

alter table public.byeollog_wallpaper_tiles
  add constraint byeollog_wallpaper_tiles_layout_bounds_check check (
    layout_x is null or (
      layout_x >= 0
      and layout_y >= 0
      and layout_width between 80 and 1920
      and layout_height between 60 and 1080
      and layout_x + layout_width <= 1920
      and layout_y + layout_height <= 1080
    )
  );

create or replace function public.save_wallpaper_overlay_layout_v2(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_tiles jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_tile_count integer;v_matched_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_tiles is null
    or jsonb_typeof(p_tiles)<>'array' or jsonb_array_length(p_tiles)>216
  then raise exception 'wallpaper layout request is invalid' using errcode='22023'; end if;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='40001'; end if;
  select count(*) into v_tile_count from jsonb_array_elements(p_tiles);
  if exists(select 1 from jsonb_array_elements(p_tiles) item where jsonb_typeof(item)<>'object'
    or jsonb_typeof(item->'id')<>'string' or (item->>'x')!~'^[0-9]+$' or (item->>'y')!~'^[0-9]+$'
    or (item->>'width')!~'^[0-9]+$' or (item->>'height')!~'^[0-9]+$'
    or (item->>'columns')!~'^[0-9]+$' or (item->>'rows')!~'^[0-9]+$'
    or jsonb_typeof(item->'next_side')<>'string' or (item->>'next_side') not in ('left','right'))
  then raise exception 'wallpaper tile layout is invalid' using errcode='22023'; end if;
  if exists(select 1 from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer,next_side text)
    where tile.x < 0 or tile.y < 0 or tile.width<80 or tile.height<60
      or tile.x+tile.width>1920 or tile.y+tile.height>1080
      or tile.columns not between 1 and 217 or tile.rows not between 1 and 216 or tile.next_side not in ('left','right'))
  then raise exception 'wallpaper tile layout is out of bounds' using errcode='22023'; end if;
  if (select count(distinct tile.id) from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer,next_side text))<>v_tile_count
  then raise exception 'wallpaper tile layout contains duplicates' using errcode='22023'; end if;
  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer,next_side text) on tile.id=stored.id
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=stored.workspace_id and selected.session_id=stored.session_id
  where stored.workspace_id=p_workspace_id;
  if v_matched_count<>v_tile_count then raise exception 'wallpaper tile is not selected' using errcode='22023'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,layout_y=tile.y,layout_width=tile.width,layout_height=tile.height,
    layout_columns=tile.columns,layout_rows=tile.rows,layout_next_side=tile.next_side,layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer,next_side text)
  where stored.id=tile.id and stored.workspace_id=p_workspace_id;
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_overlay_layout_v2(uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_overlay_layout_v2(uuid,uuid,bigint,jsonb) to service_role;


