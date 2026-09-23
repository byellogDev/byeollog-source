begin;
set local lock_timeout='3s';
create table public.byeollog_task_completion_history (
 id uuid primary key default gen_random_uuid(),
 workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
 task_id uuid not null,
 fan text not null, fan_soop_id text, event text not null, type text not null,
 before_done integer not null, after_done integer not null,
 before_total integer not null, after_total integer not null,
 change_kind text not null check(change_kind in ('completion','undo','restore')),
 occurred_at timestamptz not null default clock_timestamp(),
 check(before_done<>after_done)
);
create index task_completion_history_workspace_order on public.byeollog_task_completion_history(workspace_id,occurred_at desc,id desc);
alter table public.byeollog_task_completion_history enable row level security;
revoke all on public.byeollog_task_completion_history from public,anon,authenticated,service_role;
grant select on public.byeollog_task_completion_history to service_role;
comment on table public.byeollog_task_completion_history is 'Private per-workspace task completion quantity changes. Server timestamps, no historical backfill. Snapshots survive task deletion; workspace deletion cascades.';
create or replace function private.record_task_completion_history_v1()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into public.byeollog_task_completion_history(workspace_id,task_id,fan,fan_soop_id,event,type,before_done,after_done,before_total,after_total,change_kind)
 values(new.workspace_id,new.id,coalesce(new.fan,''),new.fan_soop_id,coalesce(new.event,''),coalesce(new.type,''),coalesce(old.done_qty,0),coalesce(new.done_qty,0),coalesce(old.total_qty,0),coalesce(new.total_qty,0),
 case when current_setting('request.path',true)='/rpc/byeollog_restore_backup_v1' then 'restore'
 when coalesce(new.done_qty,0)>coalesce(old.done_qty,0) then 'completion' else 'undo' end);
 return new;
end $$;
revoke all on function private.record_task_completion_history_v1() from public,anon,authenticated,service_role;
create trigger record_task_completion_history after update on public.bangsel_tasks
 for each row when (coalesce(old.done_qty,0) is distinct from coalesce(new.done_qty,0))
 execute function private.record_task_completion_history_v1();
notify pgrst,'reload schema';
commit;
