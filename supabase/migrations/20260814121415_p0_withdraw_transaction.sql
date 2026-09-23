-- P0: 회원 탈퇴를 하나의 DB 트랜잭션으로 처리한다.
-- 호출자는 service_role 전용이며, 함수는 전달된 user/workspace 소속을 다시 검증한다.
create or replace function public.byeollog_withdraw_account(
  p_user_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  v_role text;
  v_is_owner boolean;
  v_email text;
begin
  if p_user_id is null or p_workspace_id is null then
    raise exception 'user_id and workspace_id are required';
  end if;

  select m.role
    into v_role
  from public.byeollog_workspace_members m
  join public.byeollog_workspaces w on w.id = m.workspace_id
  where m.user_id = p_user_id
    and m.workspace_id = p_workspace_id
  for update of m, w;

  if not found then
    raise exception 'active membership not found';
  end if;

  select lower(u.email) into v_email
  from auth.users u
  where u.id = p_user_id
  for update;

  if not found then
    raise exception 'auth user not found';
  end if;

  select (v_role = 'owner' or w.owner_user_id = p_user_id)
    into v_is_owner
  from public.byeollog_workspaces w
  where w.id = p_workspace_id;

  if v_is_owner then
    delete from public.byeollog_audit_log
      where workspace_id = p_workspace_id or actor_user_id = p_user_id;
    delete from public.bangsel_task_import_items where workspace_id = p_workspace_id;
    delete from public.bangsel_roulette_invalidations where workspace_id = p_workspace_id;
    delete from public.bangsel_collector_staging where workspace_id = p_workspace_id;
    delete from public.bangsel_donations where workspace_id = p_workspace_id;
    delete from public.bangsel_tasks where workspace_id = p_workspace_id;
    delete from public.bangsel_roulette_rules where workspace_id = p_workspace_id;
    delete from public.bangsel_fan_stations where workspace_id = p_workspace_id;
    delete from public.bangsel_fans where workspace_id = p_workspace_id;
    delete from public.byeollog_dashboard_handoffs where workspace_id = p_workspace_id;
    delete from public.byeollog_collector_devices where workspace_id = p_workspace_id;
    delete from public.byeollog_workspace_settings where workspace_id = p_workspace_id;
    delete from public.byeollog_workspace_members where workspace_id = p_workspace_id;
    delete from public.byeollog_workspaces where id = p_workspace_id;
  else
    delete from public.byeollog_audit_log where actor_user_id = p_user_id;
    delete from public.byeollog_workspace_members
      where workspace_id = p_workspace_id and user_id = p_user_id;
  end if;

  delete from public.byeollog_signup_applications
    where auth_user_id = p_user_id or lower(email) = v_email;

  -- auth.users의 종속 세션·identity는 ON DELETE CASCADE로 함께 제거된다.
  delete from auth.users where id = p_user_id;
  if not found then
    raise exception 'auth user delete failed';
  end if;

  return jsonb_build_object(
    'ok', true,
    'workspace_deleted', v_is_owner,
    'user_deleted', true
  );
end;
$$;

revoke all on function public.byeollog_withdraw_account(uuid, uuid) from public, anon, authenticated;
grant execute on function public.byeollog_withdraw_account(uuid, uuid) to service_role;

