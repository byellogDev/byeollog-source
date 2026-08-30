-- Fix runtime PL/pgSQL ambiguity between RETURNS TABLE workspace_id and the
-- workspace_members conflict target. No gate or user data is changed here.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

create or replace function public.byeollog_ensure_automation_workspace_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_release_evidence text
)
returns table(
  workspace_id uuid,
  authorized_user_id uuid,
  enabled boolean,
  revision text,
  project_ref text
)
language plpgsql
volatile
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_release byeollog_automation.release_gate%rowtype;
  v_enabled boolean;
begin
  if p_workspace_id is null or p_authorized_user_id is null
     or p_release_evidence <> '472aeddc19d84a1b236e4edc3dcaf6922563ec70de2081f509264ff5656ab273' then
    raise exception 'public automation enrollment denied' using errcode='42501';
  end if;

  select g.* into v_release
  from byeollog_automation.release_gate g
  where g.gate_id=1
  for share;
  if not found or not v_release.enabled
     or v_release.project_ref <> 'offslvwaugvjotkywlus'
     or v_release.db_revision <> 'offsl-vnext-g3a-v1'
     or v_release.evidence_sha256 <> p_release_evidence then
    raise exception 'public automation release is inactive' using errcode='55000';
  end if;

  perform 1
  from public.byeollog_workspaces w
  join public.byeollog_workspace_members m
    on m.workspace_id=w.id and m.user_id=p_authorized_user_id and m.role='owner'
  where w.id=p_workspace_id and w.status='active'
  for share of w,m;
  if not found then
    raise exception 'active workspace owner membership required' using errcode='42501';
  end if;

  insert into public.workspace_members(workspace_id,user_id,role)
  values(p_workspace_id,p_authorized_user_id,'owner')
  on conflict on constraint workspace_members_pkey do update set role='owner';

  insert into byeollog_automation.workspace_gates(
    workspace_id,enabled,evidence_sha256,enrolled_by,enabled_at,disabled_at,
    changed_by,changed_at
  ) values (
    p_workspace_id,true,p_release_evidence,p_authorized_user_id,
    clock_timestamp(),null,p_authorized_user_id,clock_timestamp()
  ) on conflict (workspace_id) do nothing;

  select g.enabled into v_enabled
  from byeollog_automation.workspace_gates g
  where g.workspace_id=p_workspace_id;

  return query select p_workspace_id,p_authorized_user_id,coalesce(v_enabled,false),
    v_release.db_revision,v_release.project_ref;
end;
$function$;

revoke all on function public.byeollog_ensure_automation_workspace_v1(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.byeollog_ensure_automation_workspace_v1(uuid,uuid,text)
  to service_role;

notify pgrst,'reload schema';
commit;
;
