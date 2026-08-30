-- A gateway lease is now meaningful only for an explicitly active production
-- roulette. Remove leftover experiment/diagnostic leases without activating or
-- changing any streamer roulette.
update public.byeollog_soop_runtime_controls set
  gateway_enabled=false,
  synthetic_test_enabled=false,
  live_diagnostics_enabled=false,
  overlay_experiment_enabled=false,
  overlay_experiment_draft_id=null,
  overlay_experiment_expires_at=null,
  updated_at=clock_timestamp()
where native_roulette_enabled=false;

;
