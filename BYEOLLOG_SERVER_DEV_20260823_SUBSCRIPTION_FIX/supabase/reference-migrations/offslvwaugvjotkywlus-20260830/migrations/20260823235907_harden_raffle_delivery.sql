-- 추첨 실방송 전달 보강
-- 1) 추첨권 원장 처리 실패를 무음으로 삼키지 않고 이벤트 전체를 재시도한다.
-- 2) 2분을 넘긴 수집 행은 실시간 방송 액션을 재생하지 않되 추첨권 원장에는 반영한다.
-- 3) 한 장씩 봉인 추첨을 우회하는 구형 일괄 추첨 RPC의 공개 실행 권한을 제거한다.

alter table byeollog_automation.raffle_ticket_grants
  add column if not exists source_upstream_key text;

-- 기존 원장은 대응 event의 원본 UID를 우선 복원한다. event를 찾을 수 없는
-- 오래된 행도 기존 외부 event id를 namespaced key로 보존해 유실하지 않는다.
update byeollog_automation.raffle_ticket_grants grant_row
set source_upstream_key=coalesce((
  select case
    when event_row.source='weflab'
         and nullif(btrim(coalesce(event_row.payload->>'sourceUid','')),'') is not null
      then 'weflab:'||btrim(event_row.payload->>'sourceUid')
    else lower(event_row.source)||':'||event_row.external_event_id
  end
  from byeollog_automation.events event_row
  where event_row.workspace_id=grant_row.workspace_id
    and event_row.external_event_id=grant_row.source_event_key
  order by case when event_row.source='weflab' then 0 else 1 end,event_row.source
  limit 1
),'legacy:'||grant_row.source_event_key)
where source_upstream_key is null;

-- 배포 직전까지 구형 session 기반 event id로 같은 원본이 두 번 적립됐을
-- 가능성도 안전하게 수용한다. 기존 원장/티켓을 삭제하거나 합치지 않고 최초
-- 기록만 canonical key로 유지하며, 나머지는 감사 가능한 고유 legacy key로
-- 보존한다. 이후 같은 canonical 원본은 최초 기록과 충돌해 재지급되지 않는다.
with ranked as (
  select id,
         row_number() over(
           partition by workspace_id,source_upstream_key
           order by created_at,id) as duplicate_rank
  from byeollog_automation.raffle_ticket_grants
)
update byeollog_automation.raffle_ticket_grants grant_row
set source_upstream_key='legacy-duplicate:'||grant_row.id::text
from ranked
where ranked.id=grant_row.id and ranked.duplicate_rank>1;

alter table byeollog_automation.raffle_ticket_grants
  alter column source_upstream_key set not null;

alter table byeollog_automation.raffle_ticket_grants
  add constraint raffle_ticket_grants_source_upstream_key_check
  check (char_length(source_upstream_key) between 1 and 300);

-- 한 workspace에는 추첨권 규칙 하나만 활성화될 수 있다. 규칙을 수정해 새
-- version이 생기거나 Collector session이 바뀌어도 같은 원본 후원은 한 번만 지급한다.
create unique index raffle_ticket_grants_workspace_upstream_uidx
  on byeollog_automation.raffle_ticket_grants(workspace_id,source_upstream_key);

-- 정상 시각에 큐에 들어갔더라도 Agent가 오랫동안 오프라인이면 뒤늦게
-- 마이크/OBS/TTS가 실행될 수 있다. 모든 방송 부작용에 서버 기준 만료시각을
-- 붙이고, Agent가 실행 직전에 다시 확인하도록 한다.
create or replace function byeollog_automation.stamp_live_action_deadline_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare
  v_occurred_at timestamptz;
begin
  if new.execution_target<>'local_agent'
     or new.action_type<>all(array[
       'obs.mute_for','windows.mic_mute_for','obs.scene_switch','agent.notify','raffle.overlay'
     ]::text[])
  then
    return new;
  end if;

  select event_row.occurred_at into v_occurred_at
  from byeollog_automation.events event_row
  where event_row.id=new.event_id and event_row.workspace_id=new.workspace_id;
  if not found then
    raise exception 'live action event was not found' using errcode='23503';
  end if;

  new.action_params=coalesce(new.action_params,'{}'::jsonb)
    -- PC 시계가 미래로 틀어져 있어도 실행 가능 시간이 무기한 늘어나지 않는다.
    || jsonb_build_object(
      'notAfterUtc',least(v_occurred_at,clock_timestamp())+interval '2 minutes');
  return new;
end;
$function$;

revoke all on function byeollog_automation.stamp_live_action_deadline_v1()
  from public,anon,authenticated,service_role;

create trigger stamp_live_action_deadline_v1
before insert on byeollog_automation.executions
for each row execute function byeollog_automation.stamp_live_action_deadline_v1();

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
  -- 서버의 immutable occurred_at만 신뢰한다. 재시도 시각에 따라 payload를
  -- 바꾸면 같은 event id가 다른 내용으로 보여 idempotency conflict가 난다.
  v_ledger_only boolean := clock_timestamp()-new.occurred_at > interval '2 minutes';
  v_source_upstream_key text;
  v_existing_actor_tickets bigint;
  v_existing_round_tickets bigint;
  v_existing_participants bigint;
begin
  if new.event_type <> 'donation' or new.amount is null or new.amount <= 0 then
    return new;
  end if;

  select a.* into v_action
  from byeollog_automation.rule_actions a
  join byeollog_automation.rules r on r.id=a.rule_id
  where a.rule_id=any(coalesce(new.matched_rule_ids,'{}'::uuid[]))
    and r.workspace_id=new.workspace_id
    and r.enabled
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
  -- 원본 event는 감사/통계에 남기되 저장 도메인을 넘는 지급은 독성
  -- 재시도 이벤트로 만들지 않는다. 지급 원장에는 아무 side effect도 없다.
  if v_calculated_tickets > 100000 then
    return new;
  end if;
  v_tickets := v_calculated_tickets::integer;

  v_source_upstream_key := case
    when new.source='weflab'
         and nullif(btrim(coalesce(new.payload->>'sourceUid','')),'') is not null
      then 'weflab:'||btrim(new.payload->>'sourceUid')
    else lower(new.source)||':'||new.external_event_id
  end;
  if char_length(v_source_upstream_key) not between 1 and 300 then
    raise exception 'raffle source identity is invalid' using errcode='22023';
  end if;

  -- 닉네임의 제어문자가 Agent strict parser/TTS 전체를 막지 않게 화면용
  -- 이름만 공백으로 정규화한다. 원본 actor JSON은 event 원장에 그대로 남는다.
  v_actor_name := nullif(btrim(pg_catalog.regexp_replace(
    coalesce(v_actor_name,v_actor_key),'[[:cntrl:]]+',' ','g')),'');
  v_actor_name := coalesce(v_actor_name,v_actor_key);
  if char_length(v_actor_name) > 120 then v_actor_name := left(v_actor_name,120); end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle:'||new.workspace_id::text,5301));

  -- 중복 원본은 새 회차를 만들기 전에 종료한다. unique index도 최종 경쟁을
  -- 막지만 이 선확인이 없으면 이미 지급한 후원의 재수신이 빈 회차를 만들 수 있다.
  if exists(
    select 1 from byeollog_automation.raffle_ticket_grants grant_row
    where grant_row.workspace_id=new.workspace_id
      and grant_row.source_upstream_key=v_source_upstream_key
  ) then
    return new;
  end if;

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

  select
    coalesce(sum(e.ticket_count),0)::bigint,
    count(*)::bigint,
    coalesce(max(e.ticket_count) filter(where e.actor_key=v_actor_key),0)::bigint
  into v_existing_round_tickets,v_existing_participants,v_existing_actor_tickets
  from byeollog_automation.raffle_entries e
  where e.round_id=v_round.id;
  -- raffle_entries, sealed snapshot과 같은 상한을 INSERT/UPDATE 전에 적용한다.
  -- 한도를 넘는 후원도 event 원장은 커밋되지만 티켓/overlay는 지급하지 않는다.
  if v_existing_actor_tickets+v_tickets>100000
     or v_existing_round_tickets+v_tickets>1000000
     or (v_existing_actor_tickets=0 and v_existing_participants>=100000)
  then
    return new;
  end if;

  insert into byeollog_automation.raffle_ticket_grants(
    workspace_id,round_id,rule_id,action_id,source_event_key,source_upstream_key,
    actor_key,actor_name,
    donation_amount,ticket_unit,tickets_granted)
  values(
    new.workspace_id,v_round.id,v_action.rule_id,v_action.id,new.external_event_id,
    v_source_upstream_key,
    v_actor_key,v_actor_name,v_amount,v_ticket_unit,v_tickets)
  on conflict(workspace_id,source_upstream_key) do nothing
  returning id into v_grant_id;
  if v_grant_id is null then return new; end if;

  insert into byeollog_automation.raffle_entries(
    round_id,workspace_id,actor_key,actor_name,ticket_count)
  values(v_round.id,new.workspace_id,v_actor_key,v_actor_name,v_tickets)
  on conflict(round_id,actor_key) do update
    set actor_name=excluded.actor_name,
        ticket_count=byeollog_automation.raffle_entries.ticket_count+excluded.ticket_count,
        last_granted_at=clock_timestamp();

  -- 오래된 수집 행은 추첨권 원장만 복구한다. 아봉/TTS/오버레이처럼
  -- 현재 방송을 바꾸는 부작용은 재생하지 않는다.
  if v_ledger_only then return new; end if;

  select coalesce(sum(e.ticket_count),0)::integer,count(*)::integer
    into v_total_tickets,v_participants
  from byeollog_automation.raffle_entries e where e.round_id=v_round.id;

  v_idempotency_key := encode(extensions.digest(pg_catalog.convert_to(
    'raffle-grant-v3|'||new.workspace_id::text||'|'||v_source_upstream_key,
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
end;
$function$;

revoke all on function byeollog_automation.capture_raffle_ticket_grant_v1()
  from public,anon,authenticated,service_role;

revoke all on function public.draw_raffle_v1(uuid,integer,boolean)
  from public,anon,authenticated,service_role;

;
