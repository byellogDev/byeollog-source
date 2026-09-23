-- Bind every raffle winner presentation to one deterministic voice identity.
-- Audio may be late or unavailable, but it must never be accepted for a
-- different candidate.  Browser roles cannot call the prewarm RPCs directly.

create or replace function byeollog_automation.raffle_winner_voice_key_v1(
  p_actor_name text)
returns text
language sql
immutable
strict
set search_path=''
as $function$
  select encode(
    extensions.digest(
      pg_catalog.convert_to('raffle-winner-voice-v1|'||p_actor_name,'UTF8'),
      'sha256'),
    'hex')
$function$;

revoke all on function byeollog_automation.raffle_winner_voice_key_v1(text)
  from public,anon,authenticated,service_role;
grant execute on function byeollog_automation.raffle_winner_voice_key_v1(text)
  to service_role;

create or replace function byeollog_automation.bind_raffle_winner_voice_keys_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_winners jsonb;
  v_bound jsonb;
begin
  if new.action_type<>'raffle.overlay'
     or new.action_params->>'kind'<>'draw_result'
  then
    return new;
  end if;

  v_winners:=new.action_params->'winners';
  if jsonb_typeof(v_winners)<>'array'
     or jsonb_array_length(v_winners) not between 1 and 100
  then
    raise exception 'raffle winner voice identity is invalid' using errcode='22023';
  end if;

  select jsonb_agg(
    winner.value||jsonb_build_object(
      'voiceKey',
      byeollog_automation.raffle_winner_voice_key_v1(
        btrim(winner.value->>'actorName')))
    order by winner.ordinality)
  into v_bound
  from jsonb_array_elements(v_winners) with ordinality as winner(value,ordinality)
  where jsonb_typeof(winner.value)='object'
    and btrim(winner.value->>'actorName') is not null
    and char_length(btrim(winner.value->>'actorName')) between 1 and 120
    and btrim(winner.value->>'actorName') !~ '[[:cntrl:]]';

  if v_bound is null
     or jsonb_array_length(v_bound)<>jsonb_array_length(v_winners)
  then
    raise exception 'raffle winner voice identity is invalid' using errcode='22023';
  end if;
  new.action_params:=jsonb_set(new.action_params,'{winners}',v_bound,false);
  return new;
end;
$function$;

revoke all on function byeollog_automation.bind_raffle_winner_voice_keys_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists bind_raffle_winner_voice_keys_v1
  on byeollog_automation.executions;
create trigger bind_raffle_winner_voice_keys_v1
before insert or update of action_params on byeollog_automation.executions
for each row execute function byeollog_automation.bind_raffle_winner_voice_keys_v1();

-- Historical rows are not replayed merely because a voice key is added.  This
-- update also gives pending rows the same fail-closed identity contract.
update byeollog_automation.executions execution_row
set action_params=execution_row.action_params
where execution_row.action_type='raffle.overlay'
  and execution_row.action_params->>'kind'='draw_result'
  and exists(
    select 1
    from jsonb_array_elements(execution_row.action_params->'winners') winner
    where not (winner?'voiceKey'));

create or replace function public.g3a_list_raffle_tts_candidates_v1(
  p_workspace_id uuid,
  p_draw_id uuid,
  p_after_actor_key text,
  p_limit integer,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text)
returns table(
  actor_key text,
  actor_name text,
  voice_key text,
  total_count bigint)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_total bigint;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component<>'agent_runtime'
     or p_draw_id is null
     or p_limit is null or p_limit not between 1 and 25
     or (p_after_actor_key is not null
       and char_length(p_after_actor_key) not between 1 and 180)
  then
    raise exception 'raffle TTS candidate request is invalid' using errcode='22023';
  end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_agent_device_id,p_agent_secret_hash);

  if not exists(
    select 1
    from byeollog_automation.raffle_draws draw_row
    join byeollog_automation.raffle_rounds round_row
      on round_row.id=draw_row.round_id
    where draw_row.id=p_draw_id
      and draw_row.workspace_id=p_workspace_id
      and round_row.workspace_id=p_workspace_id
      and round_row.status='sealed'
      and round_row.agent_device_id=p_agent_device_id)
  then
    raise exception 'sealed raffle TTS candidate set was not found' using errcode='55000';
  end if;

  select count(*)::bigint into v_total
  from byeollog_automation.raffle_draw_candidates candidate_row
  where candidate_row.draw_id=p_draw_id;

  return query
  select candidate_row.actor_key,
    candidate_row.actor_name,
    byeollog_automation.raffle_winner_voice_key_v1(candidate_row.actor_name),
    v_total
  from byeollog_automation.raffle_draw_candidates candidate_row
  where candidate_row.draw_id=p_draw_id
    and (p_after_actor_key is null or candidate_row.actor_key>p_after_actor_key)
  order by candidate_row.actor_key
  limit p_limit;
end;
$function$;

revoke all on function public.g3a_list_raffle_tts_candidates_v1(
  uuid,uuid,text,integer,uuid,text,uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.g3a_list_raffle_tts_candidates_v1(
  uuid,uuid,text,integer,uuid,text,uuid,uuid,text,text,text)
  to service_role;

create or replace function public.g3a_prepare_raffle_candidate_tts_v1(
  p_workspace_id uuid,
  p_draw_id uuid,
  p_actor_key text,
  p_expected_voice_key text,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text)
returns table(actor_name text,voice_key text)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_actor_name text;
  v_voice_key text;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component<>'agent_runtime'
     or p_draw_id is null
     or p_actor_key is null or char_length(p_actor_key) not between 1 and 180
     or p_expected_voice_key is null
     or p_expected_voice_key !~ '^[0-9a-f]{64}$'
  then
    raise exception 'raffle candidate speech context is invalid' using errcode='22023';
  end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_agent_device_id,p_agent_secret_hash);

  select candidate_row.actor_name
  into v_actor_name
  from byeollog_automation.raffle_draw_candidates candidate_row
  join byeollog_automation.raffle_draws draw_row
    on draw_row.id=candidate_row.draw_id
  join byeollog_automation.raffle_rounds round_row
    on round_row.id=draw_row.round_id
  where candidate_row.draw_id=p_draw_id
    and candidate_row.actor_key=p_actor_key
    and draw_row.workspace_id=p_workspace_id
    and round_row.workspace_id=p_workspace_id
    and round_row.status='sealed'
    and round_row.agent_device_id=p_agent_device_id
  for share of candidate_row,draw_row,round_row;
  if not found then
    raise exception 'sealed raffle TTS candidate was not found' using errcode='55000';
  end if;

  v_voice_key:=byeollog_automation.raffle_winner_voice_key_v1(v_actor_name);
  if v_voice_key<>p_expected_voice_key then
    raise exception 'raffle candidate voice identity changed' using errcode='40001';
  end if;
  return query select v_actor_name,v_voice_key;
end;
$function$;

revoke all on function public.g3a_prepare_raffle_candidate_tts_v1(
  uuid,uuid,text,text,uuid,text,uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.g3a_prepare_raffle_candidate_tts_v1(
  uuid,uuid,text,text,uuid,text,uuid,uuid,text,text,text)
  to service_role;


