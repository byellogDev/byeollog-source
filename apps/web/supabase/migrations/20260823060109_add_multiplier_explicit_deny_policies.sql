-- Keep the internal multiplier state fail-closed even if a client table grant is
-- accidentally introduced later. Owner-only SECURITY DEFINER routines bypass
-- these client policies and remain the sole supported access path.
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
  with check (false);
