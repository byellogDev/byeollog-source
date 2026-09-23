-- Agent wallpaper runtime v16 fixes the canonical Supabase Storage signed-URL
-- response path.  Existing Agents cache wallpaper snapshots by overlay
-- revision, so advance only workspaces that actually have a custom wallpaper
-- asset and let them replace the previous SOOP fallback on the next claim.
update public.byeollog_wallpaper_overlay_states as overlay
set revision = overlay.revision + 1,
    updated_at = clock_timestamp()
where exists (
  select 1
  from public.byeollog_signature_balloons as signature
  where signature.workspace_id = overlay.workspace_id
    and signature.wallpaper_image is not null
);
