-- Official subscription images were added after text-only subscription cards had
-- already stored compact manual layouts. Promote only those legacy compact rows
-- to the normal image-card aspect ratio while preserving their bottom edge.
with candidate_tiles as (
  select
    tile.id,
    tile.session_id,
    tile.layout_height,
    greatest(
      tile.layout_height,
      least(
        1260,
        tile.layout_y+tile.layout_height+90,
        ceil(
          (226+greatest(tile.layout_rows-1,0)*46)::numeric
          * tile.layout_width::numeric
          / (greatest(tile.layout_columns,1)*240)::numeric
        )::integer
      )
    ) as target_height
  from public.byeollog_wallpaper_tiles tile
  where tile.display_kind='subscription'
    and tile.asset_source='soop'
    and coalesce(tile.asset->>'url','')<>''
    and tile.layout_x is not null
    and tile.layout_y is not null
    and tile.layout_width is not null
    and tile.layout_height is not null
    and tile.layout_columns is not null
    and tile.layout_rows is not null
), legacy_compact_tiles as (
  select *
  from candidate_tiles
  where target_height>layout_height
), updated_tiles as (
  update public.byeollog_wallpaper_tiles tile set
    layout_y=greatest(-90,tile.layout_y+tile.layout_height-legacy.target_height),
    layout_height=legacy.target_height
  from legacy_compact_tiles legacy
  where tile.id=legacy.id
  returning tile.session_id
), updated_sessions as (
  update public.byeollog_wallpaper_sessions session set
    revision=session.revision+1,
    updated_at=clock_timestamp()
  where session.id in (select distinct session_id from updated_tiles)
  returning session.id,session.workspace_id
)
update public.byeollog_wallpaper_overlay_states overlay set
  revision=overlay.revision+1,
  updated_at=clock_timestamp()
where exists(
  select 1
  from updated_sessions session
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=session.workspace_id
   and selected.session_id=session.id
  where session.workspace_id=overlay.workspace_id
);
