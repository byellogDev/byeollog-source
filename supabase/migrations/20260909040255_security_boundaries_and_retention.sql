-- Additive protection only; no donation, task, or active OAuth record is removed.
set local lock_timeout='2s';
set local statement_timeout='20s';

alter table public.bangsel_tasks add constraint bangsel_tasks_workspace_id_id_security_key unique(workspace_id,id);
alter table public.bangsel_task_import_items add constraint bangsel_import_task_workspace_security_fk
 foreign key(workspace_id,task_id) references public.bangsel_tasks(workspace_id,id) on delete cascade not valid;
alter table public.bangsel_task_import_items validate constraint bangsel_import_task_workspace_security_fk;

create schema if not exists byeollog_private;
revoke all on schema byeollog_private from public,anon,authenticated;
create table byeollog_private.workspace_slug_reservations(
 slug text primary key,
 workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
 created_at timestamptz not null default clock_timestamp()
);
alter table byeollog_private.workspace_slug_reservations enable row level security;
revoke all on byeollog_private.workspace_slug_reservations from public,anon,authenticated;
insert into byeollog_private.workspace_slug_reservations(slug,workspace_id)
 select lower(slug),id from public.byeollog_workspaces;
-- The permanent web redirect already routes this previous public URL here.
insert into byeollog_private.workspace_slug_reservations(slug,workspace_id)
 select 'observer_b_alias',id from public.byeollog_workspaces where slug='observer_b' and soop_id='observer_b'
 on conflict(slug) do nothing;
create function byeollog_private.reserve_workspace_slug_security_v1() returns trigger
 language plpgsql security definer set search_path='' as $$
declare reserved_owner uuid;
begin
 insert into byeollog_private.workspace_slug_reservations(slug,workspace_id)
 values(lower(new.slug),new.id) on conflict(slug) do nothing;
 select workspace_id into reserved_owner from byeollog_private.workspace_slug_reservations where slug=lower(new.slug);
 if reserved_owner is distinct from new.id then
  raise exception using errcode='23505',message='Workspace address is already reserved';
 end if;
 return new;
end $$;
revoke all on function byeollog_private.reserve_workspace_slug_security_v1() from public,anon,authenticated;
create trigger workspace_slug_security_reservation after insert or update of slug on public.byeollog_workspaces
 for each row execute function byeollog_private.reserve_workspace_slug_security_v1();

select cron.schedule('byeollog-expired-signup-security-v1','*/5 * * * *',$job$
 with expired as (
  select id from public.byeollog_soop_signup_oauth_pending
  where expires_at < clock_timestamp()-interval '1 hour'
  order by expires_at limit 1000 for update skip locked
 ) delete from public.byeollog_soop_signup_oauth_pending p using expired e where p.id=e.id;
$job$);


