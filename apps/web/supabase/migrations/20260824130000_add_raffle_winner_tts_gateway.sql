-- A local Agent may request audio only for the winner already sealed into its
-- currently leased raffle execution.  The Edge gateway uses this service-role
-- RPC; browser roles cannot read arbitrary winner names through it.
create or replace function public.g3a_prepare_raffle_winner_tts_v1(
  p_workspace_id uuid,
  p_execution_id uuid,
  p_worker_id text,
  p_attempt_no integer,
  p_winner_ordinal integer,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns table(actor_name text, voice_key text)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_execution byeollog_automation.executions%rowtype;
  v_kind text;
  v_actor_name text;
  v_winners jsonb;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );
  if p_runtime_component <> 'agent_runtime'
     or p_worker_id is null
     or p_worker_id !~ '^[A-Za-z0-9:._-]{1,200}$'
     or p_attempt_no is null or p_attempt_no not between 1 and 10
     or p_winner_ordinal is null or p_winner_ordinal not between 0 and 99
  then
    raise exception 'raffle winner speech context is invalid' using errcode='22023';
  end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,
    p_agent_device_id,
    p_agent_secret_hash
  );

  select execution_row.*
    into v_execution
  from byeollog_automation.executions execution_row
  where execution_row.workspace_id = p_workspace_id
    and execution_row.id = p_execution_id
    and execution_row.execution_target = 'local_agent'
    and execution_row.agent_device_id = p_agent_device_id
    and execution_row.action_type = 'raffle.overlay'
    and execution_row.status = 'running'
    and execution_row.attempt_no = p_attempt_no
    and execution_row.lease_owner = p_worker_id
    and execution_row.lease_expires_at > clock_timestamp()
  for share;
  if not found then
    raise exception 'raffle winner speech execution is not active' using errcode='55000';
  end if;

  v_kind := v_execution.action_params->>'kind';
  if v_kind = 'test_sequence' then
    if p_winner_ordinal <> 0 then
      raise exception 'raffle test winner ordinal is invalid' using errcode='22023';
    end if;
    v_actor_name := '테스트 시청자';
  elsif v_kind = 'draw_result' then
    v_winners := v_execution.action_params->'winners';
    if jsonb_typeof(v_winners) <> 'array'
       or p_winner_ordinal >= jsonb_array_length(v_winners)
    then
      raise exception 'raffle winner ordinal is invalid' using errcode='22023';
    end if;
    v_actor_name := btrim(v_winners->p_winner_ordinal->>'actorName');
  else
    raise exception 'raffle execution does not contain a winner' using errcode='22023';
  end if;

  if v_actor_name is null
     or char_length(v_actor_name) not between 1 and 120
     or v_actor_name ~ '[[:cntrl:]]'
  then
    raise exception 'raffle winner name is invalid' using errcode='22023';
  end if;

  return query select
    v_actor_name,
    encode(
      extensions.digest(
        pg_catalog.convert_to('raffle-winner-voice-v1|' || v_actor_name, 'UTF8'),
        'sha256'
      ),
      'hex'
    );
end;
$function$;

revoke all on function public.g3a_prepare_raffle_winner_tts_v1(
  uuid,uuid,text,integer,integer,uuid,text,uuid,uuid,text,text,text
) from public,anon,authenticated,service_role;
grant execute on function public.g3a_prepare_raffle_winner_tts_v1(
  uuid,uuid,text,integer,integer,uuid,text,uuid,uuid,text,text,text
) to service_role;
