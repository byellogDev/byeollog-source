-- Keep Agent liveness accurate without adding another network request.
--
-- Connected Agents already call this authenticated pending probe every 30
-- seconds as a missed-Realtime recovery fence. Reuse that proof of life to
-- refresh the existing device status at most once per minute. Capability
-- equality prevents a stale or partial probe from extending an incompatible
-- status report, while the two-minute action safety gate remains unchanged.

create or replace function public.g3a_agent_direct_pending_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text,
  p_supported_action_types text[]
)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '3s'
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if cardinality(coalesce(p_supported_action_types, '{}'::text[])) not between 1 and 32
     or exists (
       select 1 from unnest(p_supported_action_types) action_type(value)
       where action_type.value is null
          or action_type.value !~ '^[a-z][a-z0-9_.-]{0,119}$'
     ) then
    raise exception 'agent pending probe parameters are invalid' using errcode = '22023';
  end if;

  perform 1
  from byeollog_automation.agent_direct_runtime_context_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash
  );

  update byeollog_automation.agent_device_status status_row
  set reported_at = v_now
  where status_row.workspace_id = p_workspace_id
    and status_row.device_id = p_device_id
    and status_row.reported_at < v_now - interval '1 minute'
    and status_row.supported_action_types @> p_supported_action_types
    and p_supported_action_types @> status_row.supported_action_types;

  return exists (
    select 1
    from byeollog_automation.executions execution
    where execution.workspace_id = p_workspace_id
      and execution.execution_target = 'local_agent'
      and (
        (execution.status in ('queued', 'retry_scheduled')
          and execution.next_attempt_at <= v_now)
        or (execution.status = 'running' and execution.lease_expires_at <= v_now)
      )
      and execution.attempt_no < execution.max_attempts
      and (execution.agent_device_id is null or execution.agent_device_id = p_device_id)
      and execution.action_type = any(p_supported_action_types)
    limit 1
  );
end
$function$;

revoke all on function public.g3a_agent_direct_pending_v1(uuid,uuid,text,text[])
  from public, anon, authenticated;
grant execute on function public.g3a_agent_direct_pending_v1(uuid,uuid,text,text[])
  to authenticated;

comment on function public.g3a_agent_direct_pending_v1(uuid,uuid,text,text[])
  is 'Authenticated due-action probe and rate-limited Agent liveness refresh; the Edge claim remains the sole lease authority.';
