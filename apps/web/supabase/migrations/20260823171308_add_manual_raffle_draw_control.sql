-- 별록 추첨 운영 콘솔
-- 접수 중인 추첨함을 먼저 봉인하고, 방송자가 한 번 누를 때마다 당첨 티켓을
-- 정확히 한 장씩 확정한다. 봉인 뒤 받은 추첨권은 다음 open 회차로 분리된다.

alter table byeollog_automation.raffle_rounds
  drop constraint raffle_rounds_status_check,
  drop constraint raffle_rounds_check;

alter table byeollog_automation.raffle_rounds
  add constraint raffle_rounds_status_check
    check (status in ('open','sealed','drawn')),
  add constraint raffle_rounds_check check (
    (status='open'
      and drawn_at is null and winner_count is null
      and allow_duplicate_winners is null and requested_by is null
      and draw_seed is null and total_tickets_snapshot is null
      and participant_count_snapshot is null)
    or
    (status='sealed'
      and drawn_at is null and winner_count is not null
      and allow_duplicate_winners is not null and requested_by is not null
      and draw_seed is not null and total_tickets_snapshot is not null
      and participant_count_snapshot is not null)
    or
    (status='drawn'
      and drawn_at is not null and winner_count is not null
      and allow_duplicate_winners is not null and requested_by is not null
      and draw_seed is not null and total_tickets_snapshot is not null
      and participant_count_snapshot is not null)
  );

create unique index raffle_rounds_one_sealed_per_workspace
  on byeollog_automation.raffle_rounds(workspace_id)
  where status='sealed';

create or replace function byeollog_automation.protect_raffle_rule_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if tg_op='DELETE' then
    if exists(
      select 1 from byeollog_automation.raffle_rounds rr
      where rr.rule_id=old.id and rr.workspace_id=old.workspace_id
        and rr.status in ('open','sealed'))
    then
      raise exception 'an active raffle round must be completed before changing its rule'
        using errcode='PT409';
    end if;
    return old;
  end if;

  if old.enabled and not new.enabled and exists(
    select 1 from byeollog_automation.raffle_rounds rr
    where rr.rule_id=old.id and rr.workspace_id=old.workspace_id
      and rr.status in ('open','sealed'))
  then
    raise exception 'an active raffle round must be completed before changing its rule'
      using errcode='PT409';
  end if;

  if new.enabled and not old.enabled
     and exists(
       select 1 from byeollog_automation.rule_actions a
       where a.rule_id=old.id and a.action_type='log'
         and a.params->>'controlType'='raffle_ticket_grant')
  then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('byeollog-raffle-config:'||old.workspace_id::text,5301));
    if exists(
      select 1 from byeollog_automation.rules r
      join byeollog_automation.rule_actions a on a.rule_id=r.id
      where r.workspace_id=old.workspace_id and r.enabled and r.id<>old.id
        and a.action_type='log' and a.params->>'controlType'='raffle_ticket_grant')
    then
      raise exception 'only one raffle ticket rule can be active at a time'
        using errcode='PT409';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function byeollog_automation.protect_raffle_rule_v1()
  from public,anon,authenticated,service_role;

create or replace function byeollog_automation.protect_active_raffle_draw_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if exists(
    select 1
    from byeollog_automation.raffle_rounds r
    where r.workspace_id=new.workspace_id
      and r.status='sealed'
      and r.id<>new.round_id)
  then
    raise exception 'a sealed raffle draw must be completed first' using errcode='PT409';
  end if;
  return new;
end;
$function$;

revoke all on function byeollog_automation.protect_active_raffle_draw_v1()
  from public,anon,authenticated,service_role;

drop trigger if exists protect_active_raffle_draw_v1
  on byeollog_automation.raffle_draws;
create trigger protect_active_raffle_draw_v1
before insert on byeollog_automation.raffle_draws
for each row execute function byeollog_automation.protect_active_raffle_draw_v1();

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
      'drawIndex',w.draw_index,'actorName',w.actor_name) order by w.draw_index)
      from byeollog_automation.raffle_winners w where w.draw_id=d.id),'[]'::jsonb))
  into v_active_draw
  from byeollog_automation.raffle_rounds r
  join byeollog_automation.raffle_draws d on d.round_id=r.id
  where r.workspace_id=p_workspace_id and r.status='sealed';

  select coalesce(jsonb_agg(jsonb_build_object(
    'drawId',d.id,'createdAt',d.created_at,'winnerCount',d.winner_count,
    'allowDuplicateWinners',d.allow_duplicate_winners,
    'winners',coalesce((select jsonb_agg(jsonb_build_object(
      'drawIndex',w.draw_index,'actorName',w.actor_name) order by w.draw_index)
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

create or replace function public.start_raffle_draw_v1(
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
  v_draw_id uuid:=extensions.gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_seed text:=encode(extensions.gen_random_bytes(32),'hex');
  v_total integer;
  v_participants integer;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  if p_winner_count not between 1 and 100 or p_allow_duplicate_winners is null then
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
  where workspace_id=p_workspace_id and status='open'
  for update;
  if not found then
    raise exception 'open raffle round was not found' using errcode='P0002';
  end if;

  select coalesce(sum(ticket_count),0)::integer,count(*)::integer
    into v_total,v_participants
  from byeollog_automation.raffle_entries where round_id=v_round.id;
  if v_total<1
     or (p_allow_duplicate_winners and p_winner_count>v_total)
     or (not p_allow_duplicate_winners and p_winner_count>v_participants)
  then
    raise exception 'winner count exceeds the available raffle pool' using errcode='22023';
  end if;

  if not exists(
    select 1
    from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s
      on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=v_round.agent_device_id
      and d.revoked_at is null and s.reported_at>v_now-interval '2 minutes'
      and 'raffle.overlay'=any(s.supported_action_types))
  then
    raise exception 'raffle action agent device is not currently online' using errcode='PT409';
  end if;

  update byeollog_automation.raffle_rounds
  set status='sealed',winner_count=p_winner_count,
      allow_duplicate_winners=p_allow_duplicate_winners,requested_by=v_uid,
      draw_seed=v_seed,total_tickets_snapshot=v_total,
      participant_count_snapshot=v_participants
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

revoke all on function public.start_raffle_draw_v1(uuid,integer,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.start_raffle_draw_v1(uuid,integer,boolean)
  to authenticated;

create or replace function public.draw_next_raffle_winner_v1(
  p_workspace_id uuid,p_expected_draw_index integer)
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
  if p_expected_draw_index not between 1 and 100 then
    raise exception 'raffle draw index is invalid' using errcode='22023';
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

  select * into strict v_draw
  from byeollog_automation.raffle_draws
  where round_id=v_round.id
  for update;
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
    from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s
      on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=v_round.agent_device_id
      and d.revoked_at is null and s.reported_at>v_now-interval '2 minutes'
      and 'raffle.overlay'=any(s.supported_action_types))
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
    select c.*,
      sum(c.remaining_ticket_count) over(order by c.actor_key rows unbounded preceding) running_total
    from byeollog_automation.raffle_draw_candidates c
    where c.draw_id=v_draw.id and c.remaining_ticket_count>0
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
    'drawId',v_draw.id,'roundId',v_round.id,'executionId',v_execution_id,
    'winner',v_winner,'drawnCount',v_index,
    'remainingCount',v_draw.winner_count-v_index,'completed',v_completed);
end;
$function$;

revoke all on function public.draw_next_raffle_winner_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.draw_next_raffle_winner_v1(uuid,integer)
  to authenticated;
