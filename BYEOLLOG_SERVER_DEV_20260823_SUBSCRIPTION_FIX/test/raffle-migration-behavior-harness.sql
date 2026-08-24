\set ON_ERROR_STOP on

create role anon;
create role authenticated;
create role service_role;
create schema extensions;
create schema byeollog_automation;
create extension pgcrypto with schema extensions;

create table byeollog_automation.rules(
  id uuid primary key,
  workspace_id uuid not null,
  enabled boolean not null,
  priority integer not null
);
create table byeollog_automation.rule_actions(
  id uuid primary key,
  rule_id uuid not null references byeollog_automation.rules(id),
  position integer not null,
  action_type text not null,
  params jsonb not null
);
create table byeollog_automation.events(
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  schema_version text not null,
  external_event_id text not null,
  source text not null,
  platform text not null,
  event_type text not null,
  subtype text,
  actor jsonb,
  amount numeric,
  currency text,
  payload jsonb not null,
  raw jsonb,
  correlation_id text,
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  authorized_user_id uuid,
  plan_token text,
  evaluated_rule_ids uuid[] not null default '{}',
  matched_rule_ids uuid[] not null default '{}',
  unique(workspace_id,source,external_event_id)
);
create table byeollog_automation.raffle_rounds(
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  rule_id uuid not null,
  action_id uuid not null,
  agent_device_id uuid not null,
  status text not null default 'open',
  opened_at timestamptz not null default clock_timestamp(),
  drawn_at timestamptz,
  winner_count integer,
  allow_duplicate_winners boolean,
  requested_by uuid,
  draw_seed text,
  total_tickets_snapshot integer,
  participant_count_snapshot integer
);
create unique index raffle_rounds_one_open
  on byeollog_automation.raffle_rounds(workspace_id) where status='open';
create table byeollog_automation.raffle_ticket_grants(
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  round_id uuid not null references byeollog_automation.raffle_rounds(id),
  rule_id uuid not null,
  action_id uuid not null,
  source_event_key text not null,
  actor_key text not null,
  actor_name text not null,
  donation_amount bigint not null,
  ticket_unit integer not null,
  tickets_granted integer not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,source_event_key,rule_id)
);
create table byeollog_automation.raffle_entries(
  round_id uuid not null references byeollog_automation.raffle_rounds(id),
  workspace_id uuid not null,
  actor_key text not null,
  actor_name text not null,
  ticket_count integer not null,
  first_granted_at timestamptz not null default clock_timestamp(),
  last_granted_at timestamptz not null default clock_timestamp(),
  primary key(round_id,actor_key)
);
create table byeollog_automation.raffle_draws(
  id uuid primary key,
  workspace_id uuid not null,
  round_id uuid not null references byeollog_automation.raffle_rounds(id),
  requested_by uuid not null,
  winner_count integer not null,
  allow_duplicate_winners boolean not null,
  random_seed text not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(round_id)
);
create table byeollog_automation.raffle_draw_candidates(
  draw_id uuid not null references byeollog_automation.raffle_draws(id),
  actor_key text not null,
  actor_name text not null,
  original_ticket_count integer not null,
  remaining_ticket_count integer not null,
  primary key(draw_id,actor_key)
);
create table byeollog_automation.raffle_winners(
  draw_id uuid not null references byeollog_automation.raffle_draws(id),
  draw_index integer not null,
  actor_key text not null,
  actor_name text not null,
  ticket_count_at_draw integer not null,
  selected_ticket_ordinal integer not null,
  selected_at timestamptz not null default clock_timestamp(),
  primary key(draw_id,draw_index)
);
create table byeollog_automation.agent_devices(
  workspace_id uuid not null,
  device_id uuid not null,
  revoked_at timestamptz,
  primary key(workspace_id,device_id)
);
create table byeollog_automation.agent_device_status(
  workspace_id uuid not null,
  device_id uuid not null,
  reported_at timestamptz not null,
  supported_action_types text[] not null,
  primary key(workspace_id,device_id)
);
create table byeollog_automation.executions(
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  event_id uuid not null references byeollog_automation.events(id),
  rule_id uuid not null,
  action_id uuid not null,
  idempotency_key text not null,
  execution_target text not null,
  agent_device_id uuid,
  action_type text not null,
  action_params jsonb not null,
  timeout_ms integer not null,
  max_attempts integer not null,
  retry_backoff_seconds integer not null,
  status text not null default 'queued',
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,idempotency_key)
);

create function byeollog_automation.calculate_raffle_ticket_count_v1(
  p_amount bigint,p_ticket_unit integer,p_allow_multiples boolean)
returns bigint language sql immutable set search_path=''
as $$ select case when p_allow_multiples then p_amount/p_ticket_unit
                   when p_amount=p_ticket_unit then 1 else 0 end $$;
create function byeollog_automation.assert_canary_manager_v1(p_workspace_id uuid)
returns uuid language sql stable set search_path=''
as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
create function public.draw_raffle_v1(uuid,integer,boolean)
returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.start_raffle_draw_v1(uuid,integer,boolean)
returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.draw_next_raffle_winner_v1(uuid,integer)
returns jsonb language sql as $$ select '{}'::jsonb $$;
revoke all on function public.start_raffle_draw_v1(uuid,integer,boolean)
  from public,anon,authenticated,service_role;
grant execute on function public.start_raffle_draw_v1(uuid,integer,boolean)
  to authenticated;
revoke all on function public.draw_next_raffle_winner_v1(uuid,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.draw_next_raffle_winner_v1(uuid,integer)
  to authenticated;

-- 구형 session 기반 ID로 이미 중복 적립된 원장이 있어도 migration이
-- 기록을 삭제하지 않고 canonical 최초 1건을 선택할 수 있어야 한다.
insert into byeollog_automation.rules(id,workspace_id,enabled,priority)
values('92000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',false,1);
insert into byeollog_automation.rule_actions(id,rule_id,position,action_type,params)
values('93000000-0000-4000-8000-000000000001','92000000-0000-4000-8000-000000000001',0,'log','{}');
insert into byeollog_automation.raffle_rounds(
  id,workspace_id,rule_id,action_id,agent_device_id,status)
values(
  '94000000-0000-4000-8000-000000000001','91000000-0000-4000-8000-000000000001',
  '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
  '95000000-0000-4000-8000-000000000001','drawn');
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,
  payload,occurred_at,received_at)
values
  ('91000000-0000-4000-8000-000000000001','1.0','legacy-event-a','weflab','soop','donation',
   '{"sourceUid":"legacy-upstream"}',clock_timestamp(),clock_timestamp()),
  ('91000000-0000-4000-8000-000000000001','1.0','legacy-event-b','weflab','soop','donation',
   '{"sourceUid":"legacy-upstream"}',clock_timestamp(),clock_timestamp());
insert into byeollog_automation.raffle_ticket_grants(
  workspace_id,round_id,rule_id,action_id,source_event_key,actor_key,actor_name,
  donation_amount,ticket_unit,tickets_granted)
values
  ('91000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
   'legacy-event-a','legacy-viewer','기존 시청자',33,33,1),
  ('91000000-0000-4000-8000-000000000001','94000000-0000-4000-8000-000000000001',
   '92000000-0000-4000-8000-000000000001','93000000-0000-4000-8000-000000000001',
   'legacy-event-b','legacy-viewer','기존 시청자',33,33,1);

\ir ../supabase/migrations/20260823225424_harden_raffle_delivery.sql
\ir ../supabase/migrations/20260823230740_add_raffle_winner_reannounce.sql
\ir ../supabase/migrations/20260824103000_harden_manual_raffle_draw_request.sql

-- 운영과 같은 원본 스키마에는 sealed_at이 없었다. 회귀 harness가 이 컬럼을
-- 미리 만들어 결함을 숨기지 않는지 확인한 뒤 복구 migration을 적용한다.
do $$ begin
  if exists(
    select 1 from information_schema.columns
    where table_schema='byeollog_automation'
      and table_name='raffle_rounds'
      and column_name='sealed_at')
  then
    raise exception 'raffle harness predeclared sealed_at and masked the production defect';
  end if;
end $$;

\ir ../supabase/migrations/20260824160000_add_missing_raffle_sealed_at.sql

do $$ begin
  if not exists(
    select 1 from information_schema.columns
    where table_schema='byeollog_automation'
      and table_name='raffle_rounds'
      and column_name='sealed_at'
      and data_type='timestamp with time zone')
  then
    raise exception 'sealed_at recovery migration did not repair raffle_rounds';
  end if;
end $$;

do $$ begin
  if (select count(*) from byeollog_automation.raffle_ticket_grants
      where workspace_id='91000000-0000-4000-8000-000000000001')<>2
     or (select count(*) from byeollog_automation.raffle_ticket_grants
         where workspace_id='91000000-0000-4000-8000-000000000001'
           and source_upstream_key='weflab:legacy-upstream')<>1
     or (select count(*) from byeollog_automation.raffle_ticket_grants
         where workspace_id='91000000-0000-4000-8000-000000000001'
           and source_upstream_key like 'legacy-duplicate:%')<>1 then
    raise exception 'legacy duplicate backfill was not preserved safely';
  end if;
end $$;

-- 운영에는 이전 raffle migration이 이미 만든 AFTER INSERT trigger가 있다.
-- 이 독립 harness는 최신 두 migration만 검증하므로 동일 trigger를 마련한다.
create trigger capture_raffle_ticket_grant_v1
after insert on byeollog_automation.events
for each row execute function byeollog_automation.capture_raffle_ticket_grant_v1();

insert into byeollog_automation.rules(id,workspace_id,enabled,priority)
values('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',true,100);
insert into byeollog_automation.rule_actions(id,rule_id,position,action_type,params)
values(
  '30000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',0,'log',
  jsonb_build_object(
    'controlType','raffle_ticket_grant','ticketUnit',33,'allowMultiples',true,
    'agentDeviceId','40000000-0000-4000-8000-000000000001'));
insert into byeollog_automation.agent_devices(workspace_id,device_id)
values('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001');
insert into byeollog_automation.agent_device_status(
  workspace_id,device_id,reported_at,supported_action_types)
values(
  '10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
  clock_timestamp(),array['raffle.overlay']);

-- 100개는 33개당 3장으로 한 번만 지급되고, 실제 overlay execution에는
-- 서버 기준 만료시각이 붙는다.
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-a','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-a","name":"시청자 A"}',100,'{"sourceUid":"upstream-a"}',
  clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);

do $$
declare v_deadline timestamptz;
begin
  if (select count(*) from byeollog_automation.raffle_ticket_grants
      where workspace_id='10000000-0000-4000-8000-000000000001')<>1 then
    raise exception 'fresh grant count mismatch';
  end if;
  if (select ticket_count from byeollog_automation.raffle_entries)<>3 then
    raise exception 'fresh ticket count mismatch';
  end if;
  if (select count(*) from byeollog_automation.executions)<>1 then
    raise exception 'fresh execution count mismatch';
  end if;
  select (action_params->>'notAfterUtc')::timestamptz into v_deadline
  from byeollog_automation.executions limit 1;
  if v_deadline is null or v_deadline<=clock_timestamp()
     or v_deadline>clock_timestamp()+interval '2 minutes 5 seconds' then
    raise exception 'fresh execution deadline mismatch';
  end if;
end $$;

-- 새 Collector session에서 external id가 바뀌어도 원본 sourceUid가 같으면
-- event만 감사용으로 남고 티켓/회차/execution은 중복되지 않는다.
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-a-new-session','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-a","name":"시청자 A"}',100,'{"sourceUid":"upstream-a"}',
  clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);

do $$ begin
  if (select count(*) from byeollog_automation.raffle_ticket_grants
      where workspace_id='10000000-0000-4000-8000-000000000001')<>1
     or (select ticket_count from byeollog_automation.raffle_entries)<>3
     or (select count(*) from byeollog_automation.executions)<>1 then
    raise exception 'cross-session duplicate was not suppressed';
  end if;
end $$;

-- 2분을 넘긴 후원은 원장에만 복구되고 현재 방송 overlay는 만들지 않는다.
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-stale','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-a","name":"시청자 A"}',66,'{"sourceUid":"upstream-stale"}',
  clock_timestamp()-interval '5 minutes',clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);

do $$ begin
  if (select count(*) from byeollog_automation.raffle_ticket_grants
      where workspace_id='10000000-0000-4000-8000-000000000001')<>2
     or (select ticket_count from byeollog_automation.raffle_entries)<>5
     or (select count(*) from byeollog_automation.executions)<>1 then
    raise exception 'stale ledger-only behavior mismatch';
  end if;
end $$;

-- 잘못된 raffle 설정은 event까지 롤백되어 upstream이 재시도할 수 있어야 한다.
update byeollog_automation.rule_actions
set params=params||'{"ticketUnit":"broken"}'::jsonb
where id='30000000-0000-4000-8000-000000000001';
do $$ begin
  begin
    insert into byeollog_automation.events(
      workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
      actor,amount,payload,occurred_at,received_at,matched_rule_ids)
    values(
      '10000000-0000-4000-8000-000000000001','1.0','event-invalid','weflab','soop','donation','weflab_donation',
      '{"id":"viewer-b","name":"시청자 B"}',33,'{"sourceUid":"upstream-invalid"}',
      clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);
    raise exception 'invalid raffle parameters unexpectedly committed';
  exception when sqlstate '22023' then null;
  end;
  if exists(select 1 from byeollog_automation.events where external_event_id='event-invalid') then
    raise exception 'invalid event survived its failed transaction';
  end if;
end $$;
update byeollog_automation.rule_actions
set params=params||'{"ticketUnit":33}'::jsonb
where id='30000000-0000-4000-8000-000000000001';

-- 저장 도메인을 넘는 지급은 원본 event만 보존하고 영구 재시도나 일부
-- grant/entry/execution을 만들지 않아야 한다.
update byeollog_automation.rule_actions
set params=params||'{"ticketUnit":1}'::jsonb
where id='30000000-0000-4000-8000-000000000001';
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-single-limit','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-limit","name":"한도 시청자"}',100001,'{"sourceUid":"upstream-single-limit"}',
  clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);
do $$ begin
  if not exists(select 1 from byeollog_automation.events where external_event_id='event-single-limit')
     or (select count(*) from byeollog_automation.raffle_ticket_grants
         where workspace_id='10000000-0000-4000-8000-000000000001')<>2
     or (select count(*) from byeollog_automation.executions)<>1 then
    raise exception 'oversized single grant poisoned or partially mutated the event';
  end if;
end $$;
update byeollog_automation.rule_actions
set params=params||'{"ticketUnit":33}'::jsonb
where id='30000000-0000-4000-8000-000000000001';

-- 동일 actor가 100,000장에 도달한 뒤의 후원도 event만 남긴다.
update byeollog_automation.raffle_entries
set ticket_count=100000 where actor_key='viewer-a';
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-actor-limit','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-a","name":"시청자 A"}',33,'{"sourceUid":"upstream-actor-limit"}',
  clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);
do $$ begin
  if not exists(select 1 from byeollog_automation.events where external_event_id='event-actor-limit')
     or (select ticket_count from byeollog_automation.raffle_entries where actor_key='viewer-a')<>100000
     or (select count(*) from byeollog_automation.raffle_ticket_grants
         where workspace_id='10000000-0000-4000-8000-000000000001')<>2 then
    raise exception 'actor ticket cap was not fail-closed';
  end if;
end $$;
update byeollog_automation.raffle_entries
set ticket_count=5 where actor_key='viewer-a';

-- 100,000번째 참가자 이후의 신규 actor도 동일하게 no-grant 처리한다.
insert into byeollog_automation.raffle_entries(
  round_id,workspace_id,actor_key,actor_name,ticket_count)
select round_row.id,round_row.workspace_id,
       'cap-participant-'||series.no,'한도 참가자 '||series.no,1
from byeollog_automation.raffle_rounds round_row
cross join generate_series(1,99999) as series(no)
where round_row.workspace_id='10000000-0000-4000-8000-000000000001'
  and round_row.status='open';
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-participant-limit','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-new","name":"새 시청자"}',33,'{"sourceUid":"upstream-participant-limit"}',
  clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);
do $$ begin
  if not exists(select 1 from byeollog_automation.events where external_event_id='event-participant-limit')
     or (select count(*) from byeollog_automation.raffle_entries
         where workspace_id='10000000-0000-4000-8000-000000000001')<>100000
     or exists(select 1 from byeollog_automation.raffle_entries where actor_key='viewer-new') then
    raise exception 'participant cap was not fail-closed';
  end if;
end $$;
delete from byeollog_automation.raffle_entries where actor_key like 'cap-participant-%';

-- 과거 데이터가 이미 회차 총량을 넘은 경우 start v2는 CHECK 23514 대신
-- 예측 가능한 22023으로 거부하고, 새 후원 역시 event-only로 처리한다.
insert into byeollog_automation.raffle_entries(
  round_id,workspace_id,actor_key,actor_name,ticket_count)
select round_row.id,round_row.workspace_id,
       'cap-total-'||series.no,'총량 한도 '||series.no,100000
from byeollog_automation.raffle_rounds round_row
cross join generate_series(1,10) as series(no)
where round_row.workspace_id='10000000-0000-4000-8000-000000000001'
  and round_row.status='open';
do $$
declare v_round_id uuid;
begin
  select id into strict v_round_id from byeollog_automation.raffle_rounds
  where workspace_id='10000000-0000-4000-8000-000000000001' and status='open';
  begin
    perform public.start_raffle_draw_v2(
      '10000000-0000-4000-8000-000000000001',v_round_id,1,false);
    raise exception 'oversized historical pool unexpectedly sealed';
  exception when sqlstate '22023' then null;
  end;
  if exists(select 1 from byeollog_automation.raffle_draws)
     or exists(select 1 from byeollog_automation.raffle_rounds where id=v_round_id and status<>'open') then
    raise exception 'oversized pool failure mutated the draw ledger';
  end if;
end $$;
insert into byeollog_automation.events(
  workspace_id,schema_version,external_event_id,source,platform,event_type,subtype,
  actor,amount,payload,occurred_at,received_at,matched_rule_ids)
values(
  '10000000-0000-4000-8000-000000000001','1.0','event-round-limit','weflab','soop','donation','weflab_donation',
  '{"id":"viewer-round-limit","name":"총량 시청자"}',33,'{"sourceUid":"upstream-round-limit"}',
  clock_timestamp(),clock_timestamp(),array['20000000-0000-4000-8000-000000000001'::uuid]);
do $$ begin
  if not exists(select 1 from byeollog_automation.events where external_event_id='event-round-limit')
     or (select count(*) from byeollog_automation.raffle_ticket_grants
         where workspace_id='10000000-0000-4000-8000-000000000001')<>2
     or exists(select 1 from byeollog_automation.raffle_entries where actor_key='viewer-round-limit') then
    raise exception 'round ticket cap was not fail-closed';
  end if;
end $$;
delete from byeollog_automation.raffle_entries where actor_key like 'cap-total-%';

-- 두 명을 뽑을 때 중복 비허용이 실제 후보 원장에서 지켜지는지 확인할
-- 두 번째 후보를 마련한다. 지급 파이프라인 자체는 위 실제 event로 검증했다.
insert into byeollog_automation.raffle_entries(
  round_id,workspace_id,actor_key,actor_name,ticket_count)
select id,workspace_id,'viewer-b','시청자 B',2
from byeollog_automation.raffle_rounds
where workspace_id='10000000-0000-4000-8000-000000000001' and status='open';

-- 실제 v2 RPC로 회차를 봉인하고 한 장을 확정한다. 오래 열린 확인창의
-- stale round/draw/device snapshot은 아무 원장도 바꾸지 않아야 한다.
do $$
declare
  v_workspace constant uuid:='10000000-0000-4000-8000-000000000001';
  v_device constant uuid:='40000000-0000-4000-8000-000000000001';
  v_round_id uuid;
  v_start jsonb;
  v_first_draw jsonb;
  v_second_draw jsonb;
  v_first_reannounce jsonb;
  v_retry_reannounce jsonb;
  v_state jsonb;
  v_deadline timestamptz;
begin
  select id into strict v_round_id
  from byeollog_automation.raffle_rounds
  where workspace_id=v_workspace and status='open';

  begin
    perform public.start_raffle_draw_v2(
      v_workspace,'ffffffff-ffff-4fff-8fff-ffffffffffff',2,false);
    raise exception 'stale round snapshot unexpectedly sealed a draw';
  exception when sqlstate '40001' then null;
  end;
  if exists(select 1 from byeollog_automation.raffle_draws where workspace_id=v_workspace)
     or exists(select 1 from byeollog_automation.raffle_rounds
               where workspace_id=v_workspace and status<>'open') then
    raise exception 'stale start mutated the raffle ledger';
  end if;

  v_start:=public.start_raffle_draw_v2(v_workspace,v_round_id,2,false);
  if v_start->>'roundId'<>v_round_id::text
     or coalesce((v_start->>'sealed')::boolean,false) is not true
     or (select sealed_at is null from byeollog_automation.raffle_rounds where id=v_round_id)
  then
    raise exception 'v2 raffle start did not seal the expected round';
  end if;

  begin
    perform public.draw_next_raffle_winner_v2(
      v_workspace,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',1,v_device);
    raise exception 'stale draw snapshot unexpectedly selected a winner';
  exception when sqlstate '40001' then null;
  end;
  begin
    perform public.draw_next_raffle_winner_v2(
      v_workspace,(v_start->>'drawId')::uuid,1,
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd');
    raise exception 'stale device snapshot unexpectedly selected a winner';
  exception when sqlstate '40001' then null;
  end;
  if exists(select 1 from byeollog_automation.raffle_winners) then
    raise exception 'stale next-winner request mutated the winner ledger';
  end if;

  v_first_draw:=public.draw_next_raffle_winner_v2(
    v_workspace,(v_start->>'drawId')::uuid,1,v_device);
  if v_first_draw->>'drawId'<>v_start->>'drawId'
     or v_first_draw->>'roundId'<>v_round_id::text
     or v_first_draw->>'agentDeviceId'<>v_device::text
     or v_first_draw#>>'{winner,drawIndex}'<>'1'
     or coalesce((v_first_draw->>'completed')::boolean,true) is not false
     or v_first_draw->>'remainingCount'<>'1'
     or (select status from byeollog_automation.raffle_rounds where id=v_round_id)<>'sealed'
  then
    raise exception 'first v2 next-winner result did not match the sealed snapshot';
  end if;
  select (action_params->>'notAfterUtc')::timestamptz into strict v_deadline
  from byeollog_automation.executions
  where id=(v_first_draw->>'executionId')::uuid;
  if v_deadline<=clock_timestamp()
     or v_deadline>clock_timestamp()+interval '2 minutes 5 seconds' then
    raise exception 'draw execution deadline mismatch';
  end if;

  v_second_draw:=public.draw_next_raffle_winner_v2(
    v_workspace,(v_start->>'drawId')::uuid,2,v_device);
  if v_second_draw#>>'{winner,drawIndex}'<>'2'
     or coalesce((v_second_draw->>'completed')::boolean,false) is not true
     or v_second_draw->>'remainingCount'<>'0'
     or (select status from byeollog_automation.raffle_rounds where id=v_round_id)<>'drawn'
     or (select count(distinct actor_key) from byeollog_automation.raffle_winners
         where draw_id=(v_start->>'drawId')::uuid)<>2
  then
    raise exception 'second v2 winner did not complete a non-duplicate draw';
  end if;

  v_first_reannounce:=public.reannounce_raffle_winner_v1(
    v_workspace,(v_start->>'drawId')::uuid,1,1);
  if coalesce((v_first_reannounce->>'created')::boolean,false) is not true
     or v_first_reannounce->>'originalExecutionId'<>v_first_draw->>'executionId' then
    raise exception 'first reannounce was not created from the original winner execution';
  end if;
  v_retry_reannounce:=public.reannounce_raffle_winner_v1(
    v_workspace,(v_start->>'drawId')::uuid,1,1);
  if coalesce((v_retry_reannounce->>'created')::boolean,true) is not false
     or v_retry_reannounce->>'executionId'<>v_first_reannounce->>'executionId' then
    raise exception 'reannounce retry was not idempotent';
  end if;

  if (select count(*) from byeollog_automation.raffle_winners)<>2
     or (select count(*) from byeollog_automation.raffle_ticket_grants
         where workspace_id=v_workspace)<>2
     or (select count(*) from byeollog_automation.events
         where workspace_id=v_workspace and subtype='winner_reannounce')<>1
     or (select count(*) from byeollog_automation.executions
         where workspace_id=v_workspace)<>4 then
    raise exception 'draw/reannounce mutated a ledger or produced the wrong presentation count';
  end if;
  v_state:=public.get_raffle_state_v2(v_workspace);
  if v_state#>>'{history,0,winners,0,reannounceCount}'<>'1' then
    raise exception 'reannounce count was not exposed in raffle state';
  end if;

  if pg_catalog.has_function_privilege(
       'authenticated','public.start_raffle_draw_v1(uuid,integer,boolean)','EXECUTE')
     or pg_catalog.has_function_privilege(
       'authenticated','public.draw_next_raffle_winner_v1(uuid,integer)','EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated','public.start_raffle_draw_v2(uuid,uuid,integer,boolean)','EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated','public.draw_next_raffle_winner_v2(uuid,uuid,integer,uuid)','EXECUTE')
     or not pg_catalog.has_function_privilege(
       'authenticated','public.reannounce_raffle_winner_v1(uuid,uuid,integer,integer)','EXECUTE')
  then
    raise exception 'manual raffle RPC privilege boundary mismatch';
  end if;
end $$;

select 'RAFFLE_MIGRATION_BEHAVIOR_PASS' as result;
