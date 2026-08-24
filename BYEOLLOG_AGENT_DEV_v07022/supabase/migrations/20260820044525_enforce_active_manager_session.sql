-- Reject a still-valid JWT after its backing Supabase Auth session has ended.
-- This is a non-destructive replacement of the internal manager assertion;
-- all workspace role checks and its private EXECUTE ACL remain unchanged.
create or replace function byeollog_automation.assert_canary_manager_v1(
  p_workspace_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $$
declare
  v_uid uuid := auth.uid();
  v_session_id uuid;
begin
  if p_workspace_id is null or v_uid is null then
    raise exception 'workspace manager session required' using errcode='42501';
  end if;

  begin
    v_session_id := nullif(auth.jwt()->>'session_id','')::uuid;
  exception when others then
    raise exception 'active auth session required' using errcode='42501';
  end;

  if v_session_id is null
     or not public.g3a_assert_active_auth_session_v1(v_uid, v_session_id) then
    raise exception 'active auth session required' using errcode='42501';
  end if;

  if not exists (
    select 1
    from public.byeollog_workspaces w
    join public.byeollog_workspace_members lm
      on lm.workspace_id=w.id and lm.user_id=v_uid and lm.role in ('owner','manager')
    join public.workspace_members am
      on am.workspace_id=lm.workspace_id and am.user_id=lm.user_id
       and am.role in ('owner','admin')
    where w.id=p_workspace_id and w.status='active'
  ) then
    raise exception 'active workspace manager membership required' using errcode='42501';
  end if;

  return v_uid;
end;
$$;

revoke all on function byeollog_automation.assert_canary_manager_v1(uuid) from public;
revoke all on function byeollog_automation.assert_canary_manager_v1(uuid) from anon;
revoke all on function byeollog_automation.assert_canary_manager_v1(uuid) from authenticated;
