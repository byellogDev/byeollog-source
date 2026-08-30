-- SHADOW REPLAY PARITY TRANSITION ONLY. NEVER APPLY TO PRODUCTION.
--
-- The current local Supabase stack auto-exposes new public objects through
-- default privileges. The production project evolved under different defaults
-- and additional manual grants/revokes. These statements align effective ACLs
-- after the historical DDL replay; they do not change production.

do $$
declare
  v_function regprocedure;
begin
  for v_function in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = any(array[
        'delete_guided_rule_v1',
        'dispatch_guided_rule_test_v1',
        'list_agent_devices_v1',
        'list_agent_overlay_asset_readiness_v1',
        'list_automation_activity_v1',
        'rename_agent_device_v1',
        'revoke_agent_device_v1',
        'save_guided_rule_v4',
        'save_guided_rule_v5',
        'save_guided_rule_v6',
        'save_guided_rule_v7',
        'set_guided_rule_enabled_v1'
      ])
  loop
    execute format('revoke execute on function %s from service_role', v_function);
  end loop;
end
$$;

revoke execute on function public.set_updated_at()
  from anon,authenticated,service_role;
revoke execute on function public.set_fan_station_updated_at()
  from anon,authenticated,service_role;
revoke execute on function public.set_bangsel_fans_updated_at()
  from public,anon,authenticated,service_role;
revoke execute on function public.set_bangsel_roulette_rules_updated_at()
  from public,anon,authenticated,service_role;

revoke select,update,usage on sequence public.bangsel_collector_logs_id_seq
  from anon,authenticated;
revoke update on sequence public.bangsel_collector_logs_id_seq
  from service_role;
revoke select,update,usage on sequence public.byeollog_audit_log_id_seq
  from anon,authenticated,service_role;

revoke select,insert,update,delete on table public.overlay_asset_durations
  from service_role;
revoke select,insert,update,delete on table public.overlay_assets
  from service_role;
revoke insert,update,delete on table public.rule_actions
  from service_role;
revoke insert,update,delete on table public.rule_conditions
  from service_role;
revoke insert,update,delete on table public.rules
  from service_role;
revoke select,insert,update,delete on table public.workspace_members
  from service_role;

grant all privileges on table public.bangsel_fan_stations
  to authenticated;
grant all privileges on table public.bangsel_tasks
  to authenticated;
