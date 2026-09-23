-- 추첨권 지급 계약 보강
-- 1) 고정 금액만 인정하거나 고정 금액의 배수를 인정하는 모드를 명시한다.
-- 2) 추첨권 지급/추첨 결과 오버레이의 위치와 크기를 각각 보존한다.
-- 3) 저장된 두 오버레이를 한 번씩 순서대로 확인하는 테스트 송출 RPC를 추가한다.

create or replace function byeollog_automation.calculate_raffle_ticket_count_v1(
  p_donation_amount bigint,p_ticket_unit integer,p_allow_multiples boolean)
returns bigint
language sql
immutable
parallel safe
set search_path=''
as $function$
  select case
    when p_donation_amount is null or p_ticket_unit is null or p_allow_multiples is null
      or p_donation_amount <= 0 or p_ticket_unit <= 0 then 0::bigint
    when p_allow_multiples then p_donation_amount / p_ticket_unit
    when p_donation_amount = p_ticket_unit then 1::bigint
    else 0::bigint
  end
$function$;

revoke all on function byeollog_automation.calculate_raffle_ticket_count_v1(bigint,integer,boolean)
  from public,anon,authenticated,service_role;

create or replace function byeollog_automation.capture_raffle_ticket_grant_v1()
returns trigger
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_action byeollog_automation.rule_actions%rowtype;
  v_ticket_unit integer;
  v_allow_multiples boolean;
  v_tickets integer;
  v_calculated_tickets bigint;
  v_amount bigint;
  v_actor_key text := lower(nullif(btrim(coalesce(new.actor->>'id','')), ''));
  v_actor_name text := nullif(btrim(coalesce(new.actor->>'name','')), '');
  v_round byeollog_automation.raffle_rounds%rowtype;
  v_grant_id uuid;
  v_total_tickets integer;
  v_participants integer;
  v_execution_id uuid := extensions.gen_random_uuid();
  v_idempotency_key text;
begin
  if new.event_type <> 'donation' or new.amount is null or new.amount <= 0 then
    return new;
  end if;

  select a.* into v_action
  from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id=a.rule_id
  where a.rule_id=any(coalesce(new.matched_rule_ids,'{}'::uuid[]))
    and a.action_type='log'
    and a.params->>'controlType'='raffle_ticket_grant'
  order by r.priority desc,r.id,a.position,a.id
  limit 1;
  if not found then return new; end if;

  begin
    v_ticket_unit := (v_action.params->>'ticketUnit')::integer;
    v_amount := floor(new.amount)::bigint;
    if v_action.params ? 'allowMultiples' then
      if pg_catalog.jsonb_typeof(v_action.params->'allowMultiples') <> 'boolean' then
        raise exception 'raffle multiple policy is invalid' using errcode='22023';
      end if;
      v_allow_multiples := (v_action.params->>'allowMultiples')::boolean;
    else
      -- v0.7.0.53에서 만든 기존 규칙은 당시 계약(배수 허용)을 그대로 유지한다.
      v_allow_multiples := true;
    end if;
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'raffle ticket action parameters are invalid' using errcode='22023';
  end;
  if v_ticket_unit not between 1 and 1000000
     or v_amount not between 1 and 1000000000000
     or new.amount <> floor(new.amount)
     or v_actor_key is null or char_length(v_actor_key) not between 1 and 180
  then
    return new;
  end if;

  v_calculated_tickets := byeollog_automation.calculate_raffle_ticket_count_v1(
    v_amount,v_ticket_unit,v_allow_multiples);
  if v_calculated_tickets < 1 then return new; end if;
  if v_calculated_tickets > 100000 then
    raise exception 'raffle ticket grant exceeds the safe limit' using errcode='22023';
  end if;
  v_tickets := v_calculated_tickets::integer;

  v_actor_name := coalesce(v_actor_name,v_actor_key);
  if char_length(v_actor_name) > 120 then v_actor_name := left(v_actor_name,120); end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle:'||new.workspace_id::text,5301));

  select r.* into v_round
  from byeollog_automation.raffle_rounds r
  where r.workspace_id=new.workspace_id and r.status='open'
  for update;
  if not found then
    insert into byeollog_automation.raffle_rounds(
      workspace_id,rule_id,action_id,agent_device_id)
    values(
      new.workspace_id,v_action.rule_id,v_action.id,(v_action.params->>'agentDeviceId')::uuid)
    returning * into v_round;
  end if;

  insert into byeollog_automation.raffle_ticket_grants(
    workspace_id,round_id,rule_id,action_id,source_event_key,actor_key,actor_name,
    donation_amount,ticket_unit,tickets_granted)
  values(
    new.workspace_id,v_round.id,v_action.rule_id,v_action.id,new.external_event_id,
    v_actor_key,v_actor_name,v_amount,v_ticket_unit,v_tickets)
  on conflict(workspace_id,source_event_key,rule_id) do nothing
  returning id into v_grant_id;
  if v_grant_id is null then return new; end if;

  insert into byeollog_automation.raffle_entries(
    round_id,workspace_id,actor_key,actor_name,ticket_count)
  values(v_round.id,new.workspace_id,v_actor_key,v_actor_name,v_tickets)
  on conflict(round_id,actor_key) do update
    set actor_name=excluded.actor_name,
        ticket_count=byeollog_automation.raffle_entries.ticket_count+excluded.ticket_count,
        last_granted_at=clock_timestamp();

  select coalesce(sum(e.ticket_count),0)::integer,count(*)::integer
    into v_total_tickets,v_participants
  from byeollog_automation.raffle_entries e where e.round_id=v_round.id;

  v_idempotency_key := encode(extensions.digest(pg_catalog.convert_to(
    'raffle-grant-v2|'||new.workspace_id::text||'|'||new.external_event_id||'|'||v_action.rule_id::text,
    'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(
    v_execution_id,new.workspace_id,new.id,v_action.rule_id,v_action.id,v_idempotency_key,
    'local_agent',v_round.agent_device_id,'raffle.overlay',jsonb_build_object(
      'kind','ticket_granted','overlayImageKey','raffle_ticket_granted','durationMs',5000,
      'overlayPositionX',coalesce((v_action.params->>'ticketOverlayPositionX')::integer,5000),
      'overlayPositionY',coalesce((v_action.params->>'ticketOverlayPositionY')::integer,5000),
      'overlayScalePercent',coalesce((v_action.params->>'ticketOverlayScalePercent')::integer,100),
      'actorName',v_actor_name,'ticketsGranted',v_tickets,'actorTickets',(
        select e.ticket_count from byeollog_automation.raffle_entries e
        where e.round_id=v_round.id and e.actor_key=v_actor_key),
      'totalTickets',v_total_tickets,'participantCount',v_participants),
    15000,3,5);
  return new;
exception when others then
  -- 추첨 부가기능 결함이 원본 후원 이벤트 저장을 막지 않도록 부분 지급만 되돌린다.
  return new;
end;
$function$;

revoke all on function byeollog_automation.capture_raffle_ticket_grant_v1()
  from public,anon,authenticated,service_role;

create or replace function byeollog_automation.save_guided_rule_v10_impl(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_raffle_allow_multiples boolean,
  p_raffle_ticket_position_x integer,p_raffle_ticket_position_y integer,
  p_raffle_ticket_scale_percent integer,p_raffle_draw_position_x integer,
  p_raffle_draw_position_y integer,p_raffle_draw_scale_percent integer,
  p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_rule_id uuid;
  v_rule_version integer;
  v_created_enabled boolean;
  v_amount_operator text;
  v_params jsonb;
begin
  if p_action_type <> 'raffle.ticket_grant' then
    if p_raffle_allow_multiples is not null
       or p_raffle_ticket_position_x is not null or p_raffle_ticket_position_y is not null
       or p_raffle_ticket_scale_percent is not null or p_raffle_draw_position_x is not null
       or p_raffle_draw_position_y is not null or p_raffle_draw_scale_percent is not null
    then
      raise exception 'raffle fields belong to raffle actions only' using errcode='22023';
    end if;
    return query select saved.rule_id,saved.rule_version,saved.created_enabled
    from byeollog_automation.save_guided_rule_v9_impl(
      p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
      p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
      p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
      p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
      p_raffle_ticket_unit,p_replace_rule_id,p_expected_version) saved;
    return;
  end if;

  if p_raffle_allow_multiples is null
     or p_raffle_ticket_position_x not between 0 and 10000
     or p_raffle_ticket_position_y not between 0 and 10000
     or p_raffle_ticket_scale_percent not between 25 and 200
     or p_raffle_draw_position_x not between 0 and 10000
     or p_raffle_draw_position_y not between 0 and 10000
     or p_raffle_draw_scale_percent not between 25 and 200
  then
    raise exception 'raffle display parameters are invalid' using errcode='22023';
  end if;

  select saved.rule_id,saved.rule_version,saved.created_enabled
    into strict v_rule_id,v_rule_version,v_created_enabled
  from byeollog_automation.save_guided_rule_v9_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_replace_rule_id,p_expected_version) saved;

  v_amount_operator := case when p_raffle_allow_multiples then 'gte' else 'eq' end;
  update public.rule_conditions
     set operator=v_amount_operator
   where rule_id=v_rule_id and path='amount';
  update byeollog_automation.rule_conditions
     set operator=v_amount_operator
   where rule_id=v_rule_id and path='amount';

  v_params := jsonb_build_object(
    'label','추첨권 지급','controlType','raffle_ticket_grant',
    'ticketUnit',p_raffle_ticket_unit,'allowMultiples',p_raffle_allow_multiples,
    'agentDeviceId',p_agent_device_id,'overlayImageKey','raffle_ticket_granted',
    'durationMs',5000,
    'ticketOverlayPositionX',p_raffle_ticket_position_x,
    'ticketOverlayPositionY',p_raffle_ticket_position_y,
    'ticketOverlayScalePercent',p_raffle_ticket_scale_percent,
    'drawOverlayPositionX',p_raffle_draw_position_x,
    'drawOverlayPositionY',p_raffle_draw_position_y,
    'drawOverlayScalePercent',p_raffle_draw_scale_percent);
  update public.rule_actions set params=v_params where rule_id=v_rule_id and position=0;
  update byeollog_automation.rule_actions set params=v_params where rule_id=v_rule_id and position=0;
  return query select v_rule_id,v_rule_version,v_created_enabled;
end;
$function$;

create or replace function public.save_guided_rule_v10(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_raffle_allow_multiples boolean,
  p_raffle_ticket_position_x integer,p_raffle_ticket_position_y integer,
  p_raffle_ticket_scale_percent integer,p_raffle_draw_position_x integer,
  p_raffle_draw_position_y integer,p_raffle_draw_scale_percent integer,
  p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql
security definer
set search_path=''
as $function$
  select * from byeollog_automation.save_guided_rule_v10_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_raffle_allow_multiples,p_raffle_ticket_position_x,
    p_raffle_ticket_position_y,p_raffle_ticket_scale_percent,p_raffle_draw_position_x,
    p_raffle_draw_position_y,p_raffle_draw_scale_percent,p_replace_rule_id,p_expected_version)
$function$;

revoke all on function byeollog_automation.save_guided_rule_v10_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,uuid,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.save_guided_rule_v10(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.save_guided_rule_v10(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,uuid,integer)
  to authenticated;

create or replace function public.draw_raffle_v1(
  p_workspace_id uuid,p_winner_count integer,p_allow_duplicate_winners boolean)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='15s'
as $function$
declare
  v_uid uuid;
  v_round byeollog_automation.raffle_rounds%rowtype;
  v_action_params jsonb;
  v_draw_id uuid:=extensions.gen_random_uuid();
  v_event_id uuid:=extensions.gen_random_uuid();
  v_execution_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_seed text:=encode(extensions.gen_random_bytes(32),'hex');
  v_total integer;
  v_participants integer;
  v_ordinal integer;
  v_index integer;
  v_actor_key text;
  v_actor_name text;
  v_actor_tickets integer;
  v_winners jsonb;
  v_plan_token text;
  v_idempotency_key text;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_winner_count not between 1 and 100 or p_allow_duplicate_winners is null then
    raise exception 'raffle draw parameters are invalid' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle:'||p_workspace_id::text,5301));
  select * into v_round from byeollog_automation.raffle_rounds
  where workspace_id=p_workspace_id and status='open' for update;
  if not found then raise exception 'open raffle round was not found' using errcode='P0002'; end if;
  select params into strict v_action_params
  from byeollog_automation.rule_actions where id=v_round.action_id and rule_id=v_round.rule_id;
  select coalesce(sum(ticket_count),0)::integer,count(*)::integer into v_total,v_participants
  from byeollog_automation.raffle_entries where round_id=v_round.id;
  if v_total<1 or (p_allow_duplicate_winners and p_winner_count>v_total)
     or (not p_allow_duplicate_winners and p_winner_count>v_participants) then
    raise exception 'winner count exceeds the available raffle pool' using errcode='22023';
  end if;
  if not exists(
    select 1 from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=v_round.agent_device_id and d.revoked_at is null
      and s.reported_at>v_now-interval '2 minutes' and 'raffle.overlay'=any(s.supported_action_types))
  then raise exception 'raffle action agent device is not currently online' using errcode='PT409'; end if;

  insert into byeollog_automation.raffle_draws(id,workspace_id,round_id,requested_by,winner_count,allow_duplicate_winners,random_seed)
  values(v_draw_id,p_workspace_id,v_round.id,v_uid,p_winner_count,p_allow_duplicate_winners,v_seed);
  insert into byeollog_automation.raffle_draw_candidates(draw_id,actor_key,actor_name,original_ticket_count,remaining_ticket_count)
  select v_draw_id,actor_key,actor_name,ticket_count,ticket_count
  from byeollog_automation.raffle_entries where round_id=v_round.id;

  for v_index in 1..p_winner_count loop
    select coalesce(sum(remaining_ticket_count),0)::integer into v_total
    from byeollog_automation.raffle_draw_candidates where draw_id=v_draw_id;
    if v_total<1 then raise exception 'raffle candidate pool was exhausted' using errcode='22023'; end if;
    v_ordinal:=((('x'||substr(encode(extensions.digest(pg_catalog.convert_to(v_seed||'|'||v_index::text,'UTF8'),'sha256'),'hex'),1,15))::bit(60)::bigint % v_total)+1)::integer;
    select actor_key,actor_name,original_ticket_count into strict v_actor_key,v_actor_name,v_actor_tickets
    from (
      select c.*,sum(c.remaining_ticket_count) over(order by c.actor_key rows unbounded preceding) running_total
      from byeollog_automation.raffle_draw_candidates c
      where c.draw_id=v_draw_id and c.remaining_ticket_count>0
    ) pool where pool.running_total>=v_ordinal order by pool.actor_key limit 1;
    insert into byeollog_automation.raffle_winners(draw_id,draw_index,actor_key,actor_name,ticket_count_at_draw,selected_ticket_ordinal)
    values(v_draw_id,v_index,v_actor_key,v_actor_name,v_actor_tickets,v_ordinal);
    update byeollog_automation.raffle_draw_candidates
      set remaining_ticket_count=case when p_allow_duplicate_winners then remaining_ticket_count-1 else 0 end
      where draw_id=v_draw_id and actor_key=v_actor_key;
  end loop;

  update byeollog_automation.raffle_rounds set status='drawn',drawn_at=v_now,
    winner_count=p_winner_count,allow_duplicate_winners=p_allow_duplicate_winners,
    requested_by=v_uid,draw_seed=v_seed,total_tickets_snapshot=(select sum(ticket_count)::integer from byeollog_automation.raffle_entries where round_id=v_round.id),
    participant_count_snapshot=(select count(*)::integer from byeollog_automation.raffle_entries where round_id=v_round.id)
  where id=v_round.id;
  select jsonb_agg(jsonb_build_object('drawIndex',draw_index,'actorName',actor_name) order by draw_index)
    into v_winners from byeollog_automation.raffle_winners where draw_id=v_draw_id;
  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to('raffle-draw-v2|'||p_workspace_id::text||'|'||v_draw_id::text,'UTF8'),'sha256'),'hex');
  v_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to('raffle-draw-execution-v2|'||p_workspace_id::text||'|'||v_draw_id::text,'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.events(id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(v_event_id,p_workspace_id,'1.0','raffle-draw-'||v_draw_id::text,'manual','byeollog','raffle_draw','winner_selection',jsonb_build_object('id',v_uid,'name','별록 스트리머'),null,null,jsonb_build_object('drawId',v_draw_id,'winnerCount',p_winner_count,'winners',v_winners),null,'raffle-draw:'||v_draw_id::text,v_now,v_now,v_uid,v_plan_token,array[v_round.rule_id],array[v_round.rule_id]);
  insert into byeollog_automation.executions(id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_execution_id,p_workspace_id,v_event_id,v_round.rule_id,v_round.action_id,v_idempotency_key,'local_agent',v_round.agent_device_id,'raffle.overlay',jsonb_build_object(
    'kind','draw_result','overlayImageKey','raffle_draw','durationMs',4000,
    'overlayPositionX',coalesce((v_action_params->>'drawOverlayPositionX')::integer,5000),
    'overlayPositionY',coalesce((v_action_params->>'drawOverlayPositionY')::integer,5000),
    'overlayScalePercent',coalesce((v_action_params->>'drawOverlayScalePercent')::integer,100),
    'winnerCount',p_winner_count,'winners',v_winners),120000,3,5);
  return jsonb_build_object('drawId',v_draw_id,'roundId',v_round.id,'executionId',v_execution_id,'winners',v_winners);
end;
$function$;

revoke all on function public.draw_raffle_v1(uuid,integer,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.draw_raffle_v1(uuid,integer,boolean) to authenticated;

create or replace function byeollog_automation.dispatch_guided_rule_test_v2_impl(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid)
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_requester_id uuid;
  v_action byeollog_automation.rule_actions%rowtype;
  v_device_id uuid;
  v_event_id uuid:=extensions.gen_random_uuid();
  v_execution_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_plan_token text;
  v_idempotency_key text;
  v_ticket_x integer; v_ticket_y integer; v_ticket_scale integer;
  v_draw_x integer; v_draw_y integer; v_draw_scale integer;
begin
  v_requester_id:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_rule_id is null or p_expected_version is null or p_expected_version<1 then
    raise exception 'action test identity is invalid' using errcode='22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog-action-test:'||p_workspace_id::text||':'||p_rule_id::text,3320));
  if not exists(
    select 1 from public.rules r where r.id=p_rule_id and r.workspace_id=p_workspace_id
      and r.superseded_at is null and r.version_number=p_expected_version)
  then
    if exists(select 1 from public.rules r where r.id=p_rule_id and r.workspace_id=p_workspace_id) then
      raise exception 'action test rule version changed' using errcode='40001';
    end if;
    raise exception 'action test rule was not found' using errcode='P0002';
  end if;
  select a.* into strict v_action
  from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id=a.rule_id
  where r.workspace_id=p_workspace_id and r.id=p_rule_id and a.position=0;

  if v_action.execution_target='local_agent'
     and v_action.action_type in ('obs.mute_for','windows.mic_mute_for')
  then
    return query select * from byeollog_automation.dispatch_guided_rule_test_v1_impl(
      p_workspace_id,p_rule_id,p_expected_version);
    return;
  end if;
  if v_action.action_type<>'log' or v_action.params->>'controlType'<>'raffle_ticket_grant' then
    raise exception 'this action does not support broadcast testing' using errcode='22023';
  end if;
  begin
    v_device_id:=(v_action.params->>'agentDeviceId')::uuid;
    v_ticket_x:=coalesce((v_action.params->>'ticketOverlayPositionX')::integer,5000);
    v_ticket_y:=coalesce((v_action.params->>'ticketOverlayPositionY')::integer,5000);
    v_ticket_scale:=coalesce((v_action.params->>'ticketOverlayScalePercent')::integer,100);
    v_draw_x:=coalesce((v_action.params->>'drawOverlayPositionX')::integer,5000);
    v_draw_y:=coalesce((v_action.params->>'drawOverlayPositionY')::integer,5000);
    v_draw_scale:=coalesce((v_action.params->>'drawOverlayScalePercent')::integer,100);
  exception when invalid_text_representation or numeric_value_out_of_range then
    raise exception 'raffle action test parameters are invalid' using errcode='22023';
  end;
  if v_device_id is null or v_ticket_x not between 0 and 10000 or v_ticket_y not between 0 and 10000
     or v_ticket_scale not between 25 and 200 or v_draw_x not between 0 and 10000
     or v_draw_y not between 0 and 10000 or v_draw_scale not between 25 and 200
  then raise exception 'raffle action test parameters are invalid' using errcode='22023'; end if;
  if not exists(
    select 1 from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=v_device_id and d.revoked_at is null
      and s.reported_at>v_now-interval '2 minutes' and 'raffle.overlay'=any(s.supported_action_types))
  then raise exception 'the action agent device is not currently online' using errcode='PT409'; end if;
  if exists(
    select 1 from byeollog_automation.executions x
    join byeollog_automation.events e on e.id=x.event_id
    where x.workspace_id=p_workspace_id and x.rule_id=p_rule_id and e.source='manual_test'
      and x.status in ('queued','running','retry_scheduled')
      and x.created_at>=v_now-interval '30 seconds')
  then raise exception 'an action test is already pending' using errcode='55000'; end if;

  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-action-test-v2|'||p_workspace_id::text||'|'||p_rule_id::text||'|'||v_event_id::text,'UTF8'),'sha256'),'hex');
  v_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to(
    'raffle-action-test-execution-v2|'||p_workspace_id::text||'|'||v_execution_id::text,'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.events(
    id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
    actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,
    authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(v_event_id,p_workspace_id,'1.0','raffle-action-test-'||v_event_id::text,
    'manual_test','byeollog','action_test','raffle.overlay',
    jsonb_build_object('display_name','별록 추첨 테스트'),null,null,
    jsonb_build_object('test',true,'rule_id',p_rule_id,'requested_at',v_now),null,
    'raffle-action-test:'||v_event_id::text,v_now,v_now,v_requester_id,v_plan_token,
    array[p_rule_id],array[p_rule_id]);
  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_execution_id,p_workspace_id,v_event_id,p_rule_id,v_action.id,v_idempotency_key,
    'local_agent',v_device_id,'raffle.overlay',jsonb_build_object(
      'kind','test_sequence','ticketOverlayImageKey','raffle_ticket_granted',
      'ticketDurationMs',4000,'ticketOverlayPositionX',v_ticket_x,
      'ticketOverlayPositionY',v_ticket_y,'ticketOverlayScalePercent',v_ticket_scale,
      'drawOverlayImageKey','raffle_draw','drawDurationMs',4000,
      'drawOverlayPositionX',v_draw_x,'drawOverlayPositionY',v_draw_y,
      'drawOverlayScalePercent',v_draw_scale),30000,1,5);
  return query select v_event_id,v_execution_id,'raffle.overlay'::text,v_device_id;
exception when no_data_found or too_many_rows then
  raise exception 'action test rule snapshot is invalid' using errcode='P0002';
end;
$function$;

create or replace function public.dispatch_guided_rule_test_v2(
  p_workspace_id uuid,p_rule_id uuid,p_expected_version integer)
returns table(event_id uuid,execution_id uuid,action_type text,agent_device_id uuid)
language sql
security definer
set search_path=''
as $function$
  select * from byeollog_automation.dispatch_guided_rule_test_v2_impl(
    p_workspace_id,p_rule_id,p_expected_version)
$function$;

revoke all on function byeollog_automation.dispatch_guided_rule_test_v2_impl(uuid,uuid,integer)
  from public,anon,authenticated,service_role;
revoke all on function public.dispatch_guided_rule_test_v2(uuid,uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.dispatch_guided_rule_test_v2(uuid,uuid,integer) to authenticated;


