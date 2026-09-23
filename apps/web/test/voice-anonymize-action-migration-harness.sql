\set ON_ERROR_STOP on
\ir flashbang-action-migration-harness.sql
\ir ../supabase/migrations/20260825120000_add_voice_anonymize_action.sql

do $$
declare
  v_workspace uuid:='11111111-1111-4111-8111-111111111111';
  v_device uuid:='22222222-2222-4222-8222-222222222222';
  v_saved record;
  v_donation_saved record;
  v_legacy_saved record;
  v_test record;
  v_params jsonb;
begin
  update byeollog_automation.agent_device_status
     set reported_at=clock_timestamp(),
         supported_action_types=array[
           'obs.mute_for','flashbang.overlay','obs.voice_anonymize_for']
   where workspace_id=v_workspace and device_id=v_device;

  select * into strict v_saved from public.save_guided_rule_v14(
    p_workspace_id=>v_workspace,p_name=>'(신원보호모드/개발중)',
    p_enabled=>true,p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',
    p_subtype=>null,p_result=>'신원보호',p_min_amount=>null,
    p_action_type=>'obs.voice_anonymize_for',p_event_name=>null,p_output_types=>null,
    p_quantity=>null,p_duration_seconds=>10,p_agent_device_id=>v_device,
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

  select params into strict v_params
  from byeollog_automation.rule_actions where rule_id=v_saved.rule_id;
  if (select action_type from public.rule_actions where rule_id=v_saved.rule_id)
       <>'obs.voice_anonymize_for'
     or (select action_type from byeollog_automation.rule_actions where rule_id=v_saved.rule_id)
       <>'obs.voice_anonymize_for'
     or (select agent_device_id from byeollog_automation.rule_actions where rule_id=v_saved.rule_id)
       is distinct from v_device
     or (select timeout_ms from byeollog_automation.rule_actions where rule_id=v_saved.rule_id)
       <>120000
     or (select count(*) from pg_catalog.jsonb_object_keys(v_params))<>7
     or v_params->>'label'<>'(신원보호모드/개발중)'
     or v_params->>'controlType'<>'voice_anonymize'
     or v_params->>'target'<>'microphone'
     or v_params->>'durationMs'<>'10000'
     or v_params->>'preset'<>'anonymous_low'
     or (v_params->>'requiresObsMicInput')::boolean is not true
     or (v_params->>'requiresObsFilter')::boolean is not true
  then
    raise exception 'voice anonymize rule contract was not saved exactly';
  end if;
  if not exists(
       select 1 from public.rule_conditions
       where rule_id=v_saved.rule_id and path='payload.result' and operator='eq'
         and value='"신원보호"'::jsonb)
     or exists(
       select 1 from public.rule_conditions
       where rule_id=v_saved.rule_id and path='amount')
  then
    raise exception 'voice anonymize roulette condition was not saved exactly';
  end if;

  select * into strict v_donation_saved from public.save_guided_rule_v14(
    p_workspace_id=>v_workspace,p_name=>'77 신원보호',p_enabled=>true,
    p_priority=>100,p_source=>'weflab',p_event_type=>'donation',p_subtype=>null,
    p_result=>null,p_min_amount=>77,p_action_type=>'obs.voice_anonymize_for',
    p_event_name=>null,p_output_types=>null,p_quantity=>null,p_duration_seconds=>3,
    p_agent_device_id=>v_device,p_overlay_image_key=>null,p_overlay_position_x=>null,
    p_overlay_position_y=>null,p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>'anonymous_low',
    p_replace_rule_id=>null,p_expected_version=>null);
  if not exists(
       select 1 from public.rule_conditions
       where rule_id=v_donation_saved.rule_id and path='amount' and operator='eq'
         and value='77'::jsonb)
     or exists(
       select 1 from public.rule_conditions
       where rule_id=v_donation_saved.rule_id and path='payload.result')
  then
    raise exception 'voice anonymize exact donation condition was not saved exactly';
  end if;

  -- v14 is additive: an existing flashbang draft with a null voice field still
  -- delegates to the existing v13 implementation unchanged.
  select * into strict v_legacy_saved from public.save_guided_rule_v14(
    p_workspace_id=>v_workspace,p_name=>'기존 섬광탄 호환',p_enabled=>true,
    p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,
    p_result=>'기존 섬광탄',p_min_amount=>null,p_action_type=>'flashbang.overlay',
    p_event_name=>null,p_output_types=>null,p_quantity=>null,p_duration_seconds=>null,
    p_agent_device_id=>v_device,p_overlay_image_key=>null,p_overlay_position_x=>null,
    p_overlay_position_y=>null,p_overlay_scale_percent=>null,p_reward_multiplier=>null,
    p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
    p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>'standard',
    p_flashbang_volume_percent=>50,p_voice_preset=>null,
    p_replace_rule_id=>null,p_expected_version=>null);
  if (select action_type from byeollog_automation.rule_actions
      where rule_id=v_legacy_saved.rule_id)<>'flashbang.overlay'
  then
    raise exception 'v14 did not preserve the v13 compatibility path';
  end if;

  begin
    perform public.save_guided_rule_v14(
      p_workspace_id=>v_workspace,p_name=>'짧은 신원보호',p_enabled=>true,
      p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,
      p_result=>'짧음',p_min_amount=>null,p_action_type=>'obs.voice_anonymize_for',
      p_event_name=>null,p_output_types=>null,p_quantity=>null,p_duration_seconds=>2,
      p_agent_device_id=>v_device,p_overlay_image_key=>null,p_overlay_position_x=>null,
      p_overlay_position_y=>null,p_overlay_scale_percent=>null,p_reward_multiplier=>null,
      p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
      p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
      p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
      p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
      p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
      p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
      p_flashbang_volume_percent=>null,p_voice_preset=>'anonymous_low',
      p_replace_rule_id=>null,p_expected_version=>null);
    raise exception 'duration below the lower bound was accepted';
  exception when sqlstate '22023' then null;
  end;
  begin
    perform public.save_guided_rule_v14(
      p_workspace_id=>v_workspace,p_name=>'위조 preset',p_enabled=>true,
      p_priority=>100,p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,
      p_result=>'위조',p_min_amount=>null,p_action_type=>'obs.voice_anonymize_for',
      p_event_name=>null,p_output_types=>null,p_quantity=>null,p_duration_seconds=>10,
      p_agent_device_id=>v_device,p_overlay_image_key=>null,p_overlay_position_x=>null,
      p_overlay_position_y=>null,p_overlay_scale_percent=>null,p_reward_multiplier=>null,
      p_allow_multiplier_stacking=>null,p_raffle_ticket_unit=>null,
      p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
      p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
      p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
      p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
      p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
      p_flashbang_volume_percent=>null,p_voice_preset=>'anonymous_high',
      p_replace_rule_id=>null,p_expected_version=>null);
    raise exception 'unknown voice preset was accepted';
  exception when sqlstate '22023' then null;
  end;

  select * into strict v_test from public.dispatch_guided_rule_test_v4(
    v_workspace,v_saved.rule_id,1);
  if v_test.action_type<>'obs.voice_anonymize_for'
     or v_test.agent_device_id is distinct from v_device
     or (select action_params->>'notAfterUtc'
         from byeollog_automation.executions where id=v_test.execution_id) is null
     or (select action_params->>'preset'
         from byeollog_automation.executions where id=v_test.execution_id)<>'anonymous_low'
     or (select timeout_ms
         from byeollog_automation.executions where id=v_test.execution_id)<>120000
     or (select max_attempts
         from byeollog_automation.executions where id=v_test.execution_id)<>1
  then
    raise exception 'voice anonymize test execution/deadline was not created exactly';
  end if;

  if not pg_catalog.has_function_privilege(
       'authenticated',
       'public.save_guided_rule_v14(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,text,uuid,integer)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon',
       'public.save_guided_rule_v14(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,text,uuid,integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated','public.dispatch_guided_rule_test_v4(uuid,uuid,integer)','EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon','public.dispatch_guided_rule_test_v4(uuid,uuid,integer)','EXECUTE')
  then
    raise exception 'voice anonymize RPC privilege boundary mismatch';
  end if;
end$$;

select 'VOICE_ANONYMIZE_ACTION_MIGRATION_PASS' as result;
