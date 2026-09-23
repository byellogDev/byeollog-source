-- Finish the wallpaper stability/security pass without changing the active
-- authenticated agent transport used by the desktop wallpaper client.

create index if not exists byeollog_account_withdrawal_intents_workspace_id_idx
  on public.byeollog_account_withdrawal_intents (workspace_id);

-- Guided rule test dispatch belongs to the retired action product.  Keep the
-- historical function for migration compatibility, but make it unreachable
-- through the Data API.
revoke all on function public.dispatch_guided_rule_test_v6(uuid, uuid, integer)
  from public, anon, authenticated;

revoke all on function byeollog_automation.dispatch_guided_rule_test_v6_impl(uuid, uuid, integer)
  from public, anon, authenticated;
