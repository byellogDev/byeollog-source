-- 별록 액션: 추첨
-- 후원 금액의 정수 배수로 추첨권을 지급하고, 서버 원장에서 회차/응모/추첨 결과를
-- 불변 이력으로 보존한다. 내부 테이블은 Data API에 직접 노출하지 않고 검증된 RPC만
-- authenticated 역할에 공개한다.

create table byeollog_automation.raffle_rounds (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  rule_id uuid not null,
  action_id uuid not null,
  agent_device_id uuid not null,
  status text not null default 'open' check (status in ('open','drawn')),
  opened_at timestamptz not null default clock_timestamp(),
  drawn_at timestamptz,
  winner_count integer check (winner_count is null or winner_count between 1 and 100),
  allow_duplicate_winners boolean,
  requested_by uuid,
  draw_seed text check (draw_seed is null or draw_seed ~ '^[0-9a-f]{64}$'),
  total_tickets_snapshot integer check (total_tickets_snapshot is null or total_tickets_snapshot between 1 and 1000000),
  participant_count_snapshot integer check (participant_count_snapshot is null or participant_count_snapshot between 1 and 100000),
  check ((status='open' and drawn_at is null and winner_count is null and requested_by is null)
      or (status='drawn' and drawn_at is not null and winner_count is not null and requested_by is not null))
);

create unique index raffle_rounds_one_open_per_workspace
  on byeollog_automation.raffle_rounds(workspace_id)
  where status='open';
create index raffle_rounds_workspace_opened_idx
  on byeollog_automation.raffle_rounds(workspace_id, opened_at desc);

create table byeollog_automation.raffle_entries (
  round_id uuid not null references byeollog_automation.raffle_rounds(id) on delete restrict,
  workspace_id uuid not null,
  actor_key text not null check (char_length(actor_key) between 1 and 180),
  actor_name text not null check (char_length(actor_name) between 1 and 120),
  ticket_count integer not null check (ticket_count between 1 and 100000),
  first_granted_at timestamptz not null default clock_timestamp(),
  last_granted_at timestamptz not null default clock_timestamp(),
  primary key(round_id, actor_key)
);
create index raffle_entries_workspace_round_idx
  on byeollog_automation.raffle_entries(workspace_id, round_id, ticket_count desc, actor_key);

create table byeollog_automation.raffle_ticket_grants (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null references byeollog_automation.raffle_rounds(id) on delete restrict,
  rule_id uuid not null,
  action_id uuid not null,
  source_event_key text not null check (char_length(source_event_key) between 1 and 200),
  actor_key text not null check (char_length(actor_key) between 1 and 180),
  actor_name text not null check (char_length(actor_name) between 1 and 120),
  donation_amount bigint not null check (donation_amount between 1 and 1000000000000),
  ticket_unit integer not null check (ticket_unit between 1 and 1000000),
  tickets_granted integer not null check (tickets_granted between 1 and 100000),
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id, source_event_key, rule_id)
);
create index raffle_ticket_grants_round_created_idx
  on byeollog_automation.raffle_ticket_grants(round_id, created_at desc);

create table byeollog_automation.raffle_draws (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null references byeollog_automation.raffle_rounds(id) on delete restrict,
  requested_by uuid not null,
  winner_count integer not null check (winner_count between 1 and 100),
  allow_duplicate_winners boolean not null,
  random_seed text not null check (random_seed ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(round_id)
);
create index raffle_draws_workspace_created_idx
  on byeollog_automation.raffle_draws(workspace_id, created_at desc);

create table byeollog_automation.raffle_draw_candidates (
  draw_id uuid not null references byeollog_automation.raffle_draws(id) on delete restrict,
  actor_key text not null check (char_length(actor_key) between 1 and 180),
  actor_name text not null check (char_length(actor_name) between 1 and 120),
  original_ticket_count integer not null check (original_ticket_count between 1 and 100000),
  remaining_ticket_count integer not null check (remaining_ticket_count between 0 and 100000),
  primary key(draw_id, actor_key)
);

create table byeollog_automation.raffle_winners (
  draw_id uuid not null references byeollog_automation.raffle_draws(id) on delete restrict,
  draw_index integer not null check (draw_index between 1 and 100),
  actor_key text not null check (char_length(actor_key) between 1 and 180),
  actor_name text not null check (char_length(actor_name) between 1 and 120),
  ticket_count_at_draw integer not null check (ticket_count_at_draw between 1 and 100000),
  selected_ticket_ordinal integer not null check (selected_ticket_ordinal between 1 and 1000000),
  created_at timestamptz not null default clock_timestamp(),
  primary key(draw_id, draw_index)
);

alter table byeollog_automation.raffle_rounds enable row level security;
alter table byeollog_automation.raffle_entries enable row level security;
alter table byeollog_automation.raffle_ticket_grants enable row level security;
alter table byeollog_automation.raffle_draws enable row level security;
alter table byeollog_automation.raffle_draw_candidates enable row level security;
alter table byeollog_automation.raffle_winners enable row level security;

create policy raffle_rounds_explicit_deny on byeollog_automation.raffle_rounds for all using(false) with check(false);
create policy raffle_entries_explicit_deny on byeollog_automation.raffle_entries for all using(false) with check(false);
create policy raffle_ticket_grants_explicit_deny on byeollog_automation.raffle_ticket_grants for all using(false) with check(false);
create policy raffle_draws_explicit_deny on byeollog_automation.raffle_draws for all using(false) with check(false);
create policy raffle_draw_candidates_explicit_deny on byeollog_automation.raffle_draw_candidates for all using(false) with check(false);
create policy raffle_winners_explicit_deny on byeollog_automation.raffle_winners for all using(false) with check(false);

revoke all on table byeollog_automation.raffle_rounds from public, anon, authenticated, service_role;
revoke all on table byeollog_automation.raffle_entries from public, anon, authenticated, service_role;
revoke all on table byeollog_automation.raffle_ticket_grants from public, anon, authenticated, service_role;
revoke all on table byeollog_automation.raffle_draws from public, anon, authenticated, service_role;
revoke all on table byeollog_automation.raffle_draw_candidates from public, anon, authenticated, service_role;
revoke all on table byeollog_automation.raffle_winners from public, anon, authenticated, service_role;

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
  v_tickets integer;
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
  v_actor_name := coalesce(v_actor_name,v_actor_key);
  if char_length(v_actor_name) > 120 then v_actor_name := left(v_actor_name,120); end if;
  v_tickets := floor(v_amount::numeric/v_ticket_unit)::integer;
  if v_tickets < 1 then return new; end if;
  if v_tickets > 100000 then
    raise exception 'raffle ticket grant exceeds the safe limit' using errcode='22023';
  end if;

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
    'raffle-grant-v1|'||new.workspace_id::text||'|'||new.external_event_id||'|'||v_action.rule_id::text,
    'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.executions(
    id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,
    agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(
    v_execution_id,new.workspace_id,new.id,v_action.rule_id,v_action.id,v_idempotency_key,
    'local_agent',v_round.agent_device_id,'raffle.overlay',jsonb_build_object(
      'kind','ticket_granted','overlayImageKey','raffle_ticket_granted','durationMs',5000,
      'actorName',v_actor_name,'ticketsGranted',v_tickets,'actorTickets',(
        select e.ticket_count from byeollog_automation.raffle_entries e
        where e.round_id=v_round.id and e.actor_key=v_actor_key),
      'totalTickets',v_total_tickets,'participantCount',v_participants),
    15000,3,5);
  return new;
exception when others then
  -- 추첨 부가기능의 결함이나 한도 초과가 원본 후원 이벤트 저장을 막아서는 안 된다.
  -- 예외 블록의 서브트랜잭션이 이 함수 안의 부분 지급을 모두 되돌린 뒤 이벤트만 보존한다.
  return new;
end;
$function$;

revoke all on function byeollog_automation.capture_raffle_ticket_grant_v1() from public,anon,authenticated,service_role;
create trigger capture_raffle_ticket_grant_v1
after insert on byeollog_automation.events
for each row execute function byeollog_automation.capture_raffle_ticket_grant_v1();

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
      where rr.rule_id=old.id and rr.workspace_id=old.workspace_id and rr.status='open')
    then
      raise exception 'an open raffle round must be drawn before changing its rule' using errcode='PT409';
    end if;
    return old;
  end if;

  if old.enabled and not new.enabled and exists(
    select 1 from byeollog_automation.raffle_rounds rr
    where rr.rule_id=old.id and rr.workspace_id=old.workspace_id and rr.status='open')
  then
    raise exception 'an open raffle round must be drawn before changing its rule' using errcode='PT409';
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
      raise exception 'only one raffle ticket rule can be active at a time' using errcode='PT409';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function byeollog_automation.protect_raffle_rule_v1() from public,anon,authenticated,service_role;
create trigger protect_raffle_rule_v1
before update of enabled or delete on byeollog_automation.rules
for each row execute function byeollog_automation.protect_raffle_rule_v1();

create or replace function byeollog_automation.save_guided_rule_v9_impl(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_uid uuid;
  v_rule_id uuid;
  v_series_id uuid;
  v_version integer;
  v_condition_id uuid;
  v_action_id uuid := extensions.gen_random_uuid();
  v_position integer := 0;
  v_params jsonb;
begin
  if p_action_type <> 'raffle.ticket_grant' then
    if p_raffle_ticket_unit is not null then
      raise exception 'raffle fields belong to raffle actions only' using errcode='22023';
    end if;
    return query select saved.rule_id,saved.rule_version,saved.created_enabled
    from byeollog_automation.save_guided_rule_v8_impl(
      p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
      p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
      p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
      p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
      p_replace_rule_id,p_expected_version) saved;
    return;
  end if;

  v_uid := byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  perform byeollog_automation.assert_rule_write_off_v1();
  if p_name is null or char_length(btrim(p_name)) not between 1 and 120
     or p_priority not between -10000 and 10000
     or p_source not in ('weflab','byeollog')
     or p_event_type <> 'donation'
     or p_result is not null
     or p_min_amount is null or p_raffle_ticket_unit is null
     or p_min_amount <> p_raffle_ticket_unit
     or p_raffle_ticket_unit not between 1 and 1000000
     or p_event_name is not null or p_output_types is not null or p_quantity is not null
     or p_duration_seconds is not null or p_agent_device_id is null
     or p_overlay_image_key is not null or p_overlay_position_x is not null
     or p_overlay_position_y is not null or p_overlay_scale_percent is not null
     or p_reward_multiplier is not null or p_allow_multiplier_stacking is not null
  then
    raise exception 'raffle action parameters are invalid' using errcode='22023';
  end if;
  if not exists(
    select 1 from byeollog_automation.agent_devices d
    join byeollog_automation.agent_device_status s
      on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    where d.workspace_id=p_workspace_id and d.device_id=p_agent_device_id
      and d.revoked_at is null and 'raffle.overlay'=any(s.supported_action_types))
  then
    raise exception 'raffle action agent device is unavailable' using errcode='PT409';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog-raffle-config:'||p_workspace_id::text,5301));
  if p_enabled and exists(
    select 1 from byeollog_automation.rules r
    join byeollog_automation.rule_actions a on a.rule_id=r.id
    where r.workspace_id=p_workspace_id and r.enabled
      and (p_replace_rule_id is null or r.id<>p_replace_rule_id)
      and a.action_type='log' and a.params->>'controlType'='raffle_ticket_grant')
  then
    raise exception 'only one raffle ticket rule can be active at a time' using errcode='PT409';
  end if;

  if p_replace_rule_id is null then
    if p_expected_version is not null then raise exception 'orphan expected version' using errcode='22023'; end if;
    v_rule_id:=extensions.gen_random_uuid(); v_series_id:=v_rule_id; v_version:=1;
    insert into public.rules(id,workspace_id,name,enabled,priority,match_mode,created_by_user_id,version_series_id,version_number)
    values(v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid,v_series_id,v_version);
    insert into byeollog_automation.rules(id,workspace_id,name,enabled,priority,match_mode,created_by_user_id)
    values(v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid);
  else
    select r.version_series_id,r.version_number+1 into v_series_id,v_version
    from public.rules r where r.id=p_replace_rule_id and r.workspace_id=p_workspace_id
      and r.superseded_at is null and r.version_number=p_expected_version for update;
    if not found then raise exception 'rule version changed' using errcode='40001'; end if;
    update public.rules set enabled=false,superseded_at=clock_timestamp(),updated_at=clock_timestamp() where id=p_replace_rule_id;
    update byeollog_automation.rules set enabled=false,updated_at=clock_timestamp() where id=p_replace_rule_id;
    v_rule_id:=extensions.gen_random_uuid();
    insert into public.rules(id,workspace_id,name,enabled,priority,match_mode,created_by_user_id,version_series_id,version_number,supersedes_rule_id)
    values(v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid,v_series_id,v_version,p_replace_rule_id);
    insert into byeollog_automation.rules(id,workspace_id,name,enabled,priority,match_mode,created_by_user_id)
    values(v_rule_id,p_workspace_id,btrim(p_name),p_enabled,p_priority,'all',v_uid);
  end if;

  v_condition_id:=extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'source','eq',to_jsonb(p_source));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'source','eq',to_jsonb(p_source));
  v_position:=v_position+1; v_condition_id:=extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'type','eq',to_jsonb('donation'::text));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'type','eq',to_jsonb('donation'::text));
  if nullif(btrim(coalesce(p_subtype,'')),'') is not null then
    v_position:=v_position+1; v_condition_id:=extensions.gen_random_uuid();
    insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'subtype','eq',to_jsonb(btrim(p_subtype)));
    insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'subtype','eq',to_jsonb(btrim(p_subtype)));
  end if;
  v_position:=v_position+1; v_condition_id:=extensions.gen_random_uuid();
  insert into public.rule_conditions values(v_condition_id,v_rule_id,v_position,'amount','gte',to_jsonb(p_raffle_ticket_unit));
  insert into byeollog_automation.rule_conditions values(v_condition_id,v_rule_id,v_position,'amount','gte',to_jsonb(p_raffle_ticket_unit));

  v_params:=jsonb_build_object('label','추첨권 지급','controlType','raffle_ticket_grant',
    'ticketUnit',p_raffle_ticket_unit,'agentDeviceId',p_agent_device_id,
    'overlayImageKey','raffle_ticket_granted','durationMs',5000);
  insert into public.rule_actions(id,rule_id,position,action_type,params,execution_target,agent_device_id,overlay_asset_id,overlay_duration_ms)
  values(v_action_id,v_rule_id,0,'log',v_params,'server',null,null,null);
  insert into byeollog_automation.rule_actions(id,rule_id,position,execution_target,agent_device_id,action_type,params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_action_id,v_rule_id,0,'server',null,'log',v_params,5000,1,15);
  return query select v_rule_id,v_version,p_enabled;
end;
$function$;

create or replace function public.save_guided_rule_v9(
  p_workspace_id uuid,p_name text,p_enabled boolean,p_priority integer,p_source text,
  p_event_type text,p_subtype text,p_result text,p_min_amount bigint,p_action_type text,
  p_event_name text,p_output_types text[],p_quantity integer,p_duration_seconds integer,
  p_agent_device_id uuid,p_overlay_image_key text,p_overlay_position_x integer,
  p_overlay_position_y integer,p_overlay_scale_percent integer,p_reward_multiplier integer,
  p_allow_multiplier_stacking boolean,p_raffle_ticket_unit integer,
  p_replace_rule_id uuid,p_expected_version integer)
returns table(rule_id uuid,rule_version integer,created_enabled boolean)
language sql
security definer
set search_path=''
as $function$
  select * from byeollog_automation.save_guided_rule_v9_impl(
    p_workspace_id,p_name,p_enabled,p_priority,p_source,p_event_type,p_subtype,p_result,
    p_min_amount,p_action_type,p_event_name,p_output_types,p_quantity,p_duration_seconds,
    p_agent_device_id,p_overlay_image_key,p_overlay_position_x,p_overlay_position_y,
    p_overlay_scale_percent,p_reward_multiplier,p_allow_multiplier_stacking,
    p_raffle_ticket_unit,p_replace_rule_id,p_expected_version)
$function$;

revoke all on function byeollog_automation.save_guided_rule_v9_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function public.save_guided_rule_v9(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.save_guided_rule_v9(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,uuid,integer) to authenticated;

create or replace function public.get_raffle_state_v1(p_workspace_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_uid uuid;
  v_round jsonb;
  v_history jsonb;
begin
  v_uid:=byeollog_automation.assert_canary_manager_v1(p_workspace_id);
  select jsonb_build_object(
    'roundId',r.id,'openedAt',r.opened_at,
    'totalTickets',coalesce((select sum(e.ticket_count) from byeollog_automation.raffle_entries e where e.round_id=r.id),0),
    'participantCount',(select count(*) from byeollog_automation.raffle_entries e where e.round_id=r.id),
    'entries',coalesce((select jsonb_agg(jsonb_build_object('actorName',x.actor_name,'ticketCount',x.ticket_count,'lastGrantedAt',x.last_granted_at) order by x.ticket_count desc,x.actor_name)
      from (select e.actor_name,e.ticket_count,e.last_granted_at from byeollog_automation.raffle_entries e where e.round_id=r.id order by e.ticket_count desc,e.actor_key limit 500) x),'[]'::jsonb))
  into v_round
  from byeollog_automation.raffle_rounds r
  where r.workspace_id=p_workspace_id and r.status='open';

  select coalesce(jsonb_agg(jsonb_build_object(
    'drawId',d.id,'createdAt',d.created_at,'winnerCount',d.winner_count,
    'allowDuplicateWinners',d.allow_duplicate_winners,
    'winners',coalesce((select jsonb_agg(jsonb_build_object('drawIndex',w.draw_index,'actorName',w.actor_name) order by w.draw_index)
      from byeollog_automation.raffle_winners w where w.draw_id=d.id),'[]'::jsonb))
    order by d.created_at desc),'[]'::jsonb)
  into v_history
  from (select * from byeollog_automation.raffle_draws where workspace_id=p_workspace_id order by created_at desc limit 10) d;
  return jsonb_build_object('round',v_round,'history',coalesce(v_history,'[]'::jsonb),'loadedAt',clock_timestamp());
end;
$function$;

revoke all on function public.get_raffle_state_v1(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_raffle_state_v1(uuid) to authenticated;

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
    -- 공개 감사 가능한 draw seed와 회차 번호에서 각 당첨 티켓 위치를 결정한다.
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
  v_plan_token:=encode(extensions.digest(pg_catalog.convert_to('raffle-draw-v1|'||p_workspace_id::text||'|'||v_draw_id::text,'UTF8'),'sha256'),'hex');
  v_idempotency_key:=encode(extensions.digest(pg_catalog.convert_to('raffle-draw-execution-v1|'||p_workspace_id::text||'|'||v_draw_id::text,'UTF8'),'sha256'),'hex');
  insert into byeollog_automation.events(id,workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,actor,amount,currency,payload,raw,correlation_id,occurred_at,received_at,authorized_user_id,plan_token,evaluated_rule_ids,matched_rule_ids)
  values(v_event_id,p_workspace_id,'1.0','raffle-draw-'||v_draw_id::text,'manual','byeollog','raffle_draw','winner_selection',jsonb_build_object('id',v_uid,'name','별록 스트리머'),null,null,jsonb_build_object('drawId',v_draw_id,'winnerCount',p_winner_count,'winners',v_winners),null,'raffle-draw:'||v_draw_id::text,v_now,v_now,v_uid,v_plan_token,array[v_round.rule_id],array[v_round.rule_id]);
  insert into byeollog_automation.executions(id,workspace_id,event_id,rule_id,action_id,idempotency_key,execution_target,agent_device_id,action_type,action_params,timeout_ms,max_attempts,retry_backoff_seconds)
  values(v_execution_id,p_workspace_id,v_event_id,v_round.rule_id,v_round.action_id,v_idempotency_key,'local_agent',v_round.agent_device_id,'raffle.overlay',jsonb_build_object('kind','draw_result','overlayImageKey','raffle_draw','durationMs',4000,'winnerCount',p_winner_count,'winners',v_winners),120000,3,5);
  return jsonb_build_object('drawId',v_draw_id,'roundId',v_round.id,'executionId',v_execution_id,'winners',v_winners);
end;
$function$;

revoke all on function public.draw_raffle_v1(uuid,integer,boolean) from public,anon,authenticated,service_role;
grant execute on function public.draw_raffle_v1(uuid,integer,boolean) to authenticated;
