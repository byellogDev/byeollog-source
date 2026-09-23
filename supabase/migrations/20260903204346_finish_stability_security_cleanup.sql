create index if not exists byeollog_account_withdrawal_intents_workspace_id_idx
  on public.byeollog_account_withdrawal_intents (workspace_id);

revoke all on function public.dispatch_guided_rule_test_v6(uuid, uuid, integer)
  from public, anon, authenticated;

revoke all on function byeollog_automation.dispatch_guided_rule_test_v6_impl(uuid, uuid, integer)
  from public, anon, authenticated;
