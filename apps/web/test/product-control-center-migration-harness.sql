\set ON_ERROR_STOP on

create role anon;
create role authenticated;
create role service_role bypassrls;
create schema extensions;
create extension pgcrypto with schema extensions;
create table public.byeollog_workspaces(id uuid primary key);

\ir ../supabase/migrations/20260827164017_add_web_product_control_plane.sql

insert into public.byeollog_workspaces(id) values('10000000-0000-4000-8000-000000000001');

set role service_role;
insert into public.byeollog_roulette_drafts(
  workspace_id,roulette_name,draft,source_kind,source_url,source_fingerprint
) values(
  '10000000-0000-4000-8000-000000000001','테스트 룰렛',
  '{"items":[{"resultText":"A","probabilityPpm":1000000}]}'::jsonb,
  'weflab_public','https://weflab.com/user/Abc_123-x',repeat('a',64)
);
do $$begin
  if (select count(*) from public.byeollog_roulette_drafts)<>1 then
    raise exception 'service role draft access failed';
  end if;
end$$;
reset role;

set role authenticated;
do $$begin
  begin
    perform * from public.byeollog_roulette_drafts;
    raise exception 'authenticated direct select unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end$$;
reset role;

select 'PRODUCT_CONTROL_CENTER_MIGRATION_PASS';
