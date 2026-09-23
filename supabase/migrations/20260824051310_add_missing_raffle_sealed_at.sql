alter table byeollog_automation.raffle_rounds
  add column if not exists sealed_at timestamptz;
