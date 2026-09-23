-- 추첨권 당첨 순번은 감사 가능한 seed를 유지하면서도 단순 modulo 축소에서
-- 생기는 이론적 편향을 제거한다. 60-bit SHA-256 블록의 불완전한 꼬리 구간을
-- 버리는 rejection sampling이라 모든 유효 순번의 표현 수가 정확히 같다.
create or replace function byeollog_automation.raffle_unbiased_index_v1(
  p_seed text,
  p_draw_index integer,
  p_exclusive_upper bigint)
returns bigint
language plpgsql
immutable
security invoker
set search_path=''
as $function$
declare
  v_range constant numeric:=1152921504606846976; -- 2^60
  v_limit numeric;
  v_value bigint;
  v_counter integer;
begin
  if p_seed is null or char_length(p_seed) not between 1 and 256
     or p_draw_index is null or p_draw_index not between 1 and 100
     or p_exclusive_upper is null or p_exclusive_upper not between 1 and 1000000
  then
    raise exception 'raffle random sampling parameters are invalid' using errcode='22023';
  end if;

  v_limit:=v_range-mod(v_range,p_exclusive_upper::numeric);
  for v_counter in 0..127 loop
    v_value:=('x'||substr(encode(extensions.digest(
      pg_catalog.convert_to(
        p_seed||'|'||p_draw_index::text||'|'||v_counter::text,'UTF8'),
      'sha256'),'hex'),1,15))::bit(60)::bigint;
    if v_value::numeric<v_limit then
      return mod(v_value,p_exclusive_upper)+1;
    end if;
  end loop;

  -- pgcrypto 고장이나 비정상 실행 환경에서는 편향된 fallback을 쓰지 않는다.
  raise exception 'raffle random sampling rejection limit exceeded' using errcode='55000';
end;
$function$;

revoke all on function byeollog_automation.raffle_unbiased_index_v1(text,integer,bigint)
  from public,anon,authenticated,service_role;

-- 최신 공개 RPC 본문은 기존 동시성·원장·송출 계약을 그대로 두고 순번 산식만
-- private unbiased sampler로 교체한다.
create or replace function public.draw_next_raffle_winner_v2(
  p_workspace_id uuid,
  p_draw_id uuid,
  p_expected_draw_index integer,
  p_expected_agent_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $function$
declare
  v_uid uuid;
  v_round byeollog_automation.raffle_rounds%rowtype;
  v_draw byeollog_automation.raffle_draws%rowtype;
  v_action_params jsonb;
  v_event_id uuid:=extensions.gen_random_uuid();
  v_execution_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_total integer;
  v_ordinal integer;
  v_index integer;
  v_actor_key text;
  v_actor_name text;
  v_actor_tickets integer;
  v_winner jsonb;
  v_plan_token text;
  v_idempotency_key text;
  v_completed boolean;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_draw_id is null
     or p_expected_agent_device_id is null
     or p_expected_draw_index is null
     or p_expected_draw_index not between 1 and 100
  then
    raise exception 'raffle draw request is invalid' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle:'||p_workspace_id::text,5301));

  select * into v_round
  from byeollog_automation.raffle_rounds
  where workspace_id=p_workspace_id and status='sealed'
  for update;
  if not found then
    raise exception 'sealed raffle round was not found' using errcode='P0002';
  end if;
  if v_round.agent_device_id<>p_expected_agent_device_id then
    raise exception 'raffle draw state changed' using errcode='40001';
  end if;

  select * into v_draw
  from byeollog_automation.raffle_draws
  where round_id=v_round.id and id=p_draw_id
  for update;
  if not found then
    raise exception 'raffle draw state changed' using errcode='40001';
  end if;

  select count(*)::integer+1 into v_index
  from byeollog_automation.raffle_winners where draw_id=v_draw.id;
  if v_index<>p_expected_draw_index then
    raise exception 'raffle draw state changed' using errcode='40001';
  end if;
  if v_index>v_draw.winner_count then
    raise exception 'raffle draw is already complete' using errcode='PT409';
  end if;

  if not exists(
    select 1
    from byeollog_automation.agent_devices device_row
    join byeollog_automation.agent_device_status status_row
      on status_row.workspace_id=device_row.workspace_id
     and status_row.device_id=device_row.device_id
    where device_row.workspace_id=p_workspace_id
      and device_row.device_id=v_round.agent_device_id
      and device_row.revoked_at is null
      and status_row.reported_at>v_now-interval '2 minutes'
      and 'raffle.overlay'=any(status_row.supported_action_types))
  then
    raise exception 'raffle action agent device is not currently online' using errcode='PT409';
  end if;

  select params into strict v_action_params
  from byeollog_automation.rule_actions
  where id=v_round.action_id and rule_id=v_round.rule_id;

  select coalesce(sum(remaining_ticket_count),0)::integer into v_total
  from byeollog_automation.raffle_draw_candidates where draw_id=v_draw.id;
  if v_total<1 then
    raise exception 'raffle candidate pool was exhausted' using errcode='22023';
  end if;

  v_ordinal:=byeollog_automation.raffle_unbiased_index_v1(
    v_draw.random_seed,v_index,v_total)::integer;
  select actor_key,actor_name,original_ticket_count
    into strict v_actor_key,v_actor_name,v_actor_tickets
  from (
    select candidate_row.*,
      sum(candidate_row.remaining_ticket_count) over(
        order by candidate_row.actor_key rows unbounded preceding) running_total
    from byeollog_automation.raffle_draw_candidates candidate_row
    where candidate_row.draw_id=v_draw.id
      and candidate_row.remaining_ticket_count>0
  ) pool
  where pool.running_total>=v_ordinal
  order by pool.actor_key limit 1;

  insert into byeollog_automation.raffle_winners(
    draw_id,draw_index,actor_key,actor_name,ticket_count_at_draw,selected_ticket_ordinal)
  values(v_draw.id,v_index,v_actor_key,v_actor_name,v_actor_tickets,v_ordinal);
  update byeollog_automation.raffle_draw_candidates
  set remaining_ticket_count=case
    when v_draw.allow_duplicate_winners then remaining_ticket_count-1 else 0 end
  where draw_id=v_draw.id and actor_key=v_actor_key;

  v_completed:=v_index=v_draw.winner_count;
  if v_completed then
    update byeollog_automation.raffle_rounds
    set status='drawn',drawn_at=v_now
    where id=v_round.id;
  end if;

  v_winner:=jsonb_build_object('drawIndex',v_index,'actorName',v_actor_name);
  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-draw-step-v1|'||p_workspace_id::text||'|'||v_draw.id::text||'|'||v_index::text,
    'UTF8'),'sha256'),'hex');
  v_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-draw-step-execution-v1|'||p_workspace_id::text||'|'||v_draw.id::text||'|'||v_index::text,
    'UTF8'),'sha256'),'hex');

  insert into byeollog_automation.events(
    id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
    actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,
    authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(
    v_event_id,p_workspace_id,'1.0',
    'raffle-draw-'||v_draw.id::text||'-'||v_index::text,
    'manual','byeollog','raffle_draw','winner_selection',
    jsonb_build_object('id',v_uid,'name','별록 스트리머'),null,null,
    jsonb_build_object('drawId',v_draw.id,'drawIndex',v_index,
      'winnerTarget',v_draw.winner_count,'winner',v_winner),
    null,'raffle-draw:'||v_draw.id::text,v_now,v_now,v_uid,v_plan_token,
    array[v_round.rule_id],array[v_round.rule_id]);

  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(
    v_execution_id,p_workspace_id,v_event_id,v_round.rule_id,v_round.action_id,
    v_idempotency_key,'local_agent',v_round.agent_device_id,'raffle.overlay',
    jsonb_build_object(
      'kind','draw_result','overlayImageKey','raffle_draw','durationMs',4000,
      'overlayPositionX',coalesce((v_action_params->>'drawOverlayPositionX')::integer,5000),
      'overlayPositionY',coalesce((v_action_params->>'drawOverlayPositionY')::integer,5000),
      'overlayScalePercent',coalesce((v_action_params->>'drawOverlayScalePercent')::integer,100),
      'winnerCount',1,'drawIndex',v_index,'winnerTarget',v_draw.winner_count,
      'winners',jsonb_build_array(v_winner)),
    120000,3,5);

  return jsonb_build_object(
    'drawId',v_draw.id,
    'roundId',v_round.id,
    'executionId',v_execution_id,
    'agentDeviceId',v_round.agent_device_id,
    'winner',v_winner,
    'drawnCount',v_index,
    'remainingCount',v_draw.winner_count-v_index,
    'completed',v_completed);
end;
$function$;

revoke all on function public.draw_next_raffle_winner_v2(uuid,uuid,integer,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.draw_next_raffle_winner_v2(uuid,uuid,integer,uuid)
  to authenticated;


