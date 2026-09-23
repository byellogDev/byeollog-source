-- Additive snapshot field only. Preserve the deployed auth/session/policy function body.
do $migration$
declare
  target regprocedure := 'public.g3a_get_wallpaper_snapshot_v1(uuid,bigint,uuid,text,uuid,uuid,text,text,text)'::regprocedure;
  original text := pg_get_functiondef(target);
  patched text;
begin
  if position('''sizeRanges''' in original) > 0 then
    raise exception 'wallpaper sizeRanges already exists; inspect migration drift';
  end if;
  if position('''mergeRanges'', overlay.merge_ranges,' in original) = 0
     or position('''mergeRanges'', ''[]''::jsonb,' in original) = 0 then
    raise exception 'wallpaper snapshot anchors changed; refusing broad replacement';
  end if;
  patched := replace(original, '''mergeRanges'', overlay.merge_ranges,',
    '''mergeRanges'', overlay.merge_ranges, ''sizeRanges'', overlay.size_ranges,');
  patched := replace(patched, '''mergeRanges'', ''[]''::jsonb,',
    '''mergeRanges'', ''[]''::jsonb, ''sizeRanges'', ''[]''::jsonb,');
  execute patched;
end
$migration$;


