-- Restore the historical SOOP image URLs that were already retained in the
-- canonical donation ledger. Roulette and signature assets keep priority.
set statement_timeout='5s';

with target as (
  select workspace.id as workspace_id
  from public.byeollog_workspaces workspace
  where workspace.slug='observer_a'
  limit 1
), candidates as (
  select
    tile.id as tile_id,
    nullif(btrim(donation.raw_payload->>'img'),'') as image_url,
    row_number() over (
      partition by tile.id
      order by abs(extract(epoch from (donation.donated_at-tile.received_at))),donation.source_event_key
    ) as tile_rank,
    row_number() over (
      partition by donation.source_event_key
      order by abs(extract(epoch from (donation.donated_at-tile.received_at))),tile.id
    ) as donation_rank
  from target
  join public.byeollog_wallpaper_tiles tile
    on tile.workspace_id=target.workspace_id
   and tile.asset_source='soop_default'
  join public.byeollog_wallpaper_sessions session
    on session.id=tile.session_id
   and session.workspace_id=tile.workspace_id
   and session.source_key like 'backfill:2026-08-30:%'
  join public.bangsel_donations donation
    on donation.workspace_id=tile.workspace_id
   and donation.balloons=tile.amount
   and btrim(donation.nickname)=btrim(tile.actor_name)
   and donation.donated_at between tile.received_at-interval '30 seconds' and tile.received_at+interval '30 seconds'
), repaired as (
  update public.byeollog_wallpaper_tiles tile
  set asset_source='soop',asset=jsonb_build_object('url',candidate.image_url)
  from candidates candidate
  where tile.id=candidate.tile_id
    and candidate.tile_rank=1
    and candidate.donation_rank=1
    and candidate.image_url is not null
  returning tile.session_id
), changed_sessions as (
  select distinct repaired.session_id from repaired
), bumped_sessions as (
  update public.byeollog_wallpaper_sessions session
  set revision=session.revision+1,updated_at=clock_timestamp()
  from changed_sessions changed
  where session.id=changed.session_id
  returning session.workspace_id
)
update public.byeollog_wallpaper_overlay_states overlay
set revision=overlay.revision+1,updated_at=clock_timestamp()
where overlay.workspace_id in (select bumped.workspace_id from bumped_sessions bumped);
