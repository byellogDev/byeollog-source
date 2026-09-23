begin transaction read only;
set local statement_timeout='20s';

with asset_references as (
  select signature.workspace_id,'signature_pc'::text reference_kind,'byeollog-signature-assets'::text bucket_id,
    signature.pc_image->>'storagePath' storage_path,
    signature.pc_image->>'mimeType' expected_mime,
    case when signature.pc_image->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (signature.pc_image->>'byteSize')::bigint end expected_size
  from public.byeollog_signature_balloons signature
  union all
  select signature.workspace_id,'signature_mobile','byeollog-signature-assets',
    signature.mobile_image->>'storagePath',signature.mobile_image->>'mimeType',
    case when signature.mobile_image->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (signature.mobile_image->>'byteSize')::bigint end
  from public.byeollog_signature_balloons signature
  where signature.mobile_image is not null
  union all
  select signature.workspace_id,'signature_wallpaper','byeollog-signature-assets',
    signature.wallpaper_image->>'storagePath',signature.wallpaper_image->>'mimeType',
    case when signature.wallpaper_image->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (signature.wallpaper_image->>'byteSize')::bigint end
  from public.byeollog_signature_balloons signature
  where signature.wallpaper_image is not null
  union all
  select fallback.workspace_id,'default_pc','byeollog-signature-assets',
    fallback.pc_image->>'storagePath',fallback.pc_image->>'mimeType',
    case when fallback.pc_image->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (fallback.pc_image->>'byteSize')::bigint end
  from public.byeollog_default_donation_images fallback
  union all
  select fallback.workspace_id,'default_wallpaper','byeollog-signature-assets',
    fallback.wallpaper_image->>'storagePath',fallback.wallpaper_image->>'mimeType',
    case when fallback.wallpaper_image->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (fallback.wallpaper_image->>'byteSize')::bigint end
  from public.byeollog_default_donation_images fallback
  where fallback.wallpaper_image is not null
  union all
  select draft.workspace_id,'roulette_draft','byeollog-roulette-assets',image.value->>'storagePath',
    image.value->>'mimeType',
    case when image.value->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (image.value->>'byteSize')::bigint end
  from public.byeollog_roulette_drafts draft
  cross join lateral (values(draft.draft->'customSingleImage'),(draft.draft->'customSeriesImage')) image(value)
  where jsonb_typeof(image.value)='object'
  union all
  select tile.workspace_id,'wallpaper_tile',
    case when tile.asset->>'storagePath'~('/(?:single|series)/')
      then 'byeollog-roulette-assets' else 'byeollog-signature-assets' end,
    tile.asset->>'storagePath',tile.asset->>'mimeType',
    case when tile.asset->>'byteSize'~'^[1-9][0-9]{0,12}$'
      then (tile.asset->>'byteSize')::bigint end
  from public.byeollog_wallpaper_tiles tile
  where jsonb_typeof(tile.asset)='object' and tile.asset ? 'storagePath'
), normalized_references as (
  select * from asset_references where nullif(btrim(storage_path),'') is not null
), unique_references as (
  select workspace_id,reference_kind,bucket_id,storage_path,
    max(expected_mime) expected_mime,max(expected_size) expected_size
  from normalized_references
  group by workspace_id,reference_kind,bucket_id,storage_path
), matched as (
  select reference.*,object.id object_id,
    nullif(object.metadata->>'mimetype','') object_mime,
    case when object.metadata->>'size'~'^[0-9]+$'
      then (object.metadata->>'size')::bigint end object_size
  from unique_references reference
  left join storage.objects object
    on object.bucket_id=reference.bucket_id and object.name=reference.storage_path
), missing_tile_assets as (
  select tile.*
  from public.byeollog_wallpaper_tiles tile
  where tile.asset ? 'storagePath'
    and not exists(
      select 1 from storage.objects object
      where object.bucket_id=case when tile.asset->>'storagePath'~('/(?:single|series)/')
          then 'byeollog-roulette-assets' else 'byeollog-signature-assets' end
        and object.name=tile.asset->>'storagePath'
    )
), metrics as (
  select
    (select count(*) from unique_references) reference_count,
    (select count(*) from matched where object_id is null) missing_object,
    (select coalesce(jsonb_object_agg(reference_kind,missing_count),'{}'::jsonb)
      from (select reference_kind,count(*) missing_count from matched
        where object_id is null group by reference_kind) grouped) missing_by_kind,
    (select count(*) from matched where object_id is not null and expected_mime is not null
      and object_mime is not null and expected_mime<>object_mime) mime_mismatch,
    (select count(*) from matched where object_id is not null and expected_size is not null
      and object_size is not null and expected_size<>object_size) size_mismatch,
    (select count(*) from unique_references
      where storage_path not like ('workspaces/'||workspace_id::text||'/%')) path_workspace_mismatch,
    (select count(*) from (
      select bucket_id,storage_path from unique_references
      group by bucket_id,storage_path having count(distinct workspace_id)>1
    ) conflict) cross_workspace_reference,
    (select count(*) from public.byeollog_wallpaper_tiles tile
      where tile.asset_source='soop' and tile.asset ? 'url'
        and (tile.asset->>'url'~'[[:cntrl:]]'
          or tile.asset->>'url'!~*'^https://([a-z0-9-]+\.)*(sooplive\.com|afreecatv\.com|afreecatvcdn\.com)(/|$)'))
      invalid_provider_url,
    (select count(*) from storage.objects object
      where object.bucket_id in ('byeollog-signature-assets','byeollog-roulette-assets')
        and object.name like 'workspaces/%'
        and not exists(select 1 from unique_references reference
          where reference.bucket_id=object.bucket_id and reference.storage_path=object.name))
      unreferenced_object,
    (select count(*) from storage.objects object
      where object.bucket_id in ('byeollog-signature-assets','byeollog-roulette-assets')
        and object.name not like 'workspaces/%') malformed_object_path
    ,(select count(*) from missing_tile_assets tile
      join public.byeollog_wallpaper_sessions session on session.id=tile.session_id
      where session.state='active') missing_tile_active_session
    ,(select count(*) from missing_tile_assets tile
      where exists(select 1 from public.byeollog_wallpaper_overlay_sessions selected
        where selected.workspace_id=tile.workspace_id and selected.session_id=tile.session_id))
      missing_tile_selected_session
    ,(select count(*) from missing_tile_assets tile
      join public.byeollog_wallpaper_overlay_states state on state.workspace_id=tile.workspace_id
      where (coalesce(tile.display_kind,'donation')||':'||tile.amount::text)=any(state.visible_group_keys))
      missing_tile_visible_group
    ,(select coalesce(jsonb_object_agg(asset_source,item_count),'{}'::jsonb)
      from (select asset_source,count(*) item_count from missing_tile_assets group by asset_source) grouped)
      missing_tile_by_source
)
select jsonb_build_object(
  'ok',missing_object+mime_mismatch+size_mismatch+path_workspace_mismatch
    +cross_workspace_reference+invalid_provider_url+malformed_object_path=0,
  'scope','all-workspace-image-references',
  'counts',jsonb_build_object('uniqueReferences',reference_count),
  'violations',jsonb_build_object(
    'missingStorageObject',missing_object,
    'mimeMismatch',mime_mismatch,
    'byteSizeMismatch',size_mismatch,
    'pathWorkspaceMismatch',path_workspace_mismatch,
    'crossWorkspaceReference',cross_workspace_reference,
    'invalidProviderUrl',invalid_provider_url,
    'malformedStorageObjectPath',malformed_object_path),
  'diagnostics',jsonb_build_object(
    'missingByKind',missing_by_kind,
    'historicalMissingTileBySource',missing_tile_by_source,
    'missingTileInActiveSession',missing_tile_active_session,
    'missingTileInSelectedSession',missing_tile_selected_session,
    'missingTileInVisibleGroup',missing_tile_visible_group),
  'cleanupCandidates',jsonb_build_object('unreferencedStorageObjects',unreferenced_object)
) audit_result
from metrics;

rollback;
