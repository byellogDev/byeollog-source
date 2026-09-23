-- Bind every raffle speech request to the active execution. The Edge runtime
-- forwards only this server-authored phrase to the same managed TTS used by
-- donation alerts; clients cannot submit arbitrary speech text.
create or replace function public.g3a_prepare_raffle_action_tts_v1(
  p_workspace_id uuid,
  p_execution_id uuid,
  p_worker_id text,
  p_attempt_no integer,
  p_speech_kind text,
  p_winner_ordinal integer,
  p_expected_binding_key text,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text)
returns table(speech_text text,binding_key text)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_execution byeollog_automation.executions%rowtype;
  v_kind text;
  v_actor_name text;
  v_winners jsonb;
  v_speech_text text;
  v_binding_key text;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component<>'agent_runtime'
     or p_worker_id is null
     or p_worker_id!~'^[A-Za-z0-9:._-]{1,200}$'
     or p_attempt_no is null or p_attempt_no not between 1 and 10
     or p_speech_kind not in ('ticket','winner')
     or p_winner_ordinal is null or p_winner_ordinal not between 0 and 99
     or p_expected_binding_key is null
     or p_expected_binding_key!~'^[0-9a-f]{64}$'
  then
    raise exception 'raffle action speech context is invalid' using errcode='22023';
  end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_agent_device_id,p_agent_secret_hash);

  select execution_row.* into v_execution
  from byeollog_automation.executions execution_row
  where execution_row.workspace_id=p_workspace_id
    and execution_row.id=p_execution_id
    and execution_row.execution_target='local_agent'
    and execution_row.agent_device_id=p_agent_device_id
    and execution_row.action_type='raffle.overlay'
    and execution_row.status='running'
    and execution_row.attempt_no=p_attempt_no
    and execution_row.lease_owner=p_worker_id
    and execution_row.lease_expires_at>clock_timestamp()
  for share;
  if not found then
    raise exception 'raffle action speech execution is not active' using errcode='55000';
  end if;

  v_kind:=v_execution.action_params->>'kind';
  if p_speech_kind='ticket' then
    if v_kind not in ('ticket_granted','test_sequence') or p_winner_ordinal<>0 then
      raise exception 'raffle execution does not contain ticket speech' using errcode='22023';
    end if;
    v_speech_text:='추첨권을 드렸어요!';
    v_binding_key:='3316a7aabfbb07f66319b3a20c1f749223de7fb39b586f69442fe31546101f32';
  else
    if v_kind='test_sequence' then
      if p_winner_ordinal<>0 then
        raise exception 'raffle test winner ordinal is invalid' using errcode='22023';
      end if;
      v_actor_name:='테스트 시청자';
    elsif v_kind='draw_result' then
      v_winners:=v_execution.action_params->'winners';
      if jsonb_typeof(v_winners)<>'array'
         or p_winner_ordinal>=jsonb_array_length(v_winners)
      then
        raise exception 'raffle winner ordinal is invalid' using errcode='22023';
      end if;
      v_actor_name:=btrim(v_winners->p_winner_ordinal->>'actorName');
    else
      raise exception 'raffle execution does not contain winner speech' using errcode='22023';
    end if;
    if v_actor_name is null
       or char_length(v_actor_name) not between 1 and 120
       or v_actor_name~'[[:cntrl:]]'
    then
      raise exception 'raffle winner name is invalid' using errcode='22023';
    end if;
    v_speech_text:=case when right(v_actor_name,1)='님'
      then v_actor_name||', 당첨을 축하드려요!'
      else v_actor_name||'님, 당첨을 축하드려요!'
    end;
    v_binding_key:=byeollog_automation.raffle_winner_voice_key_v1(v_actor_name);
  end if;

  if v_binding_key<>p_expected_binding_key then
    raise exception 'raffle speech identity did not match' using errcode='22023';
  end if;
  return query select v_speech_text,v_binding_key;
end;
$function$;

revoke all on function public.g3a_prepare_raffle_action_tts_v1(
  uuid,uuid,text,integer,text,integer,text,uuid,text,uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.g3a_prepare_raffle_action_tts_v1(
  uuid,uuid,text,integer,text,integer,text,uuid,text,uuid,uuid,text,text,text)
  to service_role;
