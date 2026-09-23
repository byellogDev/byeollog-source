-- Unknown legacy counts remain NULL. No donation or learned-rule backfill.
alter table public.byeollog_roulette_amount_mappings
  add column expected_spins integer;
alter table public.byeollog_roulette_amount_mappings
  add constraint roulette_mapping_expected_spins_range
  check (expected_spins is null or expected_spins between 1 and 1000);
comment on column public.byeollog_roulette_amount_mappings.expected_spins is
  'Expected roulette spins per donation including bonus spins; NULL means unconfirmed. Not the number of split reward items.';
notify pgrst, 'reload schema';
