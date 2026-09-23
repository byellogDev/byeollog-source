-- Public-release hardening for the internal next-roulette multiplier state.
alter table byeollog_automation.roulette_reward_multiplier_state
  enable row level security;

alter table byeollog_automation.roulette_reward_multiplier_receipts
  enable row level security;

create index if not exists bangsel_tasks_workspace_fan_soop_id_idx
  on public.bangsel_tasks (workspace_id, fan_soop_id);

create index if not exists byeollog_audit_log_actor_user_id_idx
  on public.byeollog_audit_log (actor_user_id);

create index if not exists byeollog_dashboard_handoffs_device_id_idx
  on public.byeollog_dashboard_handoffs (device_id);

create index if not exists byeollog_workspaces_owner_user_id_idx
  on public.byeollog_workspaces (owner_user_id);
