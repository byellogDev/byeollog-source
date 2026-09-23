-- The manual raffle flow records when an open round is sealed, but the
-- original raffle table migration omitted this column. Keep this migration
-- idempotent because some development databases were repaired manually.
alter table byeollog_automation.raffle_rounds
  add column if not exists sealed_at timestamptz;

comment on column byeollog_automation.raffle_rounds.sealed_at is
  'Server timestamp captured when the raffle pool is sealed for manual draws.';
