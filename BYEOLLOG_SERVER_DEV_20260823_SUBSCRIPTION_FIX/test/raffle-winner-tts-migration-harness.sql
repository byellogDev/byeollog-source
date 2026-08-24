\set ON_ERROR_STOP on

do $$
begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role; end if;
end
$$;

create schema extensions;
create schema byeollog_automation;
create extension pgcrypto with schema extensions;

create table byeollog_automation.executions(
  id uuid primary key,
  workspace_id uuid not null,
  execution_target text not null,
  agent_device_id uuid,
  action_type text not null,
  action_params jsonb not null,
  status text not null,
  attempt_no integer not null,
  lease_owner text,
  lease_expires_at timestamptz
);

create table byeollog_automation.raffle_rounds(
  id uuid primary key,
  workspace_id uuid not null,
  status text not null,
  agent_device_id uuid
);

create table byeollog_automation.raffle_draws(
  id uuid primary key,
  workspace_id uuid not null,
  round_id uuid not null references byeollog_automation.raffle_rounds(id)
);

create table byeollog_automation.raffle_draw_candidates(
  draw_id uuid not null references byeollog_automation.raffle_draws(id),
  actor_key text not null,
  actor_name text not null,
  primary key(draw_id,actor_key)
);

create function byeollog_automation.assert_runtime_locked_v1(
  uuid,uuid,uuid,text,text,text
) returns void language sql set search_path='' as $$ select $$;

create function byeollog_automation.assert_agent_device_locked_v1(
  uuid,uuid,text
) returns void language sql set search_path='' as $$ select $$;

-- The migration under test is loaded after this setup file.
