-- Persistent wallpaper visibility controls and the column/row capacity used
-- by the editor's translucent "next column" preview. Existing manual layouts
-- remain valid because capacity is nullable.

alter table public.byeollog_wallpaper_tiles
  add column layout_columns smallint,
  add column layout_rows smallint,
  add constraint byeollog_wallpaper_tiles_layout_capacity_pair_check check (
    (layout_columns is null and layout_rows is null)
    or (layout_columns is not null and layout_rows is not null and layout_x is not null)
  ),
  add constraint byeollog_wallpaper_tiles_layout_capacity_bounds_check check (
    layout_columns is null or (
      layout_columns between 1 and 13
      and layout_rows between 1 and 216
    )
  );

alter table public.byeollog_wallpaper_overlay_states
  add column hide_below integer not null default 0
    check (hide_below between 0 and 1000000),
  add column hidden_amounts integer[] not null default '{}'::integer[]
    check (cardinality(hidden_amounts)<=100);

create or replace function public.save_wallpaper_overlay_layout_v1(
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
    or (item->>'columns')!~'^[0-9]+$' or (item->>'rows')!~'^[0-9]+$')
  then raise exception 'wallpaper tile layout is invalid' using errcode='22023'; end if;
  if exists(select 1 from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer)
    where tile.x<0 or tile.y<0 or tile.width<80 or tile.height<60 or tile.x+tile.width>1920 or tile.y+tile.height>1080
      or tile.columns not between 1 and 13 or tile.rows not between 1 and 216)
  then raise exception 'wallpaper tile layout is out of bounds' using errcode='22023'; end if;
  if (select count(distinct tile.id) from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer))<>v_tile_count
  then raise exception 'wallpaper tile layout contains duplicates' using errcode='22023'; end if;
  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer) on tile.id=stored.id
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=stored.workspace_id and selected.session_id=stored.session_id
  where stored.workspace_id=p_workspace_id;
  if v_matched_count<>v_tile_count then raise exception 'wallpaper tile is not selected' using errcode='22023'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,layout_y=tile.y,layout_width=tile.width,layout_height=tile.height,
    layout_columns=tile.columns,layout_rows=tile.rows,layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer,columns integer,rows integer)
  where stored.id=tile.id and stored.workspace_id=p_workspace_id;
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_overlay_layout_v1(uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_overlay_layout_v1(uuid,uuid,bigint,jsonb) to service_role;

create or replace function public.clear_wallpaper_overlay_layout_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='40001'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=null,layout_y=null,layout_width=null,layout_height=null,
    layout_columns=null,layout_rows=null,layout_updated_at=null
  where stored.workspace_id=p_workspace_id and stored.layout_x is not null and exists(
    select 1 from public.byeollog_wallpaper_overlay_sessions selected
    where selected.workspace_id=p_workspace_id and selected.session_id=stored.session_id);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.clear_wallpaper_overlay_layout_v1(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.clear_wallpaper_overlay_layout_v1(uuid,uuid,bigint) to service_role;

create or replace function public.save_wallpaper_visibility_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,
  p_hide_below integer,p_hidden_amounts integer[])
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_hidden integer[];
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_hide_below not between 0 and 1000000
    or cardinality(coalesce(p_hidden_amounts,'{}'::integer[]))>100
    or exists(select 1 from unnest(coalesce(p_hidden_amounts,'{}'::integer[])) amount where amount not between 1 and 1000000)
  then raise exception 'wallpaper visibility request is invalid' using errcode='22023'; end if;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper visibility revision conflict' using errcode='40001'; end if;
  select coalesce(array_agg(distinct amount order by amount),'{}'::integer[]) into v_hidden
  from unnest(coalesce(p_hidden_amounts,'{}'::integer[])) amount;
  update public.byeollog_wallpaper_overlay_states overlay set
    hide_below=p_hide_below,hidden_amounts=v_hidden,
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_visibility_v1(uuid,uuid,bigint,integer,integer[])
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_visibility_v1(uuid,uuid,bigint,integer,integer[])
  to service_role;

comment on function public.save_wallpaper_visibility_v1(uuid,uuid,bigint,integer,integer[]) is
  'Stores workspace wallpaper amount filters with membership and optimistic revision checks.';
