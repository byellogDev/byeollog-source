create or replace function public.begin_workspace_backup_v1(
  p_workspace_id uuid,
  p_lease_id uuid,
  p_reason text,
  p_lease_seconds integer
)
returns table(lease_id uuid,expires_at timestamptz)
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='3s'
as $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_workspace_id is null or p_lease_id is null
    or p_reason not in ('automatic','manual','pre_restore')
    or p_lease_seconds not between 30 and 3600
  then
    raise exception 'backup lease request is invalid' using errcode='22023';
  end if;

  perform 1 from public.byeollog_workspaces workspace
  where workspace.id=p_workspace_id for update;
  if not found then
    raise exception 'workspace was not found' using errcode='P0002';
  end if;

  delete from public.byeollog_workspace_backup_leases lease
  where lease.workspace_id=p_workspace_id and lease.expires_at<=v_now;
  delete from public.byeollog_account_withdrawal_intents intent
  where intent.expires_at<=v_now;

  if exists(
    select 1 from public.byeollog_account_withdrawal_intents intent
    where intent.workspace_id=p_workspace_id
      and intent.is_workspace_owner
      and intent.expires_at>v_now
  ) then
    raise exception 'account withdrawal is in progress' using errcode='55000';
  end if;
  if exists(
    select 1 from public.byeollog_workspace_backup_leases lease
    where lease.workspace_id=p_workspace_id and lease.expires_at>v_now
  ) then
    raise exception 'workspace backup is already running' using errcode='55P03';
  end if;

  v_expires_at:=v_now+pg_catalog.make_interval(secs=>p_lease_seconds);
  insert into public.byeollog_workspace_backup_leases(
    workspace_id,lease_id,reason,expires_at,created_at,updated_at)
  values(p_workspace_id,p_lease_id,p_reason,v_expires_at,v_now,v_now);
  return query select p_lease_id,v_expires_at;
end
$function$;

revoke all on function public.begin_workspace_backup_v1(uuid,uuid,text,integer)
  from public,anon,authenticated;
grant execute on function public.begin_workspace_backup_v1(uuid,uuid,text,integer)
  to service_role;
