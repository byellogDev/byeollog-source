-- Event-driven Agent wake channel.
-- Realtime carries only a wake hint; the existing authenticated claim RPC remains
-- the sole authority that selects and leases an execution.

create or replace function byeollog_automation.can_receive_agent_wake_v1(
  p_topic text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    p_topic ~ '^agent-wake:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    and exists (
      select 1
      from public.byeollog_workspace_members member_row
      join byeollog_automation.agent_devices device_row
        on device_row.workspace_id = member_row.workspace_id
       and device_row.revoked_at is null
      where member_row.user_id = (select auth.uid())
        and member_row.workspace_id = split_part(p_topic, ':', 2)::uuid
    );
$$

revoke all on function byeollog_automation.can_receive_agent_wake_v1(text)
  from public, anon, authenticated

grant usage on schema byeollog_automation to authenticated

grant execute on function byeollog_automation.can_receive_agent_wake_v1(text)
  to authenticated

drop policy if exists byeollog_agent_wake_receive_v1 on realtime.messages

create policy byeollog_agent_wake_receive_v1
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and byeollog_automation.can_receive_agent_wake_v1((select realtime.topic()))
)

create or replace function byeollog_automation.broadcast_agent_execution_wake_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.execution_target <> 'local_agent'
     or new.status not in ('queued', 'retry_scheduled') then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and old.status is not distinct from new.status
     and old.next_attempt_at is not distinct from new.next_attempt_at
     and old.agent_device_id is not distinct from new.agent_device_id then
    return new;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('notBefore', new.next_attempt_at),
      'execution_changed',
      'agent-wake:' || new.workspace_id::text,
      true
    );
  exception when others then
    -- A wake hint must never make action enqueue/retry fail. The Agent retains a
    -- bounded authenticated polling fallback for this exact failure mode.
    raise warning 'agent execution wake broadcast failed: %', sqlstate;
  end;
  return new;
end;
$$

revoke all on function byeollog_automation.broadcast_agent_execution_wake_v1()
  from public, anon, authenticated

grant execute on function byeollog_automation.broadcast_agent_execution_wake_v1()
  to service_role

drop trigger if exists broadcast_agent_execution_wake_v1
  on byeollog_automation.executions

create trigger broadcast_agent_execution_wake_v1
after insert or update of status, next_attempt_at, agent_device_id
on byeollog_automation.executions
for each row
execute function byeollog_automation.broadcast_agent_execution_wake_v1()

create or replace function byeollog_automation.broadcast_agent_wallpaper_wake_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.revision is not distinct from new.revision then
    return new;
  end if;

  begin
    perform realtime.send(
      jsonb_build_object('revision', new.revision),
      'wallpaper_changed',
      'agent-wake:' || new.workspace_id::text,
      true
    );
  exception when others then
    raise warning 'agent wallpaper wake broadcast failed: %', sqlstate;
  end;
  return new;
end;
$$

revoke all on function byeollog_automation.broadcast_agent_wallpaper_wake_v1()
  from public, anon, authenticated

grant execute on function byeollog_automation.broadcast_agent_wallpaper_wake_v1()
  to service_role

drop trigger if exists broadcast_agent_wallpaper_wake_v1
  on public.byeollog_wallpaper_overlay_states

create trigger broadcast_agent_wallpaper_wake_v1
after insert or update of revision
on public.byeollog_wallpaper_overlay_states
for each row
execute function byeollog_automation.broadcast_agent_wallpaper_wake_v1()
