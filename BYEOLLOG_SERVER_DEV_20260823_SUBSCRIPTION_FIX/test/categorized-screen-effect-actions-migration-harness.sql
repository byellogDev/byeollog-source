\set ON_ERROR_STOP on
\ir voice-anonymize-pitch-presets-migration-harness.sql

-- Production already contains legacy OBS mute snapshots using the public
-- overlayImageKey spelling. Keep every packaged microphone preset valid when
-- the target constraint is replaced.
update byeollog_automation.rule_actions
   set action_type='obs.mute_for',
       params=jsonb_build_object(
         'durationMs',10000,'inputKind','microphone','restoreMode','snapshot',
         'overlayImageKey','mic_off_center')
 where id=(select id from byeollog_automation.rule_actions order by id limit 1);
\ir ../supabase/migrations/20260826060945_add_screen_and_effect_actions.sql

do $$
declare
  v_workspace uuid:='11111111-1111-4111-8111-111111111111';
  v_device uuid:='22222222-2222-4222-8222-222222222222';
  v_flip record;
  v_shake record;
  v_water record;
  v_fireworks record;
  v_test record;
  v_params jsonb;
begin
  update byeollog_automation.agent_device_status
     set reported_at=clock_timestamp(),
         supported_action_types=array[
           'obs.mute_for','flashbang.overlay','obs.voice_anonymize_for',
           'obs.voice_anonymize_for_v2','obs.screen_flip_for','obs.screen_shake_for',
           'water_splash.overlay','fireworks.overlay']
   where workspace_id=v_workspace and device_id=v_device;

  select * into strict v_flip from public.save_guided_rule_v16(
    p_workspace_id=>v_workspace,p_name=>'화면 뒤집기',p_enabled=>true,p_priority=>100,
    p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,p_result=>'뒤집기',
    p_min_amount=>null,p_action_type=>'obs.screen_flip_for',p_event_name=>null,
    p_output_types=>null,p_quantity=>null,p_duration_seconds=>6,p_agent_device_id=>v_device,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,p_allow_multiplier_stacking=>null,
    p_raffle_ticket_unit=>null,p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>null,p_visual_variant=>null,
    p_visual_volume_percent=>null,p_replace_rule_id=>null,p_expected_version=>null);
  select params into strict v_params from byeollog_automation.rule_actions where rule_id=v_flip.rule_id;
  if (select count(*) from pg_catalog.jsonb_object_keys(v_params))<>7
     or v_params->>'durationMs'<>'6000' or v_params->>'axis'<>'vertical'
     or (v_params->>'requiresObsSceneControl')::boolean is not true
  then raise exception 'flip params were not saved exactly'; end if;

  select * into strict v_shake from public.save_guided_rule_v16(
    p_workspace_id=>v_workspace,p_name=>'지진이야!',p_enabled=>true,p_priority=>100,
    p_source=>'weflab',p_event_type=>'donation',p_subtype=>null,p_result=>null,
    p_min_amount=>3300,p_action_type=>'obs.screen_shake_for',p_event_name=>null,
    p_output_types=>null,p_quantity=>null,p_duration_seconds=>4,p_agent_device_id=>v_device,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,p_allow_multiplier_stacking=>null,
    p_raffle_ticket_unit=>null,p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>null,p_visual_variant=>'strong',
    p_visual_volume_percent=>70,p_replace_rule_id=>null,p_expected_version=>null);
  select params into strict v_params from byeollog_automation.rule_actions where rule_id=v_shake.rule_id;
  if (select count(*) from pg_catalog.jsonb_object_keys(v_params))<>8
     or v_params->>'intensity'<>'strong' or v_params->>'volumePercent'<>'70'
     or v_params->>'overlayImageKey'<>'earthquake_audio'
  then raise exception 'shake params were not saved exactly'; end if;

  select * into strict v_water from public.save_guided_rule_v16(
    p_workspace_id=>v_workspace,p_name=>'물벼락',p_enabled=>true,p_priority=>100,
    p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,p_result=>'물벼락',
    p_min_amount=>null,p_action_type=>'water_splash.overlay',p_event_name=>null,
    p_output_types=>null,p_quantity=>null,p_duration_seconds=>null,p_agent_device_id=>v_device,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,p_allow_multiplier_stacking=>null,
    p_raffle_ticket_unit=>null,p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>null,p_visual_variant=>null,
    p_visual_volume_percent=>85,p_replace_rule_id=>null,p_expected_version=>null);
  select params into strict v_params from byeollog_automation.rule_actions where rule_id=v_water.rule_id;
  if (select count(*) from pg_catalog.jsonb_object_keys(v_params))<>6
     or v_params->>'effect'<>'water_splash' or v_params->>'durationMs'<>'3500'
  then raise exception 'water params were not saved exactly'; end if;

  select * into strict v_fireworks from public.save_guided_rule_v16(
    p_workspace_id=>v_workspace,p_name=>'축포',p_enabled=>true,p_priority=>100,
    p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,p_result=>'축포',
    p_min_amount=>null,p_action_type=>'fireworks.overlay',p_event_name=>null,
    p_output_types=>null,p_quantity=>null,p_duration_seconds=>null,p_agent_device_id=>v_device,
    p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
    p_overlay_scale_percent=>null,p_reward_multiplier=>null,p_allow_multiplier_stacking=>null,
    p_raffle_ticket_unit=>null,p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
    p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
    p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
    p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
    p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
    p_flashbang_volume_percent=>null,p_voice_preset=>null,p_visual_variant=>null,
    p_visual_volume_percent=>90,p_replace_rule_id=>null,p_expected_version=>null);

  select * into strict v_test from public.dispatch_guided_rule_test_v6(
    v_workspace,v_flip.rule_id,v_flip.rule_version);
  if v_test.action_type<>'obs.screen_flip_for'
     or (select action_params ? 'notAfterUtc' from byeollog_automation.executions
         where id=v_test.execution_id) is not true
  then raise exception 'visual action manual test was not queued safely'; end if;

  begin
    perform public.save_guided_rule_v16(
      p_workspace_id=>v_workspace,p_name=>'잘못된 물벼락',p_enabled=>true,p_priority=>100,
      p_source=>'weflab',p_event_type=>'roulette',p_subtype=>null,p_result=>'오류',
      p_min_amount=>null,p_action_type=>'water_splash.overlay',p_event_name=>null,
      p_output_types=>null,p_quantity=>null,p_duration_seconds=>null,p_agent_device_id=>v_device,
      p_overlay_image_key=>null,p_overlay_position_x=>null,p_overlay_position_y=>null,
      p_overlay_scale_percent=>null,p_reward_multiplier=>null,p_allow_multiplier_stacking=>null,
      p_raffle_ticket_unit=>null,p_raffle_allow_multiples=>null,p_raffle_ticket_position_x=>null,
      p_raffle_ticket_position_y=>null,p_raffle_ticket_scale_percent=>null,
      p_raffle_ticket_volume_percent=>null,p_raffle_draw_position_x=>null,
      p_raffle_draw_position_y=>null,p_raffle_draw_scale_percent=>null,
      p_raffle_draw_volume_percent=>null,p_flashbang_intensity=>null,
      p_flashbang_volume_percent=>null,p_voice_preset=>null,p_visual_variant=>null,
      p_visual_volume_percent=>null,p_replace_rule_id=>null,p_expected_version=>null);
    raise exception 'null visual volume was accepted';
  exception when sqlstate '22023' then null;
  end;

  if not pg_catalog.has_function_privilege(
       'authenticated',
       'public.save_guided_rule_v16(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,text,text,integer,uuid,integer)',
       'EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon',
       'public.save_guided_rule_v16(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,integer,integer,text,integer,text,text,integer,uuid,integer)',
       'EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated','public.dispatch_guided_rule_test_v6(uuid,uuid,integer)','EXECUTE')
     or pg_catalog.has_function_privilege(
       'anon','public.dispatch_guided_rule_test_v6(uuid,uuid,integer)','EXECUTE')
  then raise exception 'categorized action RPC privilege boundary mismatch'; end if;
end$$;

select 'CATEGORIZED_SCREEN_EFFECT_ACTIONS_MIGRATION_PASS' as result;
