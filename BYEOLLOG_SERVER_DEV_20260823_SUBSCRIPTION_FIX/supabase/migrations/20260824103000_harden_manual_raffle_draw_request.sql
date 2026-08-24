-- 오래 열린 확인창이 다른 open round를 봉인하지 못하도록 round ID를
-- 낙관적 동시성 토큰으로 고정한다.
create or replace function public.start_raffle_draw_v2(
  p_workspace_id uuid,
  p_expected_round_id uuid,
  p_winner_count integer,
  p_allow_duplicate_winners boolean)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $function$
declare
  v_uid uuid;
  v_round byeollog_automation.raffle_rounds%rowtype;
  v_draw_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_seed text:=encode(extensions.gen_random_bytes(32),'hex');
  v_total bigint;
  v_participants bigint;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_expected_round_id is null
     or p_winner_count is null
     or p_winner_count not between 1 and 100
     or p_allow_duplicate_winners is null
  then
    raise exception 'raffle draw parameters are invalid' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle:'||p_workspace_id::text,5301));
  if exists(
    select 1 from byeollog_automation.raffle_rounds
    where workspace_id=p_workspace_id and status='sealed')
  then
    raise exception 'a sealed raffle draw is already active' using errcode='PT409';
  end if;

  select * into v_round
  from byeollog_automation.raffle_rounds
  where workspace_id=p_workspace_id
    and id=p_expected_round_id
    and status='open'
  for update;
  if not found then
    raise exception 'raffle draw state changed' using errcode='40001';
  end if;

  select coalesce(sum(ticket_count),0)::bigint,count(*)::bigint
    into v_total,v_participants
  from byeollog_automation.raffle_entries where round_id=v_round.id;
  if v_total not between 1 and 1000000
     or v_participants not between 1 and 100000
  then
    raise exception 'raffle pool exceeds the safe limit' using errcode='22023';
  end if;
  if (p_allow_duplicate_winners and p_winner_count>v_total)
     or (not p_allow_duplicate_winners and p_winner_count>v_participants)
  then
    raise exception 'winner count exceeds the available raffle pool' using errcode='22023';
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

  update byeollog_automation.raffle_rounds
  set status='sealed',winner_count=p_winner_count,
      allow_duplicate_winners=p_allow_duplicate_winners,requested_by=v_uid,
      draw_seed=v_seed,total_tickets_snapshot=v_total::integer,
      participant_count_snapshot=v_participants::integer,sealed_at=v_now
  where id=v_round.id;

  insert into byeollog_automation.raffle_draws(
    id,workspace_id,round_id,requested_by,winner_count,
    allow_duplicate_winners,random_seed)
  values(
    v_draw_id,p_workspace_id,v_round.id,v_uid,p_winner_count,
    p_allow_duplicate_winners,v_seed);

  insert into byeollog_automation.raffle_draw_candidates(
    draw_id,actor_key,actor_name,original_ticket_count,remaining_ticket_count)
  select v_draw_id,actor_key,actor_name,ticket_count,ticket_count
  from byeollog_automation.raffle_entries where round_id=v_round.id;

  return jsonb_build_object(
    'drawId',v_draw_id,'roundId',v_round.id,'winnerTarget',p_winner_count,
    'drawnCount',0,'remainingCount',p_winner_count,'sealed',true);
end;
$function$;

revoke all on function public.start_raffle_draw_v2(uuid,uuid,integer,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.start_raffle_draw_v2(uuid,uuid,integer,boolean)
  to authenticated;
revoke execute on function public.start_raffle_draw_v1(uuid,integer,boolean)
  from authenticated;

-- 같은 방식으로 다음 당첨도 draw와 송출 PC를 모두 고정한다.
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

  v_ordinal:=((('x'||substr(encode(extensions.digest(
    pg_catalog.convert_to(v_draw.random_seed||'|'||v_index::text,'UTF8'),
    'sha256'),'hex'),1,15))::bit(60)::bigint % v_total)+1)::integer;
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

-- 인증된 클라이언트는 회차를 고정하지 않는 구형 호출을 더는 사용할 수 없다.
revoke execute on function public.draw_next_raffle_winner_v1(uuid,integer)
  from authenticated;

-- 배포 직전 이미 대기 중이던 실시간 로컬 작업에도 같은 만료 계약을 부여한다.
-- 성공/실패 작업은 수정하지 않는다. 배포 순간 이미 실행 lease를 잡은 작업도
-- 이후 retry_scheduled로 회수될 수 있으므로 running까지 deadline을 보강한다.
update byeollog_automation.executions execution_row
set action_params=execution_row.action_params||jsonb_build_object(
  'notAfterUtc',least(event_row.occurred_at,clock_timestamp())+interval '2 minutes')
from byeollog_automation.events event_row
where event_row.id=execution_row.event_id
  and event_row.workspace_id=execution_row.workspace_id
  and execution_row.execution_target='local_agent'
  and execution_row.status in ('queued','running','retry_scheduled')
  and execution_row.action_type in (
    'obs.mute_for','windows.mic_mute_for','obs.scene_switch','agent.notify','raffle.overlay')
  and not execution_row.action_params?'notAfterUtc';
