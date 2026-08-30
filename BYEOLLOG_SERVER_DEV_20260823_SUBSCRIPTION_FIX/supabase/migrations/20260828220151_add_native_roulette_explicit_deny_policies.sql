create policy explicitly_deny_direct_client_access
  on byeollog_automation.native_roulette_events_v2 for all to anon,authenticated
  using(false) with check(false);
create policy explicitly_deny_direct_client_access
  on byeollog_automation.native_roulette_spins_v2 for all to anon,authenticated
  using(false) with check(false);
create policy explicitly_deny_direct_client_access
  on byeollog_automation.native_roulette_overlay_outbox_v2 for all to anon,authenticated
  using(false) with check(false);
create policy explicitly_deny_direct_client_access
  on byeollog_automation.native_roulette_chat_buffer_v2 for all to anon,authenticated
  using(false) with check(false);
create policy explicitly_deny_direct_client_access
  on byeollog_automation.native_roulette_chat_waits_v2 for all to anon,authenticated
  using(false) with check(false);
