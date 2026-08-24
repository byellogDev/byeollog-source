\set ON_ERROR_STOP on

do $$
declare
  v_workspace constant uuid := '10000000-0000-4000-8000-000000000001';
  v_device constant uuid := '20000000-0000-4000-8000-000000000001';
  v_draw constant uuid := '30000000-0000-4000-8000-000000000001';
  v_test constant uuid := '30000000-0000-4000-8000-000000000002';
  v_round constant uuid := '30000000-0000-4000-8000-000000000003';
  v_pool_draw constant uuid := '30000000-0000-4000-8000-000000000004';
  v_actor text;
  v_voice_key text;
  v_bound_key text;
  v_total bigint;
begin
  insert into byeollog_automation.executions(
    id,workspace_id,execution_target,agent_device_id,action_type,action_params,
    status,attempt_no,lease_owner,lease_expires_at
  ) values
  (
    v_draw,v_workspace,'local_agent',v_device,'raffle.overlay',
    '{"kind":"draw_result","winners":[{"actorName":"로기랑지유니"},{"actorName":"gahdh"}]}',
    'running',2,'agent:worker-1',clock_timestamp()+interval '5 minutes'
  ),
  (
    v_test,v_workspace,'local_agent',v_device,'raffle.overlay',
    '{"kind":"test_sequence"}',
    'running',1,'agent:worker-1',clock_timestamp()+interval '5 minutes'
  );

  select action_params->'winners'->0->>'voiceKey'
  into strict v_bound_key
  from byeollog_automation.executions where id=v_draw;
  if v_bound_key<>byeollog_automation.raffle_winner_voice_key_v1('로기랑지유니') then
    raise exception 'draw execution was not bound to its exact winner voice key';
  end if;

  select actor_name,voice_key into strict v_actor,v_voice_key
  from public.g3a_prepare_raffle_winner_tts_v1(
    v_workspace,v_draw,'agent:worker-1',2,0,v_device,'secret',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'agent_runtime','runtime-v1','db-v1'
  );
  if v_actor<>'로기랑지유니'
     or v_voice_key<>encode(
       extensions.digest(
         pg_catalog.convert_to('raffle-winner-voice-v1|로기랑지유니','UTF8'),
         'sha256'
       ),
       'hex'
     )
  then
    raise exception 'sealed draw winner speech identity mismatch';
  end if;

  select actor_name into strict v_actor
  from public.g3a_prepare_raffle_winner_tts_v1(
    v_workspace,v_test,'agent:worker-1',1,0,v_device,'secret',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'agent_runtime','runtime-v1','db-v1'
  );
  if v_actor<>'테스트 시청자' then
    raise exception 'test sequence winner speech identity mismatch';
  end if;

  begin
    perform public.g3a_prepare_raffle_winner_tts_v1(
      v_workspace,v_draw,'agent:wrong-worker',2,0,v_device,'secret',
      '40000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      'agent_runtime','runtime-v1','db-v1'
    );
    raise exception 'wrong execution lease unexpectedly exposed a winner';
  exception when sqlstate '55000' then null;
  end;

  insert into byeollog_automation.raffle_rounds(
    id,workspace_id,status,agent_device_id)
  values(v_round,v_workspace,'sealed',v_device);
  insert into byeollog_automation.raffle_draws(id,workspace_id,round_id)
  values(v_pool_draw,v_workspace,v_round);
  insert into byeollog_automation.raffle_draw_candidates(
    draw_id,actor_key,actor_name)
  values
    (v_pool_draw,'soop:user-a','첫 번째 후보'),
    (v_pool_draw,'soop:user-b','두 번째 후보');

  select actor_name,voice_key,total_count
  into strict v_actor,v_voice_key,v_total
  from public.g3a_list_raffle_tts_candidates_v1(
    v_workspace,v_pool_draw,null,1,v_device,'secret',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'agent_runtime','runtime-v1','db-v1');
  if v_actor<>'첫 번째 후보' or v_total<>2
     or v_voice_key<>byeollog_automation.raffle_winner_voice_key_v1(v_actor)
  then
    raise exception 'sealed candidate manifest identity mismatch';
  end if;

  select actor_name,voice_key into strict v_actor,v_voice_key
  from public.g3a_prepare_raffle_candidate_tts_v1(
    v_workspace,v_pool_draw,'soop:user-b',
    byeollog_automation.raffle_winner_voice_key_v1('두 번째 후보'),
    v_device,'secret',
    '40000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000001',
    'agent_runtime','runtime-v1','db-v1');
  if v_actor<>'두 번째 후보'
     or v_voice_key<>byeollog_automation.raffle_winner_voice_key_v1(v_actor)
  then
    raise exception 'candidate synthesis identity mismatch';
  end if;

  begin
    perform public.g3a_prepare_raffle_candidate_tts_v1(
      v_workspace,v_pool_draw,'soop:user-b',
      byeollog_automation.raffle_winner_voice_key_v1('첫 번째 후보'),
      v_device,'secret',
      '40000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      'agent_runtime','runtime-v1','db-v1');
    raise exception 'another candidate voice key unexpectedly succeeded';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.g3a_prepare_raffle_winner_tts_v1(
      v_workspace,v_draw,'agent:worker-1',2,2,v_device,'secret',
      '40000000-0000-4000-8000-000000000001',
      '50000000-0000-4000-8000-000000000001',
      'agent_runtime','runtime-v1','db-v1'
    );
    raise exception 'out-of-range winner ordinal unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;

  if pg_catalog.has_function_privilege(
       'authenticated',
       'public.g3a_prepare_raffle_winner_tts_v1(uuid,uuid,text,integer,integer,uuid,text,uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.g3a_prepare_raffle_winner_tts_v1(uuid,uuid,text,integer,integer,uuid,text,uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.g3a_list_raffle_tts_candidates_v1(uuid,uuid,text,integer,uuid,text,uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.g3a_list_raffle_tts_candidates_v1(uuid,uuid,text,integer,uuid,text,uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     or pg_catalog.has_function_privilege(
       'authenticated',
       'public.g3a_prepare_raffle_candidate_tts_v1(uuid,uuid,text,text,uuid,text,uuid,uuid,text,text,text)',
       'EXECUTE'
     )
     or not pg_catalog.has_function_privilege(
       'service_role',
       'public.g3a_prepare_raffle_candidate_tts_v1(uuid,uuid,text,text,uuid,text,uuid,uuid,text,text,text)',
       'EXECUTE'
     )
  then
    raise exception 'raffle winner TTS function privilege boundary mismatch';
  end if;
end
$$;

select 'RAFFLE_WINNER_TTS_MIGRATION_PASS' as result;
