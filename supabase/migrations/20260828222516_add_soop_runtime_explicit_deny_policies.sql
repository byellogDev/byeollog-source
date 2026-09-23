do $migration$
declare v_table text;
begin
  foreach v_table in array array[
    'byeollog_soop_diagnostic_runs',
    'byeollog_soop_event_observations',
    'byeollog_soop_gateway_sessions',
    'byeollog_soop_runtime_controls'
  ] loop
    execute format('drop policy if exists %I on public.%I',v_table||'_deny_browser',v_table);
    execute format(
      'create policy %I on public.%I for all to anon,authenticated using (false) with check (false)',
      v_table||'_deny_browser',v_table
    );
  end loop;
end
$migration$;


