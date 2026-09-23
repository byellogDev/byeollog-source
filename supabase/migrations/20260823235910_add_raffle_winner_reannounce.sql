-- 이미 확정된 당첨 결과의 송출만 안전하게 다시 요청한다.
-- 당첨자/후보/회차/추첨권 원장은 변경하지 않으며, 호출자가 기대하는
-- 재송출 순번으로 네트워크 재시도와 의도적인 다음 재송출을 구분한다.

create or replace function public.reannounce_raffle_winner_v1(
  p_workspace_id uuid,
  p_draw_id uuid,
  p_draw_index integer,
  p_expected_reannounce_number integer)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_uid uuid;
  v_now timestamptz:=clock_timestamp();
  v_round_id uuid;
  v_rule_id uuid;
  v_action_id uuid;
  v_agent_device_id uuid;
  v_winner_target integer;
  v_actor_name text;
  v_original_execution byeollog_automation.executions%rowtype;
  v_existing_execution byeollog_automation.executions%rowtype;
  v_original_idempotency_key text;
  v_reannounce_idempotency_key text;
  v_previous_reannounce_number integer;
  v_event_id uuid:=extensions.gen_random_uuid();
  v_execution_id uuid:=extensions.gen_random_uuid();
  v_plan_token text;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_draw_id is null
     or p_draw_index is null
     or p_draw_index not between 1 and 100
     or p_expected_reannounce_number is null
     or p_expected_reannounce_number not between 1 and 10
  then
    raise exception 'raffle winner reannounce parameters are invalid' using errcode='22023';
  end if;

  -- draw_next_raffle_winner_v1과 같은 workspace lock을 사용한다. 당첨 확정과
  -- 재송출 번호 발급이 서로 앞질러 실행되지 않으며, 같은 번호의 동시 호출도
  -- 아래 idempotent 반환 경로로 하나의 execution만 공유한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle:'||p_workspace_id::text,5301));

  select r.id,r.rule_id,r.action_id,r.agent_device_id,d.winner_count,w.actor_name
    into strict v_round_id,v_rule_id,v_action_id,v_agent_device_id,
      v_winner_target,v_actor_name
  from byeollog_automation.raffle_draws d
  join byeollog_automation.raffle_rounds r
    on r.id=d.round_id and r.workspace_id=d.workspace_id
  join byeollog_automation.raffle_winners w
    on w.draw_id=d.id
  where d.workspace_id=p_workspace_id
    and d.id=p_draw_id
    and w.draw_index=p_draw_index;

  -- 원본 한 장 추첨 execution을 결정론적 키로만 찾는다. 이전 재송출
  -- execution이 같은 drawId/drawIndex를 가지고 있어도 원본으로 오인하지 않는다.
  v_original_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-draw-step-execution-v1|'||p_workspace_id::text||'|'||
      p_draw_id::text||'|'||p_draw_index::text,
    'UTF8'),'sha256'),'hex');
  select execution_row.* into strict v_original_execution
  from byeollog_automation.executions execution_row
  where execution_row.workspace_id=p_workspace_id
    and execution_row.idempotency_key=v_original_idempotency_key
    and execution_row.rule_id=v_rule_id
    and execution_row.action_id=v_action_id
    and execution_row.execution_target='local_agent'
    and execution_row.agent_device_id=v_agent_device_id
    and execution_row.action_type='raffle.overlay'
    and execution_row.action_params->>'kind'='draw_result'
    and execution_row.action_params->>'drawIndex'=p_draw_index::text
    and exists(
      select 1
      from byeollog_automation.events event_row
      where event_row.id=execution_row.event_id
        and event_row.workspace_id=p_workspace_id
        and event_row.event_type='raffle_draw'
        and event_row.subtype='winner_selection'
        and event_row.payload->>'drawId'=p_draw_id::text
        and event_row.payload->>'drawIndex'=p_draw_index::text
    );

  v_reannounce_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-winner-reannounce-v1|'||p_workspace_id::text||'|'||
      p_draw_id::text||'|'||p_draw_index::text||'|'||
      p_expected_reannounce_number::text,
    'UTF8'),'sha256'),'hex');

  -- 응답 유실 뒤 같은 expected number로 재호출하면 새 송출을 만들지 않는다.
  select execution_row.* into v_existing_execution
  from byeollog_automation.executions execution_row
  where execution_row.workspace_id=p_workspace_id
    and execution_row.idempotency_key=v_reannounce_idempotency_key;
  if found then
    return jsonb_build_object(
      'drawId',p_draw_id,
      'roundId',v_round_id,
      'drawIndex',p_draw_index,
      'reannounceNumber',p_expected_reannounce_number,
      'executionId',v_existing_execution.id,
      'agentDeviceId',v_existing_execution.agent_device_id,
      'originalExecutionId',v_original_execution.id,
      'winner',jsonb_build_object('drawIndex',p_draw_index,'actorName',v_actor_name),
      'created',false);
  end if;

  select coalesce(max(case
      when coalesce(event_row.payload->>'reannounceNumber','') ~ '^(?:[1-9]|10)$'
        then (event_row.payload->>'reannounceNumber')::integer
      else null
    end),0)
    into v_previous_reannounce_number
  from byeollog_automation.events event_row
  where event_row.workspace_id=p_workspace_id
    and event_row.source='manual'
    and event_row.event_type='raffle_draw'
    and event_row.subtype='winner_reannounce'
    and event_row.payload->>'drawId'=p_draw_id::text
    and event_row.payload->>'drawIndex'=p_draw_index::text;
  if v_previous_reannounce_number>=10 then
    raise exception 'raffle winner reannounce limit was reached' using errcode='PT409';
  end if;
  if p_expected_reannounce_number<>v_previous_reannounce_number+1 then
    raise exception 'raffle winner reannounce state changed' using errcode='40001';
  end if;

  if not exists(
    select 1
    from byeollog_automation.agent_devices device_row
    join byeollog_automation.agent_device_status status_row
      on status_row.workspace_id=device_row.workspace_id
     and status_row.device_id=device_row.device_id
    where device_row.workspace_id=p_workspace_id
      and device_row.device_id=v_agent_device_id
      and device_row.revoked_at is null
      and status_row.reported_at>v_now-interval '2 minutes'
      and 'raffle.overlay'=any(status_row.supported_action_types))
  then
    raise exception 'raffle action agent device is not currently online' using errcode='PT409';
  end if;

  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-winner-reannounce-plan-v1|'||p_workspace_id::text||'|'||
      p_draw_id::text||'|'||p_draw_index::text||'|'||
      p_expected_reannounce_number::text,
    'UTF8'),'sha256'),'hex');

  insert into byeollog_automation.events(
    id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
    actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,
    authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(
    v_event_id,p_workspace_id,'1.0',
    'raffle-reannounce-'||p_draw_id::text||'-'||p_draw_index::text||'-'||
      p_expected_reannounce_number::text,
    'manual','byeollog','raffle_draw','winner_reannounce',
    jsonb_build_object('id',v_uid,'name','별록 스트리머'),null,null,
    jsonb_build_object(
      'drawId',p_draw_id,
      'drawIndex',p_draw_index,
      'reannounceNumber',p_expected_reannounce_number,
      'originalExecutionId',v_original_execution.id,
      'winner',jsonb_build_object('drawIndex',p_draw_index,'actorName',v_actor_name)),
    null,'raffle-reannounce:'||p_draw_id::text||':'||p_draw_index::text,
    v_now,v_now,v_uid,v_plan_token,array[v_rule_id],array[v_rule_id]);

  -- 원본 action_params를 그대로 복사한다. 기존 BEFORE INSERT trigger가 새
  -- event occurred_at 기준 notAfterUtc만 갱신하여 만료된 전달을 되살린다.
  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(
    v_execution_id,p_workspace_id,v_event_id,
    v_original_execution.rule_id,v_original_execution.action_id,
    v_reannounce_idempotency_key,v_original_execution.execution_target,
    v_original_execution.agent_device_id,v_original_execution.action_type,
    v_original_execution.action_params,v_original_execution.timeout_ms,
    v_original_execution.max_attempts,v_original_execution.retry_backoff_seconds);

  return jsonb_build_object(
    'drawId',p_draw_id,
    'roundId',v_round_id,
    'drawIndex',p_draw_index,
    'reannounceNumber',p_expected_reannounce_number,
    'executionId',v_execution_id,
    'agentDeviceId',v_original_execution.agent_device_id,
    'originalExecutionId',v_original_execution.id,
    'winner',jsonb_build_object('drawIndex',p_draw_index,'actorName',v_actor_name),
    'created',true);
end;
$function$;

revoke all on function public.reannounce_raffle_winner_v1(uuid,uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.reannounce_raffle_winner_v1(uuid,uuid,integer,integer)
  to authenticated;

-- 재송출 번호는 화면을 다시 열어도 이어져야 한다. private event 원장을
-- manager 전용 상태 RPC가 bounded count로만 노출하며 원본 payload는 숨긴다.
create index if not exists events_raffle_reannounce_lookup_idx
  on byeollog_automation.events(
    workspace_id,(payload->>'drawId'),(payload->>'drawIndex'))
  where source='manual'
    and event_type='raffle_draw'
    and subtype='winner_reannounce';

create or replace function public.get_raffle_state_v2(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_uid uuid;
  v_round jsonb;
  v_active_draw jsonb;
  v_history jsonb;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);

  select jsonb_build_object(
    'roundId',r.id,'status','open','openedAt',r.opened_at,
    'totalTickets',coalesce((select sum(e.ticket_count) from byeollog_automation.raffle_entries e where e.round_id=r.id),0),
    'participantCount',(select count(*) from byeollog_automation.raffle_entries e where e.round_id=r.id),
    'entries',coalesce((select jsonb_agg(jsonb_build_object(
      'actorName',x.actor_name,'ticketCount',x.ticket_count,'lastGrantedAt',x.last_granted_at)
      order by x.ticket_count desc,x.actor_name)
      from (select e.actor_name,e.ticket_count,e.last_granted_at
            from byeollog_automation.raffle_entries e where e.round_id=r.id
            order by e.ticket_count desc,e.actor_key limit 500) x),'[]'::jsonb))
  into v_round
  from byeollog_automation.raffle_rounds r
  where r.workspace_id=p_workspace_id and r.status='open';

  select jsonb_build_object(
    'roundId',r.id,'drawId',d.id,'status','sealed','sealedAt',d.created_at,
    'agentDeviceId',r.agent_device_id,
    'winnerTarget',d.winner_count,
    'drawnCount',(select count(*) from byeollog_automation.raffle_winners w where w.draw_id=d.id),
    'remainingCount',d.winner_count-(select count(*) from byeollog_automation.raffle_winners w where w.draw_id=d.id),
    'allowDuplicateWinners',d.allow_duplicate_winners,
    'totalTickets',r.total_tickets_snapshot,
    'participantCount',r.participant_count_snapshot,
    'entries',coalesce((select jsonb_agg(jsonb_build_object(
      'actorName',x.actor_name,'ticketCount',x.ticket_count,'lastGrantedAt',x.last_granted_at)
      order by x.ticket_count desc,x.actor_name)
      from (select e.actor_name,e.ticket_count,e.last_granted_at
            from byeollog_automation.raffle_entries e where e.round_id=r.id
            order by e.ticket_count desc,e.actor_key limit 500) x),'[]'::jsonb),
    'winners',coalesce((select jsonb_agg(jsonb_build_object(
      'drawIndex',w.draw_index,
      'actorName',w.actor_name,
      'reannounceCount',(select count(*)
        from byeollog_automation.events event_row
        where event_row.workspace_id=p_workspace_id
          and event_row.source='manual'
          and event_row.event_type='raffle_draw'
          and event_row.subtype='winner_reannounce'
          and event_row.payload->>'drawId'=d.id::text
          and event_row.payload->>'drawIndex'=w.draw_index::text))
      order by w.draw_index)
      from byeollog_automation.raffle_winners w where w.draw_id=d.id),'[]'::jsonb))
  into v_active_draw
  from byeollog_automation.raffle_rounds r
  join byeollog_automation.raffle_draws d on d.round_id=r.id
  where r.workspace_id=p_workspace_id and r.status='sealed';

  select coalesce(jsonb_agg(jsonb_build_object(
    'drawId',d.id,'createdAt',d.created_at,'winnerCount',d.winner_count,
    'allowDuplicateWinners',d.allow_duplicate_winners,
    'winners',coalesce((select jsonb_agg(jsonb_build_object(
      'drawIndex',w.draw_index,
      'actorName',w.actor_name,
      'reannounceCount',(select count(*)
        from byeollog_automation.events event_row
        where event_row.workspace_id=p_workspace_id
          and event_row.source='manual'
          and event_row.event_type='raffle_draw'
          and event_row.subtype='winner_reannounce'
          and event_row.payload->>'drawId'=d.id::text
          and event_row.payload->>'drawIndex'=w.draw_index::text))
      order by w.draw_index)
      from byeollog_automation.raffle_winners w where w.draw_id=d.id),'[]'::jsonb))
    order by d.created_at desc),'[]'::jsonb)
  into v_history
  from (
    select d.*
    from byeollog_automation.raffle_draws d
    join byeollog_automation.raffle_rounds r on r.id=d.round_id
    where d.workspace_id=p_workspace_id and r.status='drawn'
    order by d.created_at desc limit 10
  ) d;

  return jsonb_build_object(
    'round',v_round,
    'activeDraw',v_active_draw,
    'history',coalesce(v_history,'[]'::jsonb),
    'loadedAt',clock_timestamp());
end;
$function$;

revoke all on function public.get_raffle_state_v2(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_raffle_state_v2(uuid) to authenticated;


