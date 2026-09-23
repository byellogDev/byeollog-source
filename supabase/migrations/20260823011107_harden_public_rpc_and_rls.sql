
alter function public.get_public_workspace(text) security invoker;
alter function public.get_public_bangsel(text, text) security invoker;

revoke all on function public.get_public_workspace(text) from public, anon, authenticated;
revoke all on function public.get_public_bangsel(text, text) from public, anon, authenticated;
grant execute on function public.get_public_workspace(text) to service_role;
grant execute on function public.get_public_bangsel(text, text) to service_role;

create policy explicitly_deny_direct_client_access on byeollog_automation.agent_device_status for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.agent_devices for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.events for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.executions for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.release_gate for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.rule_actions for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.rule_conditions for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.rules for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on byeollog_automation.workspace_gates for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_collector_logs for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_collector_staging for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_donations for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_fan_stations for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_fans for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_roulette_invalidations for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_roulette_rules for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_task_import_items for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.bangsel_tasks for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_audit_log for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_collector_devices for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_dashboard_handoffs for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_inquiries for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_rate_limits for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_signup_applications for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_workspace_members for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_workspace_settings for all to anon, authenticated using (false) with check (false);
create policy explicitly_deny_direct_client_access on public.byeollog_workspaces for all to anon, authenticated using (false) with check (false);

