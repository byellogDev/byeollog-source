-- Temporary, read-only truth ledger used to compare the authoritative SOOP
-- Chat SDK pipeline with Weflab during the core-product cutover. Nothing in
-- this table is allowed to create wallpaper tiles, donations, or Upbo tasks.

create table public.byeollog_weflab_shadow_events (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  source_uid text not null,
  session_id text not null,
  donated_time_text text,
  donated_at timestamptz,
  actor_id text,
  actor_name text,
  amount bigint not null default 0 check(amount between 0 and 1000000000),
  roulette_name text,
  expected_spins integer check(expected_spins is null or expected_spins between 0 and 10000),
  actual_spins integer not null default 0 check(actual_spins between 0 and 10000),
  source_validation text not null default 'unmapped',
  roulette_results jsonb not null default '[]'::jsonb check(jsonb_typeof(roulette_results)='array'),
  collector_version text,
  observed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,source_uid),
  check(char_length(source_uid) between 1 and 240 and source_uid!~'[[:cntrl:]]'),
  check(char_length(session_id) between 1 and 200 and session_id!~'[[:cntrl:]]'),
  check(actor_id is null or (char_length(actor_id) between 1 and 180 and actor_id!~'[[:cntrl:]]')),
  check(actor_name is null or (char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]')),
  check(roulette_name is null or char_length(roulette_name)<=160),
  check(char_length(source_validation) between 1 and 40),
  check(collector_version is null or char_length(collector_version)<=40)
);

create index byeollog_weflab_shadow_events_compare_idx
  on public.byeollog_weflab_shadow_events(workspace_id,donated_at,amount,actor_id);
create index byeollog_weflab_shadow_events_retention_idx
  on public.byeollog_weflab_shadow_events(observed_at,id);

alter table public.byeollog_weflab_shadow_events enable row level security;
revoke all on table public.byeollog_weflab_shadow_events from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_weflab_shadow_events to service_role;
create policy byeollog_weflab_shadow_events_deny_browser
  on public.byeollog_weflab_shadow_events for all to anon,authenticated
  using(false) with check(false);

comment on table public.byeollog_weflab_shadow_events is
  'Temporary service-only Weflab truth ledger. It has no product-side triggers and is retained only for SOOP SDK validation.';

create or replace function private.run_weflab_shadow_retention_v1(p_batch_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='100ms'
set statement_timeout='2s'
as $function$
declare v_limit integer;v_deleted integer:=0;
begin
  v_limit:=least(greatest(coalesce(p_batch_limit,500),1),2000);
  if not pg_catalog.pg_try_advisory_xact_lock(
    pg_catalog.hashtextextended('byeollog:weflab-shadow-retention:v1',0)
  ) then return jsonb_build_object('ok',true,'skipped','already_running'); end if;
  with candidates as (
    select event.id from public.byeollog_weflab_shadow_events event
    where event.observed_at<clock_timestamp()-interval '45 days'
    order by event.observed_at,event.id limit v_limit for update skip locked
  ),deleted as (
    delete from public.byeollog_weflab_shadow_events event using candidates
    where event.id=candidates.id returning 1
  ) select count(*)::integer into v_deleted from deleted;
  return jsonb_build_object('ok',true,'deleted',v_deleted);
end
$function$;
revoke all on function private.run_weflab_shadow_retention_v1(integer)
  from public,anon,authenticated,service_role;

select cron.schedule(
  'byeollog-weflab-shadow-retention-v1',
  '19 4 * * *',
  $$select private.run_weflab_shadow_retention_v1(500)$$
);


