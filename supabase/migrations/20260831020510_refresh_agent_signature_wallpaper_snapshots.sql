update public.byeollog_wallpaper_overlay_states as overlay
set revision = overlay.revision + 1,
    updated_at = clock_timestamp()
where exists (
  select 1
  from public.byeollog_signature_balloons as signature
  where signature.workspace_id = overlay.workspace_id
    and signature.wallpaper_image is not null
);
