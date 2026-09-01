create index if not exists byeollog_wallpaper_overlay_sessions_session_workspace_idx
  on public.byeollog_wallpaper_overlay_sessions(session_id,workspace_id);

comment on index public.byeollog_wallpaper_overlay_sessions_session_workspace_idx is
  'Covers the session-first foreign key used when consolidated wallpaper rounds are removed.';
