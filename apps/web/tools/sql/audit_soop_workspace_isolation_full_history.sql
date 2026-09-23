begin transaction read only;
set local statement_timeout='20s';

with metrics as (
  select
    (select count(*) from public.byeollog_workspaces) as workspaces,
    (select count(*) from public.byeollog_soop_event_observations) as observations,
    (select count(*) from public.byeollog_soop_event_ownership) as ownership_claims,
    (select count(*) from public.byeollog_soop_core_donations) as donations,
    (select count(*) from public.byeollog_soop_core_roulette_results) as roulette_results,
    (select count(*) from public.byeollog_wallpaper_tiles) as wallpaper_tiles,
    (select count(*) from public.byeollog_signature_balloons) as signature_assets,
    (select count(*) from private.soop_workspace_conflicts) as blocked_ownership_conflicts,
    (select count(*) from (
      select observation.event_fingerprint
      from public.byeollog_soop_event_observations observation
      group by observation.event_fingerprint
      having count(distinct observation.workspace_id)>1
    ) conflict) as observation_fingerprint_cross_workspace,
    (select count(*) from (
      select donation.provider_event_id
      from public.byeollog_soop_core_donations donation
      where donation.provider_event_id is not null
      group by donation.provider_event_id
      having count(distinct donation.workspace_id)>1
    ) conflict) as provider_event_cross_workspace,
    (select count(*) from (
      select donation.source_event_fingerprint
      from public.byeollog_soop_core_donations donation
      where donation.source_event_fingerprint is not null
      group by donation.source_event_fingerprint
      having count(distinct donation.workspace_id)>1
    ) conflict) as donation_fingerprint_cross_workspace,
    (select count(*) from (
      select lower(workspace.soop_id)
      from public.byeollog_workspaces workspace
      where workspace.soop_id is not null
      group by lower(workspace.soop_id)
      having count(*)>1
    ) conflict) as workspace_soop_id_duplicates,
    (select count(*)
      from public.byeollog_soop_core_donations donation
      join public.byeollog_workspaces workspace on workspace.id=donation.workspace_id
      where donation.source_bj_id is not null
        and lower(workspace.soop_id) is distinct from lower(donation.source_bj_id)) as donation_broadcaster_mismatch,
    (select count(*)
      from public.byeollog_soop_core_roulette_results result
      left join public.byeollog_soop_core_donations donation on donation.id=result.donation_id
      where result.donation_id is not null
        and (donation.id is null or donation.workspace_id<>result.workspace_id)) as result_donation_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      join public.byeollog_soop_core_donations donation on donation.id=tile.donation_event_id
      where donation.workspace_id<>tile.workspace_id) as tile_donation_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      join byeollog_automation.native_roulette_events_v2 event on event.id=tile.donation_event_id
      where event.workspace_id<>tile.workspace_id) as tile_legacy_event_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      left join public.byeollog_wallpaper_sessions session on session.id=tile.session_id
      where session.id is null or session.workspace_id<>tile.workspace_id) as tile_session_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_overlay_sessions selected
      left join public.byeollog_wallpaper_sessions session on session.id=selected.session_id
      where session.id is null or session.workspace_id<>selected.workspace_id) as selected_session_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      left join public.byeollog_soop_core_donations donation on donation.id=tile.donation_event_id
      where tile.asset_source='soop'
        and tile.asset ? 'workspaceId'
        and tile.asset ? 'providerBjId'
        and tile.asset ? 'roomChatNumber'
        and (tile.asset->>'workspaceId' is distinct from tile.workspace_id::text
          or tile.asset->>'providerBjId' is distinct from donation.source_bj_id
          or case when tile.asset->>'roomChatNumber'~'^[1-9][0-9]*$'
               then (tile.asset->>'roomChatNumber')::bigint end is distinct from donation.source_chat_number))
      as provider_asset_metadata_mismatch,
    (select count(*)
      from public.byeollog_signature_balloons signature
      where signature.pc_image->>'storagePath' not like
          ('workspaces/'||signature.workspace_id::text||'/pc/%')
        or (signature.mobile_image is not null and signature.mobile_image->>'storagePath' not like
          ('workspaces/'||signature.workspace_id::text||'/mobile/%'))
        or (signature.wallpaper_image is not null and signature.wallpaper_image->>'storagePath' not like
          ('workspaces/'||signature.workspace_id::text||'/wallpaper/%')))
      as signature_asset_path_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      where tile.asset_source='soop'
        and not (tile.asset ? 'workspaceId' and tile.asset ? 'providerBjId' and tile.asset ? 'roomChatNumber'))
      as legacy_provider_assets_without_ownership_metadata,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      where tile.created_at>=timestamptz '2026-09-07 00:00:00+00'
        and tile.asset_source='soop'
        and not (tile.asset ? 'workspaceId' and tile.asset ? 'providerBjId' and tile.asset ? 'roomChatNumber'))
      as current_provider_assets_without_ownership_metadata,
    (select count(*)
      from public.byeollog_soop_core_donations donation
      where donation.source_event_fingerprint is null) as legacy_donations_without_ownership_metadata,
    (select count(*)
      from public.byeollog_soop_core_donations donation
      where donation.created_at>=timestamptz '2026-09-07 00:00:00+00'
        and donation.source_event_fingerprint is null) as current_donations_without_ownership_metadata,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      where not exists(select 1 from public.byeollog_soop_core_donations donation
        where donation.id=tile.donation_event_id)
        and not exists(select 1 from byeollog_automation.native_roulette_events_v2 event
          where event.id=tile.donation_event_id)) as legacy_tiles_without_core_or_native_source,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      where tile.created_at>=timestamptz '2026-09-07 00:00:00+00'
        and not exists(select 1 from public.byeollog_soop_core_donations donation
          where donation.id=tile.donation_event_id)
        and not exists(select 1 from byeollog_automation.native_roulette_events_v2 event
          where event.id=tile.donation_event_id)) as current_tiles_without_core_or_native_source,
    (select count(*)
      from pg_catalog.pg_constraint constraint_row
      where constraint_row.conname in (
        'byeollog_soop_core_results_workspace_donation_fk',
        'byeollog_wallpaper_tiles_workspace_donation_fk'
      ) and not constraint_row.convalidated) as ownership_constraints_not_validated
), violation_total as (
  select observation_fingerprint_cross_workspace
    +provider_event_cross_workspace
    +donation_fingerprint_cross_workspace
    +workspace_soop_id_duplicates
    +donation_broadcaster_mismatch
    +result_donation_workspace_mismatch
    +tile_donation_workspace_mismatch
    +tile_legacy_event_workspace_mismatch
    +tile_session_workspace_mismatch
    +selected_session_workspace_mismatch
    +provider_asset_metadata_mismatch
    +signature_asset_path_mismatch as value
  from metrics
)
select jsonb_build_object(
  'ok',(select value=0 from violation_total),
  'scope','all-recorded-history',
  'counts',jsonb_build_object(
    'workspaces',workspaces,'observations',observations,'ownershipClaims',ownership_claims,
    'donations',donations,'rouletteResults',roulette_results,'wallpaperTiles',wallpaper_tiles,
    'signatureAssets',signature_assets,'blockedOwnershipConflicts',blocked_ownership_conflicts),
  'violations',jsonb_build_object(
    'observationFingerprintAcrossWorkspaces',observation_fingerprint_cross_workspace,
    'providerEventAcrossWorkspaces',provider_event_cross_workspace,
    'donationFingerprintAcrossWorkspaces',donation_fingerprint_cross_workspace,
    'workspaceSoopIdDuplicates',workspace_soop_id_duplicates,
    'donationBroadcasterMismatch',donation_broadcaster_mismatch,
    'resultDonationWorkspaceMismatch',result_donation_workspace_mismatch,
    'tileDonationWorkspaceMismatch',tile_donation_workspace_mismatch,
    'tileLegacyEventWorkspaceMismatch',tile_legacy_event_workspace_mismatch,
    'tileSessionWorkspaceMismatch',tile_session_workspace_mismatch,
    'selectedSessionWorkspaceMismatch',selected_session_workspace_mismatch,
    'providerAssetMetadataMismatch',provider_asset_metadata_mismatch,
    'signatureAssetPathMismatch',signature_asset_path_mismatch),
  'legacyRiskCounts',jsonb_build_object(
    'providerAssetsWithoutOwnershipMetadata',legacy_provider_assets_without_ownership_metadata,
    'providerAssetsWithoutOwnershipMetadataAfterEnforcement',current_provider_assets_without_ownership_metadata,
    'donationsWithoutOwnershipMetadata',legacy_donations_without_ownership_metadata,
    'donationsWithoutOwnershipMetadataAfterEnforcement',current_donations_without_ownership_metadata,
    'tilesWithoutCoreOrNativeSource',legacy_tiles_without_core_or_native_source,
    'tilesWithoutCoreOrNativeSourceAfterEnforcement',current_tiles_without_core_or_native_source,
    'ownershipConstraintsNotValidated',ownership_constraints_not_validated)
) as audit_result
from metrics;

rollback;
