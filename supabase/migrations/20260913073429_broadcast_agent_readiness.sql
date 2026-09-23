-- Called only after Vercel resolves the authenticated user's workspace.
-- No identifiers, device secrets or execution history are returned.
create or replace function public.byeollog_broadcast_agent_readiness_v1(p_workspace_id uuid)
returns jsonb language plpgsql stable security definer
set search_path='' set statement_timeout='3s'
as $function$
declare v_registered integer;v_online integer;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace required' using errcode='22023';
  end if;
  select count(*)::integer,
    count(*) filter(where s.reported_at>=statement_timestamp()-interval '2 minutes'
      and s.reported_at<=statement_timestamp()+interval '30 seconds')::integer
    into v_registered,v_online
  from byeollog_automation.agent_devices d
  join public.byeollog_workspaces w on w.id=d.workspace_id and w.status='active'
  left join byeollog_automation.agent_device_status s on s.workspace_id=d.workspace_id and s.device_id=d.device_id
  where d.workspace_id=p_workspace_id and d.revoked_at is null;
  return jsonb_build_object('state',case when v_online>0 then 'online' when v_registered>0 then 'offline' else 'missing' end,
    'registered',v_registered,'online',v_online);
end;
$function$;
revoke all on function public.byeollog_broadcast_agent_readiness_v1(uuid) from public,anon,authenticated;
grant execute on function public.byeollog_broadcast_agent_readiness_v1(uuid) to service_role;


