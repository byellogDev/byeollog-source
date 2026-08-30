-- SHADOW REPLAY HISTORICAL TRANSITION ONLY.
-- The production catalog no longer contains these seals, while the preserved
-- remote migration chain does not include the statement that removed them.
alter table byeollog_automation.release_gate
  drop constraint if exists release_gate_g3a_install_dormant;

alter table byeollog_automation.workspace_gates
  drop constraint if exists workspace_gate_g3a_install_dormant;
