drop policy if exists native_roulette_tts_attempts_v1_browser_deny
  on byeollog_automation.native_roulette_tts_attempts_v1;
create policy native_roulette_tts_attempts_v1_browser_deny
  on byeollog_automation.native_roulette_tts_attempts_v1
  for all
  to anon,authenticated
  using(false)
  with check(false);


