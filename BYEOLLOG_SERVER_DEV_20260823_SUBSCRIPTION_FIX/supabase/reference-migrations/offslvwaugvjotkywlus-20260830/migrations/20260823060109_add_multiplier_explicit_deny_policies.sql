create policy explicitly_deny_direct_client_access
  on byeollog_automation.roulette_reward_multiplier_state
  for all
  to anon, authenticated
  using (false)
  with check (false);

create policy explicitly_deny_direct_client_access
  on byeollog_automation.roulette_reward_multiplier_receipts
  for all
  to anon, authenticated
  using (false)
  with check (false);;
