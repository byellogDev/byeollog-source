-- Keep the public automation readiness gate strict without making it brittle.
create or replace function public.g3a_automation_schema_readiness_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid
)
returns table(
  ready boolean,
  revision text,
  project_ref text,
  workspace_id uuid,
  authorized_user_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_ready boolean := false;
  v_spec text;
  v_rpc oid;
  v_rpc_ok boolean;
  v_required_rpcs text[] := array[
    'public.g3a_assert_active_auth_session_v1(uuid,uuid)',
    'public.g3a_assert_runtime_active_v1(uuid,uuid,uuid,text,text,text)',
    'public.g3a_authenticate_agent_device_v1(uuid,uuid,text,uuid,uuid,text,text,text)',
    'public.g3a_automation_schema_readiness_v1(uuid,uuid)',
    'public.g3a_load_automation_plan_v1(uuid,uuid,uuid,text,text,text)',
    'public.g3a_commit_event_plan_v1(uuid,jsonb,uuid,uuid,text,text,text,text,uuid[],uuid[],uuid[])',
    'public.g3a_claim_execution_v1(uuid,text,integer,uuid[],text,uuid,text,text[],uuid,uuid,text,text,text)',
    'public.g3a_renew_execution_v1(uuid,uuid,text,integer,integer,uuid,text,uuid,uuid,text,text,text)',
    'public.g3a_finish_execution_v1(uuid,uuid,text,integer,boolean,jsonb,text,boolean,uuid,text,uuid,uuid,text,text,text)',
    'public.g3a_register_agent_device_v1(uuid,uuid,text,text,uuid,uuid,bigint,text,text,text,text)',
    'public.g3a_rotate_agent_device_secret_v1(uuid,uuid,text,text,uuid,uuid,text,text,text)',
    'public.g3a_report_agent_status_v1(uuid,uuid,text,text,text,text[],uuid,uuid,text,text,text)'
  ];
begin
  if p_workspace_id is not null and p_authorized_user_id is not null then
    select exists (
      select 1
      from byeollog_automation.release_gate rg
      join byeollog_automation.workspace_gates wg
        on wg.workspace_id = p_workspace_id
      join public.byeollog_workspaces w
        on w.id = wg.workspace_id and w.status = 'active'
      join public.byeollog_workspace_members m
        on m.workspace_id = w.id
       and m.user_id = p_authorized_user_id
       and m.role in ('owner','manager')
      where rg.gate_id = 1
        and rg.enabled
        and rg.project_ref = 'offslvwaugvjotkywlus'
        and rg.db_revision = 'offsl-vnext-g3a-v1'
        and rg.evidence_sha256 is not null
        and wg.enabled
        and wg.evidence_sha256 is not null
    ) into v_ready;
  end if;

  if v_ready then
    if exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
      where n.nspname = 'public'
        and p.proname like 'g3a\_%' escape '\'
        and not (
          owner_role.rolname = 'postgres'
          and p.prokind = 'f'
          and p.prosecdef
          and p.proconfig @> array['search_path=""']::text[]
          and exists (
            select 1 from unnest(p.proconfig) as cfg(value)
            where cfg.value like 'statement_timeout=%'
          )
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
          and not exists (
            select 1
            from pg_catalog.aclexplode(
              coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) acl
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> p.proowner
              and acl.grantee <> (
                select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role'
              )
          )
        )
    ) then
      v_ready := false;
    end if;

    foreach v_spec in array v_required_rpcs loop
      exit when not v_ready;
      v_rpc := to_regprocedure(v_spec);
      if v_rpc is null then
        v_ready := false;
        exit;
      end if;

      select exists (
        select 1
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
        where p.oid = v_rpc
          and n.nspname = 'public'
          and owner_role.rolname = 'postgres'
          and p.prokind = 'f'
          and p.prosecdef
          and p.proconfig @> array['search_path=""']::text[]
          and exists (
            select 1 from unnest(p.proconfig) as cfg(value)
            where cfg.value like 'statement_timeout=%'
          )
          and pg_catalog.has_function_privilege('service_role', p.oid, 'EXECUTE')
          and not exists (
            select 1
            from pg_catalog.aclexplode(
              coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) acl
            where acl.privilege_type = 'EXECUTE'
              and acl.grantee <> p.proowner
              and acl.grantee <> (
                select r.oid from pg_catalog.pg_roles r where r.rolname = 'service_role'
              )
          )
      ) into v_rpc_ok;
      v_ready := v_ready and coalesce(v_rpc_ok, false);
    end loop;
  end if;

  return query select
    v_ready,
    'offsl-vnext-g3a-v1'::text,
    'offslvwaugvjotkywlus'::text,
    p_workspace_id,
    p_authorized_user_id;
end;
$function$;

alter function public.g3a_automation_schema_readiness_v1(uuid,uuid) owner to postgres;
revoke all on function public.g3a_automation_schema_readiness_v1(uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.g3a_automation_schema_readiness_v1(uuid,uuid)
  to service_role;

notify pgrst, 'reload schema';
