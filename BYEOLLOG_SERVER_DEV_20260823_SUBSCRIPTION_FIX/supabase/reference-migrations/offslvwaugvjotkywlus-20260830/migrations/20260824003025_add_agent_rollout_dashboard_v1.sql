-- Agent 배포 현황은 Vercel 서버의 검증된 관리자 세션을 통해서만 읽는다.
-- 브라우저/일반 authenticated 사용자는 이 RPC를 직접 호출할 수 없다.
create or replace function public.get_agent_rollout_dashboard_v1(
  p_workspace_id uuid,
  p_include_all_workspaces boolean default false,
  p_recent_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_limit integer;
  v_now timestamptz:=clock_timestamp();
  v_result jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'service role required' using errcode='42501';
  end if;
  if p_workspace_id is null then
    raise exception 'workspace required' using errcode='22023';
  end if;
  v_limit:=least(greatest(coalesce(p_recent_limit,50),1),100);

  with scoped_workspaces as (
    select w.id,w.display_name,w.slug
    from public.byeollog_workspaces w
    where w.status='active'
      and (p_include_all_workspaces or w.id=p_workspace_id)
  ),
  last_success as (
    select e.workspace_id,e.agent_device_id,max(e.created_at) as succeeded_at
    from byeollog_automation.executions e
    join scoped_workspaces sw on sw.id=e.workspace_id
    where e.agent_device_id is not null and e.status='succeeded'
    group by e.workspace_id,e.agent_device_id
  ),
  execution_metrics as (
    select e.workspace_id,e.agent_device_id,
      count(*) filter (where e.created_at>=v_now-interval '7 days')::integer as recent_count,
      count(*) filter (where e.created_at>=v_now-interval '7 days' and e.status='succeeded')::integer as succeeded_count,
      count(*) filter (where e.created_at>=v_now-interval '7 days' and e.status='failed')::integer as failed_count,
      count(*) filter (where e.status in ('queued','running','retry_scheduled'))::integer as pending_count,
      count(*) filter (
        where e.status='failed'
          and e.created_at>coalesce(ls.succeeded_at,'-infinity'::timestamptz)
      )::integer as consecutive_failure_count
    from byeollog_automation.executions e
    join scoped_workspaces sw on sw.id=e.workspace_id
    left join last_success ls
      on ls.workspace_id=e.workspace_id and ls.agent_device_id=e.agent_device_id
    where e.agent_device_id is not null
    group by e.workspace_id,e.agent_device_id
  ),
  latest_execution as (
    select distinct on (e.workspace_id,e.agent_device_id)
      e.workspace_id,e.agent_device_id,e.id,e.status,e.action_type,e.attempt_no,
      e.created_at,e.started_at,e.finished_at
    from byeollog_automation.executions e
    join scoped_workspaces sw on sw.id=e.workspace_id
    where e.agent_device_id is not null
    order by e.workspace_id,e.agent_device_id,e.created_at desc,e.id desc
  ),
  device_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'workspaceId',d.workspace_id,
      'workspaceName',sw.display_name,
      'workspaceSlug',sw.slug,
      'deviceId',d.device_id,
      'displayName',d.device_name,
      'registeredAt',d.registered_at,
      'lastSeenAt',d.last_seen_at,
      'lastReportedAt',s.reported_at,
      'revokedAt',d.revoked_at,
      'agentVersion',s.agent_version,
      'platform',s.platform,
      'connectionState',case
        when d.revoked_at is not null then 'revoked'
        when s.reported_at>=v_now-interval '2 minutes' then 'online'
        when s.reported_at is null then 'never_reported'
        when d.last_seen_at>=v_now-interval '24 hours' then 'idle'
        else 'offline' end,
      'recentExecutionCount',coalesce(em.recent_count,0),
      'succeededCount',coalesce(em.succeeded_count,0),
      'failedCount',coalesce(em.failed_count,0),
      'pendingCount',coalesce(em.pending_count,0),
      'consecutiveFailureCount',coalesce(em.consecutive_failure_count,0),
      'latestExecution',case when le.id is null then null else jsonb_build_object(
        'id',le.id,
        'workspaceId',d.workspace_id,
        'workspaceName',sw.display_name,
        'deviceId',d.device_id,
        'deviceName',d.device_name,
        'status',le.status,
        'actionType',le.action_type,
        'attemptNo',le.attempt_no,
        'createdAt',le.created_at,
        'startedAt',le.started_at,
        'finishedAt',le.finished_at
      ) end
    ) order by
      case when d.revoked_at is null and s.reported_at>=v_now-interval '2 minutes' then 0 else 1 end,
      coalesce(s.reported_at,d.last_seen_at,d.registered_at) desc,d.device_id), '[]'::jsonb) as value
    from byeollog_automation.agent_devices d
    join scoped_workspaces sw on sw.id=d.workspace_id
    left join byeollog_automation.agent_device_status s
      on s.workspace_id=d.workspace_id and s.device_id=d.device_id
    left join execution_metrics em
      on em.workspace_id=d.workspace_id and em.agent_device_id=d.device_id
    left join latest_execution le
      on le.workspace_id=d.workspace_id and le.agent_device_id=d.device_id
  ),
  recent_payload as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',recent.id,
      'workspaceId',recent.workspace_id,
      'workspaceName',recent.workspace_name,
      'deviceId',recent.agent_device_id,
      'deviceName',recent.device_name,
      'status',recent.status,
      'actionType',recent.action_type,
      'attemptNo',recent.attempt_no,
      'createdAt',recent.created_at,
      'startedAt',recent.started_at,
      'finishedAt',recent.finished_at
    ) order by recent.created_at desc,recent.id desc), '[]'::jsonb) as value
    from (
      select e.id,e.workspace_id,sw.display_name as workspace_name,e.agent_device_id,
        d.device_name,e.status,e.action_type,e.attempt_no,e.created_at,e.started_at,e.finished_at
      from byeollog_automation.executions e
      join scoped_workspaces sw on sw.id=e.workspace_id
      left join byeollog_automation.agent_devices d
        on d.workspace_id=e.workspace_id and d.device_id=e.agent_device_id
      where e.execution_target='local_agent' and e.agent_device_id is not null
      order by e.created_at desc,e.id desc
      limit v_limit
    ) recent
  )
  select jsonb_build_object(
    'generatedAt',v_now,
    'scope',case when p_include_all_workspaces then 'platform' else 'workspace' end,
    'devices',device_payload.value,
    'recentExecutions',recent_payload.value
  ) into v_result
  from device_payload cross join recent_payload;

  return coalesce(v_result,jsonb_build_object(
    'generatedAt',v_now,'scope','workspace','devices','[]'::jsonb,'recentExecutions','[]'::jsonb));
end;
$function$;

revoke all on function public.get_agent_rollout_dashboard_v1(uuid,boolean,integer)
  from public,anon,authenticated;
grant execute on function public.get_agent_rollout_dashboard_v1(uuid,boolean,integer)
  to service_role;

;
