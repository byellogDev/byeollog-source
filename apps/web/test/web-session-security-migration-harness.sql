\set ON_ERROR_STOP on

create schema if not exists private;

create table public.byeollog_workspace_members(
  workspace_id uuid not null,
  user_id uuid not null,
  primary key(workspace_id,user_id)
);

grant select,update on public.byeollog_workspace_members to service_role;

create or replace function public.ensure_soop_runtime_controls_v1()
returns void language sql as $$select$$;

create or replace function private.notify_soop_gateway_incident_v1(
  text,uuid,uuid,timestamptz)
returns void language sql as $$select$$;

create or replace function private.check_soop_gateway_heartbeats_v1()
returns void language sql as $$select$$;

\ir ../supabase/migrations/20260902010039_harden_web_sessions_without_hot_path_latency.sql

insert into public.byeollog_workspace_members(workspace_id,user_id)
values
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001'),
  ('20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001');

set role service_role;
select public.revoke_web_sessions_v1(
  '30000000-0000-4000-8000-000000000001');
reset role;

do $assert$
declare hardened_function_count integer;
begin
  if (select count(*) from public.byeollog_workspace_members
      where user_id='30000000-0000-4000-8000-000000000001'
        and web_session_epoch=1)<>2 then
    raise exception 'web session epoch was not advanced for every membership';
  end if;

  if has_function_privilege('anon','public.revoke_web_sessions_v1(uuid)','EXECUTE')
     or has_function_privilege('authenticated','public.revoke_web_sessions_v1(uuid)','EXECUTE')
     or not has_function_privilege('service_role','public.revoke_web_sessions_v1(uuid)','EXECUTE') then
    raise exception 'web session revocation RPC grants are unsafe';
  end if;

  select count(*) into hardened_function_count
  from pg_proc p
  join pg_namespace n on n.oid=p.pronamespace
  cross join lateral unnest(coalesce(p.proconfig,'{}'::text[])) setting
  where (n.nspname,p.proname) in (
    ('public','ensure_soop_runtime_controls_v1'),
    ('private','notify_soop_gateway_incident_v1'),
    ('private','check_soop_gateway_heartbeats_v1'))
    and setting in ('search_path=', 'search_path=""');

  if hardened_function_count<>3 then
    raise exception 'historical privileged functions did not receive an empty search_path';
  end if;

  begin
    update public.byeollog_workspace_members set web_session_epoch=-1;
    raise exception 'negative web session epoch was accepted';
  exception when check_violation then
    null;
  end;
end;
$assert$;

select 'WEB_SESSION_SECURITY_MIGRATION_PASS';
