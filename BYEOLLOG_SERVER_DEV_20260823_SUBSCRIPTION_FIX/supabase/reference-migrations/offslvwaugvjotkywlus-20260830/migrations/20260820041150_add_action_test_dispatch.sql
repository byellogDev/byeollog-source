-- 별록 액션 카드에서 확인 후 실제 로컬 Agent 실행 큐로 1회 테스트를 보냅니다.
-- 규칙이나 사용자 데이터를 바꾸지 않고, 실행 이력에는 manual_test 이벤트로 남깁니다.

create or replace function byeollog_automation.dispatch_guided_rule_test_v1_impl(
  p_workspace_id uuid,
  p_rule_id uuid,
  p_expected_version integer
)
returns table(
  event_id uuid,
  execution_id uuid,
  action_type text,
  agent_device_id uuid
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_requester_id uuid;
  v_action byeollog_automation.rule_actions%rowtype;
  v_event_id uuid := extensions.gen_random_uuid();
  v_execution_id uuid := extensions.gen_random_uuid();
  v_external_event_id text;
  v_plan_token text;
  v_idempotency_key text;
  v_now timestamptz := clock_timestamp();
begin
  v_requester_id := byeollog_automation.assert_canary_manager_v1(p_workspace_id);

  if p_rule_id is null or p_expected_version is null or p_expected_version < 1 then
    raise exception 'action test identity is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'byeollog-action-test:' || p_workspace_id::text || ':' || p_rule_id::text,
      3320
    )
  );

  if not exists (
    select 1
    from public.rules as public_rule
    where public_rule.id = p_rule_id
      and public_rule.workspace_id = p_workspace_id
      and public_rule.superseded_at is null
      and public_rule.version_number = p_expected_version
  ) then
    if exists (
      select 1
      from public.rules as stale_rule
      where stale_rule.id = p_rule_id
        and stale_rule.workspace_id = p_workspace_id
    ) then
      raise exception 'action test rule version changed' using errcode = '40001';
    end if;
    raise exception 'action test rule was not found' using errcode = 'P0002';
  end if;

  select runtime_action.*
    into strict v_action
  from byeollog_automation.rule_actions as runtime_action
  join byeollog_automation.rules as runtime_rule
    on runtime_rule.id = runtime_action.rule_id
  where runtime_rule.workspace_id = p_workspace_id
    and runtime_rule.id = p_rule_id
    and runtime_action.position = 0;

  if v_action.execution_target <> 'local_agent'
     or v_action.action_type not in ('obs.mute_for', 'windows.mic_mute_for')
     or v_action.agent_device_id is null then
    raise exception 'this action does not support broadcast testing' using errcode = '22023';
  end if;

  if not exists (
    select 1
    from byeollog_automation.agent_devices as device
    where device.workspace_id = p_workspace_id
      and device.device_id = v_action.agent_device_id
      and device.revoked_at is null
  ) then
    raise exception 'the action agent device is unavailable' using errcode = 'P0002';
  end if;

  if not exists (
    select 1
    from byeollog_automation.agent_device_status as device_status
    where device_status.workspace_id = p_workspace_id
      and device_status.device_id = v_action.agent_device_id
      and device_status.reported_at > v_now - interval '2 minutes'
      and v_action.action_type = any(device_status.supported_action_types)
  ) then
    raise exception 'the action agent device is not currently online' using errcode = 'PT409';
  end if;

  if exists (
    select 1
    from byeollog_automation.executions as pending_execution
    join byeollog_automation.events as pending_event
      on pending_event.id = pending_execution.event_id
    where pending_execution.workspace_id = p_workspace_id
      and pending_execution.rule_id = p_rule_id
      and pending_event.source = 'manual_test'
      and pending_execution.status in ('queued', 'running', 'retry_scheduled')
      and pending_execution.created_at >= v_now - interval '30 seconds'
  ) then
    raise exception 'an action test is already pending' using errcode = '55000';
  end if;

  v_external_event_id := 'action-test-' || v_event_id::text;
  v_plan_token := encode(
    extensions.digest(
      pg_catalog.convert_to(
        'action-test-v1|' || p_workspace_id::text || '|' || p_rule_id::text || '|' || v_event_id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_idempotency_key := encode(
    extensions.digest(
      pg_catalog.convert_to(
        'action-test-execution-v1|' || p_workspace_id::text || '|' || v_execution_id::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  insert into byeollog_automation.events(
    id, workspace_id, schema_version, external_event_id, source, platform,
    event_type, subtype, actor, amount, currency, payload, raw, correlation_id,
    occurred_at, received_at, authorized_user_id, plan_token,
    evaluated_rule_ids, matched_rule_ids
  ) values (
    v_event_id, p_workspace_id, '1.0', v_external_event_id, 'manual_test',
    'byeollog', 'action_test', v_action.action_type,
    jsonb_build_object('display_name', '별록 액션 테스트'),
    null, null,
    jsonb_build_object('test', true, 'rule_id', p_rule_id, 'requested_at', v_now),
    null, 'action-test:' || v_event_id::text, v_now, v_now, v_requester_id,
    v_plan_token, array[p_rule_id], array[p_rule_id]
  );

  insert into byeollog_automation.executions(
    id, workspace_id, event_id, rule_id, action_id, idempotency_key,
    execution_target, agent_device_id, action_type, action_params, timeout_ms,
    max_attempts, retry_backoff_seconds
  ) values (
    v_execution_id, p_workspace_id, v_event_id, p_rule_id, v_action.id,
    v_idempotency_key, v_action.execution_target, v_action.agent_device_id,
    v_action.action_type, v_action.params, v_action.timeout_ms, 1,
    v_action.retry_backoff_seconds
  );

  return query
  select v_event_id, v_execution_id, v_action.action_type, v_action.agent_device_id;
exception
  when no_data_found or too_many_rows then
    raise exception 'action test rule snapshot is invalid' using errcode = 'P0002';
end;
$$;

create or replace function public.dispatch_guided_rule_test_v1(
  p_workspace_id uuid,
  p_rule_id uuid,
  p_expected_version integer
)
returns table(
  event_id uuid,
  execution_id uuid,
  action_type text,
  agent_device_id uuid
)
language sql
set search_path = ''
as $$
  select *
  from byeollog_automation.dispatch_guided_rule_test_v1_impl(
    p_workspace_id,
    p_rule_id,
    p_expected_version
  )
$$;

revoke all on function byeollog_automation.dispatch_guided_rule_test_v1_impl(uuid, uuid, integer)
  from public, anon;
revoke all on function public.dispatch_guided_rule_test_v1(uuid, uuid, integer)
  from public, anon;
grant execute on function byeollog_automation.dispatch_guided_rule_test_v1_impl(uuid, uuid, integer)
  to authenticated;
grant execute on function public.dispatch_guided_rule_test_v1(uuid, uuid, integer)
  to authenticated;;
