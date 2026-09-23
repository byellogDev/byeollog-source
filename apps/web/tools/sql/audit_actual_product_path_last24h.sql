begin transaction read only;
set local statement_timeout='20s';

with recent_donations as (
  select donation.id,donation.workspace_id,donation.source_event_fingerprint,donation.created_at
  from public.byeollog_soop_core_donations donation
  where donation.created_at>=clock_timestamp()-interval '24 hours'
    and donation.source_bj_id is not null
    and donation.source_chat_number is not null
    and donation.source_event_fingerprint is not null
), traced as (
  select donation.*,
    exists(select 1 from public.byeollog_soop_event_observations observation
      where observation.workspace_id=donation.workspace_id
        and observation.event_fingerprint=donation.source_event_fingerprint
        and observation.outcome<>'failed') as observed,
    exists(select 1 from public.byeollog_wallpaper_tiles tile
      where tile.workspace_id=donation.workspace_id
        and tile.donation_event_id=donation.id) as tiled,
    exists(select 1 from public.byeollog_wallpaper_tiles tile
      join public.byeollog_wallpaper_overlay_sessions selected
        on selected.workspace_id=tile.workspace_id and selected.session_id=tile.session_id
      where tile.workspace_id=donation.workspace_id
        and tile.donation_event_id=donation.id) as selected
  from recent_donations donation
), latest_by_workspace as (
  select workspace_id,max(created_at) as latest_donation_at
  from recent_donations group by workspace_id
), displayed_workspaces as (
  select latest.workspace_id,
    exists(select 1 from private.agent_display_observations_v1 display
      where display.workspace_id=latest.workspace_id
        and display.observation_kind='wallpaper_ready'
        and display.source_created_at>=latest.latest_donation_at-interval '5 seconds'
        and display.server_received_at>=latest.latest_donation_at-interval '5 seconds') as displayed_after_latest
  from latest_by_workspace latest
)
select jsonb_build_object(
  'windowHours',24,
  'attestedDonations',(select count(*) from traced),
  'observedByGatewayAndServer',(select count(*) from traced where observed),
  'missingObservation',(select count(*) from traced where not observed),
  'wallpaperTilesCreated',(select count(*) from traced where tiled),
  'missingWallpaperTile',(select count(*) from traced where not tiled),
  'currentlySelectedDonationTiles',(select count(*) from traced where selected),
  'workspacesWithAttestedDonations',(select count(*) from latest_by_workspace),
  'workspacesDisplayedAfterLatestDonation',(select count(*) from displayed_workspaces where displayed_after_latest),
  'workspacesWithoutDisplayProof',(select count(*) from displayed_workspaces where not displayed_after_latest),
  'latestAttestedDonationAt',(select max(created_at) from recent_donations),
  'latestWallpaperReadyAt',(
    select max(server_received_at) from private.agent_display_observations_v1
    where observation_kind='wallpaper_ready'
  ),
  'rouletteResults',(
    select jsonb_build_object(
      'total',count(*),
      'matched',count(*) filter(where result.match_state='matched'),
      'unmatched',count(*) filter(where result.match_state='unmatched'),
      'ambiguous',count(*) filter(where result.match_state='ambiguous')
    )
    from public.byeollog_soop_core_roulette_results result
    where result.created_at>=clock_timestamp()-interval '24 hours'
      and result.source_bj_id is not null
  )
) as actual_product_path;

rollback;
