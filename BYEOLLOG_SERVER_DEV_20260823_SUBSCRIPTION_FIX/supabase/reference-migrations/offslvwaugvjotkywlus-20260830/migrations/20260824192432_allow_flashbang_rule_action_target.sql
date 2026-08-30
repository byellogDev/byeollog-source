-- The flashbang rule writer deliberately reuses the proven v11 rule writer
-- and then changes the private action to flashbang.overlay. Production still
-- has the original local-agent action allowlist, so that final update was
-- rejected by rule_actions_target_safe. Preserve every existing boundary and
-- add only the new packaged Agent action.

alter table byeollog_automation.rule_actions
  drop constraint if exists rule_actions_target_safe;

alter table byeollog_automation.rule_actions
  add constraint rule_actions_target_safe check (
    (
      execution_target='server'
      and action_type='log'
      and agent_device_id is null
    )
    or
    (
      execution_target='local_agent'
      and action_type in (
        'obs.mute_for',
        'windows.mic_mute_for',
        'obs.scene_switch',
        'agent.notify',
        'flashbang.overlay'
      )
      and (
        not (params ? 'overlayAssetKey')
        or (
          action_type='obs.mute_for'
          and params->>'overlayAssetKey'='mic_off'
        )
      )
    )
  );;
