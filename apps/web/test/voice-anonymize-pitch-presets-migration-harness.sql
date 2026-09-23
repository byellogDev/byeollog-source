\set ON_ERROR_STOP on
\ir voice-anonymize-action-migration-harness.sql
\ir ../supabase/migrations/20260825134122_add_voice_anonymizer_pitch_presets.sql

do $$
declare
  v_workspace uuid:='11111111-1111-4111-8111-111111111111';
  v_device uuid:='22222222-2222-4222-8222-222222222222';
  v_high record;
  v_legacy record;
  v_test record;
  v_params jsonb;
begin
  update byeollog_automation.agent_device_status
     set reported_at=clock_timestamp(),
         supported_action_types=array[
           'obs.mute_for','flashbang.overlay','obs.voice_anonymize_for',
           'obs.voice_anonymize_for_v2']
   where workspace_id=v_workspace and device_id=v_device;

  select * into strict v_high from public.save_guided_rule_v15(
    p_workspace_id=>v_workspace,p_name=>'(신원보호모드/개발중) 업톤',
    p_enabled=>true,p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',
    p_subtype=>null,p_result=>'업톤',p_min_amount=>null,
    p_action_type=>'obs.voice_anonymize_for_v2',p_event_name=>null,
    p_output_types=>null,p_quantity=>null,p_duration_seconds=>10,
    p_agent_device_id=>v_device,p_overlay_image_key=>null,
    p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>'anonymous_high',
    p_replace_rule_id=>null,p_expected_version=>null);

  select params into strict v_params
    from byeollog_automation.rule_actions where rule_id=v_high.rule_id;
  if (select action_type from public.rule_actions where rule_id=v_high.rule_id)
       <>'obs.voice_anonymize_for_v2'
     or (select action_type from byeollog_automation.rule_actions where rule_id=v_high.rule_id)
       <>'obs.voice_anonymize_for_v2'
     or (select count(*) from pg_catalog.jsonb_object_keys(v_params))<>7
     or v_params->>'preset'<>'anonymous_high'
     or v_params->>'durationMs'<>'10000'
  then
    raise exception 'high voice preset was not saved exactly';
  end if;

  select * into strict v_test from public.dispatch_guided_rule_test_v5(
    v_workspace,v_high.rule_id,v_high.rule_version);
  if v_test.action_type<>'obs.voice_anonymize_for_v2'
     or (select action_params->>'preset'
           from byeollog_automation.executions where id=v_test.execution_id)
       <>'anonymous_high'
     or (select action_params ? 'notAfterUtc'
           from byeollog_automation.executions where id=v_test.execution_id) is not true
  then
    raise exception 'high voice preset test was not queued exactly';
  end if;

  -- v15 remains additive and delegates existing action contracts unchanged.
  select * into strict v_legacy from public.save_guided_rule_v15(
    p_workspace_id=>v_workspace,p_name=>'기존 다운톤 호환',p_enabled=>true,
    p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,
    p_result=>'기존 다운톤',p_min_amount=>null,
    p_action_type=>'obs.voice_anonymize_for',p_event_name=>null,p_output_types=>null,
    p_quantity=>null,p_duration_seconds=>3,p_agent_device_id=>v_device,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>'anonymous_low',
    p_replace_rule_id=>null,p_expected_version=>null);
  if (select action_type from byeollog_automation.rule_actions
      where rule_id=v_legacy.rule_id)<>'obs.voice_anonymize_for'
  then
    raise exception 'v15 did not preserve the legacy voice action path';
  end if;

  begin
    perform public.save_guided_rule_v15(
      p_workspace_id=>v_workspace,p_name=>'잘못된 프리셋',p_enabled=>true,
      p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,
      p_result=>'오류',p_min_amount=>null,p_action_type=>'obs.voice_anonymize_for_v2',
      p_event_name=>null,p_output_types=>null,p_quantity=>null,p_duration_seconds=>10,
      p_agent_device_id=>v_device,p_overlay_image_key=>null,
      p_overlay_position_x=>null,p_overlay_position_y=>null,
      p_overlay_scale_percent=>null,p_reward_multiplier=>null,
      p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
      p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
      p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
      p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
      p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
      p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
      p_flashbang_volume_percent=>null,p_voice_preset=>'anonymous_mid',
      p_replace_rule_id=>null,p_expected_version=>null);
    raise exception 'unknown voice preset was accepted';
  exception when sqlstate '22023' then null;
  end;

  if not pg_catalog.has_function_privilege(
       'authenticated',
       'public.save_guided_rule_v15(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,text,uuid,integer)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon',
       'public.save_guided_rule_v15(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,text,uuid,integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated','public.dispatch_guided_rule_test_v5(uuid,uuid,integer)','EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon','public.dispatch_guided_rule_test_v5(uuid,uuid,integer)','EXECUTE')
  then
    raise exception 'voice preset RPC privilege boundary mismatch';
  end if;
end$$;

select 'VOICE_ANONYMIZE_PITCH_PRESETS_MIGRATION_PASS' as result;
