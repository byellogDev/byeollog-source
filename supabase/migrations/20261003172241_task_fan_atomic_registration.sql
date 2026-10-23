begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

-- Keep the composite workspace FK. A new fan and its task commit or roll back
-- together, without elevating the caller or overwriting existing fan metadata.
create function private.ensure_task_fan_v1()
returns trigger language plpgsql security invoker set search_path='' as $fn$
begin
 if new.fan_soop_id is null then return new; end if;
 if exists(select 1 from public.bangsel_fans
           where workspace_id=new.workspace_id and soop_id=new.fan_soop_id) then
  return new;
 end if;
 insert into public.bangsel_fans(workspace_id,soop_id,alias,current_nickname,station_url)
 values(new.workspace_id,new.fan_soop_id,
        coalesce(nullif(btrim(new.fan),''),new.fan_soop_id),
        coalesce(nullif(btrim(new.fan),''),new.fan_soop_id),
        case when new.fan_soop_id ~ '^[a-zA-Z0-9_-]+$'
             then 'https://www.sooplive.com/station/'||new.fan_soop_id end)
 on conflict(workspace_id,soop_id) do nothing;
 return new;
end $fn$;
revoke all on function private.ensure_task_fan_v1() from public,anon,authenticated,service_role;
create trigger ensure_task_fan_v1
 before insert or update of fan_soop_id,workspace_id on public.bangsel_tasks
 for each row execute function private.ensure_task_fan_v1();

commit;
