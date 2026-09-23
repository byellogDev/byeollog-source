-- Expose the workspace's current broadcast round to the Agent mapper without
-- replacing the deployed authentication and snapshot implementation.
do $migration$
declare
  target regprocedure := 'public.g3a_get_wallpaper_snapshot_v1(uuid,bigint,uuid,text,uuid,uuid,text,text,text)'::regprocedure;
  original text := pg_get_functiondef(target);
  anchor text := '''selectedSessionIds'', to_jsonb(v_selected_session_ids),';
  replacement text;
  patched text;
begin
  if position('''currentSessionId''' in original) > 0 then
    raise exception 'wallpaper currentSessionId already exists; inspect migration drift';
  end if;
  if position(anchor in original) = 0 then
    raise exception 'wallpaper snapshot anchor changed; refusing broad replacement';
  end if;

  replacement := anchor || E'\n    ''currentSessionId'', (\n'
    || E'      select session.id\n'
    || E'      from public.byeollog_wallpaper_sessions session\n'
    || E'      where session.workspace_id = p_workspace_id\n'
    || E'      order by session.started_at desc, session.id desc\n'
    || E'      limit 1\n'
    || E'    ),';
  patched := replace(original, anchor, replacement);
  if patched = original then
    raise exception 'wallpaper snapshot patch produced no change';
  end if;
  execute patched;
end
$migration$;

-- Existing Agents may already hold the old mapped snapshot at the same
-- revision. Advance it once so every workspace receives a newly filtered
-- snapshot without waiting for a donation or an editor mutation.
update public.byeollog_wallpaper_overlay_states
set revision = revision + 1,
    updated_at = clock_timestamp();

comment on function public.g3a_get_wallpaper_snapshot_v1(uuid,bigint,uuid,text,uuid,uuid,text,text,text)
  is 'Device-authenticated wallpaper snapshot including the current round id so historical SOOP image URLs can be suppressed.';


