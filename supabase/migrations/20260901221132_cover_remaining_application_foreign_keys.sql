-- Complete the application-owned foreign-key coverage reported after the
-- first reliability migration. Keep lock waits short so live work wins.
set local lock_timeout='3s';
set local statement_timeout='20s';

create index if not exists native_roulette_chat_followups_donation_workspace_idx
  on byeollog_automation.native_roulette_chat_followups(donation_id,workspace_id);
create index if not exists native_roulette_chat_waits_v2_event_workspace_idx
  on byeollog_automation.native_roulette_chat_waits_v2(event_id,workspace_id);
create index if not exists native_roulette_dispatch_outbox_donation_workspace_idx
  on byeollog_automation.native_roulette_dispatch_outbox(donation_id,workspace_id);
create index if not exists native_roulette_overlay_outbox_v2_spin_workspace_idx
  on byeollog_automation.native_roulette_overlay_outbox_v2(spin_id,workspace_id);
create index if not exists native_roulette_spins_donation_workspace_idx
  on byeollog_automation.native_roulette_spins(donation_id,workspace_id);
create index if not exists native_roulette_spins_v2_event_workspace_idx
  on byeollog_automation.native_roulette_spins_v2(event_id,workspace_id);
create index if not exists byeollog_native_roulette_services_active_draft_idx
  on public.byeollog_native_roulette_services(workspace_id,active_draft_id);


