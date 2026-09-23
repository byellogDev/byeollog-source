-- Authenticated low-cost Agent transport.
--
-- The latency-sensitive action lease/ACK path intentionally remains on the
-- existing Edge runtime.  These RPCs move only idle recovery probes,
-- telemetry, and wallpaper snapshots to PostgREST so 100 connected Agents do
-- not spend the Edge Function invocation allowance while they are idle.
-- Device secrets are hashed by the Agent before transport and every RPC is
-- additionally bound to the live Supabase auth session, workspace manager
-- membership, release gate, and active registered device.

create or replace function byeollog_automation.agent_direct_runtime_context_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text
)
returns table (
  authorized_user_id uuid,
  session_id uuid,
  runtime_revision text,
  db_revision text
)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_user_id uuid := (select auth.uid());
  v_session_id uuid;
  v_release byeollog_automation.release_gate%rowtype;
begin
  begin
    v_session_id := nullif(auth.jwt()->>'session_id', '')::uuid;
  exception when others then
    raise exception 'agent direct session is invalid' using errcode = '28000';
  end;

  if p_workspace_id is null or p_device_id is null
     or p_device_secret_hash is null
     or p_device_secret_hash !~ '^[0-9a-f]{64}$'
     or v_user_id is null or v_session_id is null then
    raise exception 'agent direct authentication failed' using errcode = '28000';
  end if;

  select gate.* into v_release
  from byeollog_automation.release_gate gate
  where gate.gate_id = 1;

  if not found or not v_release.enabled
     or v_release.project_ref <> 'offslvwaugvjotkywlus'
     or v_release.db_revision <> 'offsl-vnext-g3a-v1'
     or v_release.agent_runtime_revision <> 'offsl-agent-runtime-g3a-v1'
     or v_release.evidence_sha256 is null then
    raise exception 'automation runtime unavailable' using errcode = 'BLR03';
  end if;

  -- Reuse the production authorization boundary.  This validates the active
  -- auth.sessions row, workspace gate/membership, and current-or-grace device
  -- secret without exposing any underlying table through the Data API.
  perform public.g3a_authenticate_agent_device_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash,
    v_user_id,
    v_session_id,
    'agent_runtime',
    v_release.agent_runtime_revision,
    v_release.db_revision
  );

  return query select
    v_user_id,
    v_session_id,
    v_release.agent_runtime_revision,
    v_release.db_revision;
end
$function$;

revoke all on function byeollog_automation.agent_direct_runtime_context_v1(uuid,uuid,text)
  from public, anon, authenticated;

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

create or replace function public.g3a_agent_direct_report_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text,
  p_agent_version text,
  p_platform text,
  p_supported_action_types text[],
  p_collection_state text,
  p_session_started_at timestamptz,
  p_last_observed_at timestamptz,
  p_last_upload_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_context record;
  v_reported_at timestamptz;
  v_collection_reported_at timestamptz;
begin
  select context.* into strict v_context
  from byeollog_automation.agent_direct_runtime_context_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash
  ) context;

  v_reported_at := public.g3a_report_agent_status_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash,
    p_agent_version,
    p_platform,
    p_supported_action_types,
    v_context.authorized_user_id,
    v_context.session_id,
    'agent_runtime',
    v_context.runtime_revision,
    v_context.db_revision
  );

  v_collection_reported_at := public.g3a_report_collection_health_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash,
    p_collection_state,
    p_session_started_at,
    p_last_observed_at,
    p_last_upload_at,
    v_context.authorized_user_id,
    v_context.session_id,
    'agent_runtime',
    v_context.runtime_revision,
    v_context.db_revision
  );

  return jsonb_build_object(
    'deviceId', p_device_id,
    'reportedAt', v_reported_at,
    'collectionReportedAt', v_collection_reported_at
  );
end
$function$;

revoke all on function public.g3a_agent_direct_report_v1(
  uuid,uuid,text,text,text,text[],text,timestamptz,timestamptz,timestamptz
) from public, anon, authenticated;
grant execute on function public.g3a_agent_direct_report_v1(
  uuid,uuid,text,text,text,text[],text,timestamptz,timestamptz,timestamptz
) to authenticated;

create or replace function public.g3a_agent_direct_wallpaper_snapshot_v1(
  p_workspace_id uuid,
  p_known_revision bigint,
  p_device_id uuid,
  p_device_secret_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_context record;
begin
  select context.* into strict v_context
  from byeollog_automation.agent_direct_runtime_context_v1(
    p_workspace_id,
    p_device_id,
    p_device_secret_hash
  ) context;

  return public.g3a_get_wallpaper_snapshot_v1(
    p_workspace_id,
    p_known_revision,
    p_device_id,
    p_device_secret_hash,
    v_context.authorized_user_id,
    v_context.session_id,
    'agent_runtime',
    v_context.runtime_revision,
    v_context.db_revision
  );
end
$function$;

revoke all on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  from public, anon, authenticated;
grant execute on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  to authenticated;

comment on function public.g3a_agent_direct_pending_v1(uuid,uuid,text,text[])
  is 'Authenticated read-only due-action probe; the Edge claim remains the sole lease authority.';
comment on function public.g3a_agent_direct_report_v1(uuid,uuid,text,text,text,text[],text,timestamptz,timestamptz,timestamptz)
  is 'Authenticated combined Agent and collection heartbeat for low-cost PostgREST transport.';
comment on function public.g3a_agent_direct_wallpaper_snapshot_v1(uuid,bigint,uuid,text)
  is 'Authenticated raw wallpaper snapshot transport; rendering remains local and Edge-free.';

-- Signature images stay private. Authenticated owner/manager members may read
-- only the exact workspace prefix that the direct snapshot can reference.
-- No insert/update/delete policy is added.
create or replace function byeollog_automation.can_read_signature_asset_v1(
  p_bucket_id text,
  p_object_name text
)
returns boolean
language sql
stable
security definer
set search_path = ''
set statement_timeout = '3s'
as $function$
  select p_bucket_id = 'byeollog-signature-assets'
    and p_object_name ~ '^workspaces/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/wallpaper/'
    and exists (
      select 1
      from public.byeollog_workspace_members member
      join public.byeollog_workspaces workspace
        on workspace.id = member.workspace_id
       and workspace.status = 'active'
      where member.user_id = (select auth.uid())
        and member.role in ('owner', 'manager')
        and member.workspace_id = split_part(p_object_name, '/', 2)::uuid
    );
$function$;

revoke all on function byeollog_automation.can_read_signature_asset_v1(text,text)
  from public, anon, authenticated;
grant execute on function byeollog_automation.can_read_signature_asset_v1(text,text)
  to authenticated;

drop policy if exists byeollog_signature_assets_member_read_v1 on storage.objects;
create policy byeollog_signature_assets_member_read_v1
on storage.objects
for select
to authenticated
using (
  byeollog_automation.can_read_signature_asset_v1(bucket_id, name)
);


