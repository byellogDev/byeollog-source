with audit_window as (
  select
    timestamptz '2026-09-07 00:00:00+00' as enforced_from,
    timestamptz '2026-09-07 00:59:07+00' as recovery_from,
    timestamptz '2026-09-07 01:01:24+00' as recovery_to
), metrics as (
  select
    (select count(*) from public.byeollog_soop_event_observations observation,audit_window audit
      where observation.server_received_at>=audit.recovery_from
        and observation.server_received_at<audit.recovery_to) as recovery_observations,
    (select count(*) from public.byeollog_soop_event_observations observation,audit_window audit
      where observation.server_received_at>=audit.recovery_from
        and observation.server_received_at<audit.recovery_to
        and observation.event_type='donation') as recovery_donation_observations,
    (select count(*) from public.byeollog_soop_event_observations observation,audit_window audit
      where observation.server_received_at>=audit.recovery_from
        and observation.server_received_at<audit.recovery_to
        and observation.outcome='committed') as recovery_committed_observations,
    (select count(*) from public.byeollog_soop_event_observations observation,audit_window audit
      where observation.server_received_at>=audit.enforced_from) as observations,
    (select count(*) from public.byeollog_soop_event_ownership owner,audit_window audit
      where owner.claimed_at>=audit.enforced_from) as ownership_claims,
    (select count(*) from public.byeollog_soop_core_donations donation,audit_window audit
      where donation.created_at>=audit.enforced_from) as donations,
    (select count(*) from public.byeollog_soop_core_roulette_results result,audit_window audit
      where result.created_at>=audit.enforced_from) as roulette_results,
    (select count(*) from public.byeollog_wallpaper_tiles tile,audit_window audit
      where tile.created_at>=audit.enforced_from) as wallpaper_tiles,
    (select count(*) from (
      select observation.event_fingerprint
      from public.byeollog_soop_event_observations observation,audit_window audit
      where observation.server_received_at>=audit.enforced_from
      group by observation.event_fingerprint
      having count(distinct observation.workspace_id)>1
    ) conflict) as observation_fingerprint_cross_workspace,
    (select count(*) from (
      select donation.provider_event_id
      from public.byeollog_soop_core_donations donation,audit_window audit
      where donation.created_at>=audit.enforced_from
      group by donation.provider_event_id
      having count(distinct donation.workspace_id)>1
    ) conflict) as provider_event_cross_workspace,
    (select count(*)
      from public.byeollog_soop_core_donations donation
      cross join audit_window audit
      where donation.created_at>=audit.enforced_from and not exists(
        select 1 from public.byeollog_soop_event_ownership owner
        where owner.event_fingerprint=donation.source_event_fingerprint
          and owner.workspace_id=donation.workspace_id
          and owner.provider_bj_id=donation.source_bj_id
          and owner.chat_number=donation.source_chat_number
      )) as donation_ownership_mismatch,
    (select count(*)
      from public.byeollog_soop_core_donations donation
      join public.byeollog_workspaces workspace on workspace.id=donation.workspace_id
      cross join audit_window audit
      where donation.created_at>=audit.enforced_from
        and lower(workspace.soop_id) is distinct from lower(donation.source_bj_id)) as donation_broadcaster_mismatch,
    (select count(*)
      from public.byeollog_soop_core_roulette_results result
      cross join audit_window audit
      where result.created_at>=audit.enforced_from and not exists(
        select 1 from public.byeollog_soop_event_ownership owner
        where owner.event_fingerprint=result.source_event_fingerprint
          and owner.workspace_id=result.workspace_id
          and owner.provider_bj_id=result.source_bj_id
          and owner.chat_number=result.source_chat_number
      )) as result_ownership_mismatch,
    (select count(*)
      from public.byeollog_soop_core_roulette_results result
      left join public.byeollog_soop_core_donations donation on donation.id=result.donation_id
      cross join audit_window audit
      where result.created_at>=audit.enforced_from and result.donation_id is not null
        and (donation.id is null or donation.workspace_id<>result.workspace_id)) as result_donation_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      left join public.byeollog_soop_core_donations donation on donation.id=tile.donation_event_id
      cross join audit_window audit
      where tile.created_at>=audit.enforced_from
        and (donation.id is null or donation.workspace_id<>tile.workspace_id)) as tile_donation_workspace_mismatch,
    (select count(*)
      from public.byeollog_wallpaper_tiles tile
      left join public.byeollog_soop_core_donations donation on donation.id=tile.donation_event_id
      cross join audit_window audit
      where tile.created_at>=audit.enforced_from and tile.asset_source='soop'
        and (tile.asset->>'workspaceId' is distinct from tile.workspace_id::text
          or tile.asset->>'providerBjId' is distinct from donation.source_bj_id
          or (tile.asset->>'roomChatNumber')::bigint is distinct from donation.source_chat_number)) as provider_asset_metadata_mismatch
)
select jsonb_build_object(
  'ok',observation_fingerprint_cross_workspace=0
    and provider_event_cross_workspace=0
    and donation_ownership_mismatch=0
    and donation_broadcaster_mismatch=0
    and result_ownership_mismatch=0
    and result_donation_workspace_mismatch=0
    and tile_donation_workspace_mismatch=0
    and provider_asset_metadata_mismatch=0,
  'window',jsonb_build_object(
    'enforcedFrom',(select enforced_from from audit_window),
    'recoveryFrom',(select recovery_from from audit_window),
    'recoveryTo',(select recovery_to from audit_window)),
  'counts',jsonb_build_object(
    'recoveryObservations',recovery_observations,
    'recoveryDonationObservations',recovery_donation_observations,
    'recoveryCommittedObservations',recovery_committed_observations,
    'observations',observations,'ownershipClaims',ownership_claims,'donations',donations,
    'rouletteResults',roulette_results,'wallpaperTiles',wallpaper_tiles),
  'violations',jsonb_build_object(
    'observationFingerprintAcrossWorkspaces',observation_fingerprint_cross_workspace,
    'providerEventAcrossWorkspaces',provider_event_cross_workspace,
    'donationOwnershipMismatch',donation_ownership_mismatch,
    'donationBroadcasterMismatch',donation_broadcaster_mismatch,
    'resultOwnershipMismatch',result_ownership_mismatch,
    'resultDonationWorkspaceMismatch',result_donation_workspace_mismatch,
    'tileDonationWorkspaceMismatch',tile_donation_workspace_mismatch,
    'providerAssetMetadataMismatch',provider_asset_metadata_mismatch)
) as audit_result
from metrics;
