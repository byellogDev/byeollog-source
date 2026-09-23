-- The streamer names a roulette by its exact donation amount. Individual
-- results continue through the existing learned include/exclude classifier.
create table if not exists public.byeollog_roulette_amount_mappings (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  balloons bigint not null check (balloons between 1 and 1000000000),
  roulette_name text not null,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, balloons),
  constraint byeollog_roulette_amount_mapping_name_check
    check (char_length(btrim(roulette_name)) between 1 and 120 and roulette_name !~ '[[:cntrl:]]')
);

alter table public.byeollog_roulette_amount_mappings enable row level security;
create policy explicitly_deny_direct_client_access
  on public.byeollog_roulette_amount_mappings
  for all to anon, authenticated using (false) with check (false);
revoke all on table public.byeollog_roulette_amount_mappings from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.byeollog_roulette_amount_mappings to service_role;

create index if not exists idx_byeollog_sdk_staging_amount_mapping
  on public.bangsel_collector_staging(workspace_id, balloons)
  where raw_payload->>'source_provider'='soop_chat_sdk';

create or replace function public.apply_roulette_amount_mapping_to_staging_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare v_name text;
begin
  if coalesce(new.raw_payload->>'source_provider','')<>'soop_chat_sdk'
     or coalesce(new.balloons,0)<1
     or jsonb_array_length(coalesce(new.roulette_results,'[]'::jsonb))=0
  then return new; end if;
  select mapping.roulette_name into v_name
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and mapping.balloons=new.balloons;
  if v_name is not null then new.event_name:=v_name; end if;
  return new;
end
$function$;

create or replace function public.sync_staging_roulette_name_to_donation_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if coalesce(new.raw_payload->>'source_provider','')<>'soop_chat_sdk'
     or new.event_name is null
     or jsonb_array_length(coalesce(new.roulette_results,'[]'::jsonb))=0
  then return new; end if;
  if tg_op='UPDATE' and new.event_name is not distinct from old.event_name then
    return new;
  end if;
  if tg_op in ('INSERT','UPDATE') then
    update public.bangsel_donations donation
    set event_name=new.event_name
    where donation.workspace_id=new.workspace_id
      and donation.source_event_key=new.source_uid
      and donation.event_name is distinct from new.event_name;
  end if;
  return new;
end
$function$;

drop trigger if exists apply_roulette_amount_mapping_to_staging on public.bangsel_collector_staging;
create trigger apply_roulette_amount_mapping_to_staging
before insert or update of balloons, roulette_results, event_name
on public.bangsel_collector_staging
for each row execute function public.apply_roulette_amount_mapping_to_staging_v1();

drop trigger if exists sync_staging_roulette_name_to_donation on public.bangsel_collector_staging;
create trigger sync_staging_roulette_name_to_donation
after insert or update of event_name
on public.bangsel_collector_staging
for each row execute function public.sync_staging_roulette_name_to_donation_v1();

create or replace function public.reapply_roulette_amount_mapping_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  update public.bangsel_collector_staging staging
  set event_name=new.roulette_name
  where staging.workspace_id=new.workspace_id
    and staging.balloons=new.balloons
    and staging.raw_payload->>'source_provider'='soop_chat_sdk'
    and jsonb_array_length(coalesce(staging.roulette_results,'[]'::jsonb))>0
    and staging.event_name is distinct from new.roulette_name;
  return new;
end
$function$;

drop trigger if exists reapply_roulette_amount_mapping on public.byeollog_roulette_amount_mappings;
create trigger reapply_roulette_amount_mapping
after insert or update of roulette_name
on public.byeollog_roulette_amount_mappings
for each row execute function public.reapply_roulette_amount_mapping_v1();

revoke all on function public.apply_roulette_amount_mapping_to_staging_v1() from public, anon, authenticated, service_role;
revoke all on function public.sync_staging_roulette_name_to_donation_v1() from public, anon, authenticated, service_role;
revoke all on function public.reapply_roulette_amount_mapping_v1() from public, anon, authenticated, service_role;

comment on table public.byeollog_roulette_amount_mappings is
  'Service-only exact donation amount to external roulette name mapping; result classification remains learned separately.';
