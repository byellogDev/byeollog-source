-- Collection telemetry deliberately lives separately from the automation Agent
-- heartbeat.  A live Agent process does not prove that Weflab is receiving
-- donations, so this audit trail must never be folded into device "idle".
create table if not exists byeollog_automation.event_runtime_decisions (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null,
  event_id uuid not null references byeollog_automation.events(id) on delete restrict,
  decision_type text not null check (decision_type in ('late_event_suppressed')),
  decision_reason text not null check (decision_reason in ('event_age_exceeds_live_action_window')),
  occurred_at timestamptz not null,
  received_at timestamptz not null,
  suppressed_action_types text[] not null,
  suppressed_rule_ids uuid[] not null,
  recorded_at timestamptz not null default clock_timestamp(),
  unique (event_id, decision_type)
);

alter table byeollog_automation.event_runtime_decisions enable row level security;
drop policy if exists explicitly_deny_direct_client_access on byeollog_automation.event_runtime_decisions;
create policy explicitly_deny_direct_client_access
  on byeollog_automation.event_runtime_decisions
  for all to anon, authenticated using (false) with check (false);

create index if not exists event_runtime_decisions_workspace_recorded_idx
  on byeollog_automation.event_runtime_decisions (workspace_id, recorded_at desc);

-- This is a service-runtime-only write.  It first reuses the same locked
-- membership/release assertion as the event commit, then confirms that the
-- committed event belongs to the supplied workspace.  The unique key keeps
-- a retry after an Edge timeout audit-only and non-destructive.
create or replace function public.g3a_record_event_decision_v1(
  p_workspace_id uuid,
  p_event_id uuid,
  p_decision_type text,
  p_decision_reason text,
  p_occurred_at timestamptz,
  p_received_at timestamptz,
  p_suppressed_action_types text[],
  p_suppressed_rule_ids uuid[],
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_decision_id uuid;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);

  if p_runtime_component <> 'event_runtime'
     or p_event_id is null
     or p_decision_type <> 'late_event_suppressed'
     or p_decision_reason <> 'event_age_exceeds_live_action_window'
     or p_occurred_at is null or p_received_at is null
     or coalesce(cardinality(p_suppressed_action_types),0) not between 1 and 32
     or coalesce(cardinality(p_suppressed_rule_ids),0) not between 1 and 32
     or exists(select 1 from unnest(p_suppressed_action_types) item
               where item !~ '^[a-z][a-z0-9_.-]{0,119}$')
  then
    raise exception 'event decision payload is invalid' using errcode='22023';
  end if;

  if not exists(
    select 1 from byeollog_automation.events event_row
    where event_row.id=p_event_id and event_row.workspace_id=p_workspace_id
  ) then
    raise exception 'event decision event is unavailable' using errcode='P0002';
  end if;

  insert into byeollog_automation.event_runtime_decisions(
    workspace_id,event_id,decision_type,decision_reason,occurred_at,received_at,
    suppressed_action_types,suppressed_rule_ids)
  values(
    p_workspace_id,p_event_id,p_decision_type,p_decision_reason,p_occurred_at,p_received_at,
    p_suppressed_action_types,p_suppressed_rule_ids)
  on conflict (event_id,decision_type) do nothing
  returning id into v_decision_id;

  if v_decision_id is null then
    select id into v_decision_id
    from byeollog_automation.event_runtime_decisions
    where event_id=p_event_id and decision_type=p_decision_type;
  end if;
  return v_decision_id;
end;
$function$;

revoke all on function public.g3a_record_event_decision_v1(
  uuid,uuid,text,text,timestamptz,timestamptz,text[],uuid[],uuid,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.g3a_record_event_decision_v1(
  uuid,uuid,text,text,timestamptz,timestamptz,text[],uuid[],uuid,uuid,text,text,text)
  to service_role;

-- A Collector session is reported by the Agent independently of the action
-- worker heartbeat.  Old Agents do not write this table, which is deliberately
-- rendered as "unknown" instead of pretending the collection is idle.
create table if not exists byeollog_automation.agent_collection_health (
  workspace_id uuid not null,
  device_id uuid not null,
  collection_state text not null check (collection_state in ('active','idle','recovering','error')),
  session_started_at timestamptz,
  last_observed_at timestamptz,
  last_upload_at timestamptz,
  reported_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, device_id)
);

alter table byeollog_automation.agent_collection_health enable row level security;
drop policy if exists explicitly_deny_direct_client_access on byeollog_automation.agent_collection_health;
create policy explicitly_deny_direct_client_access
  on byeollog_automation.agent_collection_health
  for all to anon, authenticated using (false) with check (false);

create or replace function public.g3a_report_collection_health_v1(
  p_workspace_id uuid,
  p_device_id uuid,
  p_device_secret_hash text,
  p_collection_state text,
  p_session_started_at timestamptz,
  p_last_observed_at timestamptz,
  p_last_upload_at timestamptz,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns timestamptz
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_now timestamptz:=clock_timestamp();
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component <> 'agent_runtime'
     or p_collection_state not in ('active','idle','recovering','error')
     or (p_session_started_at is not null and p_session_started_at>v_now+interval '2 minutes')
     or (p_last_observed_at is not null and p_last_observed_at>v_now+interval '2 minutes')
     or (p_last_upload_at is not null and p_last_upload_at>v_now+interval '2 minutes')
     or (p_session_started_at is not null and p_last_observed_at is not null
       and p_last_observed_at<p_session_started_at)
  then raise exception 'collection health payload is invalid' using errcode='22023'; end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_device_id,p_device_secret_hash);

  insert into byeollog_automation.agent_collection_health(
    workspace_id,device_id,collection_state,session_started_at,last_observed_at,last_upload_at,reported_at)
  values(
    p_workspace_id,p_device_id,p_collection_state,p_session_started_at,p_last_observed_at,p_last_upload_at,v_now)
  on conflict(workspace_id,device_id) do update set
    collection_state=excluded.collection_state,
    session_started_at=excluded.session_started_at,
    last_observed_at=excluded.last_observed_at,
    last_upload_at=excluded.last_upload_at,
    reported_at=excluded.reported_at;
  return v_now;
end;
$function$;

revoke all on function public.g3a_report_collection_health_v1(
  uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,text,text,text)
  from public,anon,authenticated;
grant execute on function public.g3a_report_collection_health_v1(
  uuid,uuid,text,text,timestamptz,timestamptz,timestamptz,uuid,uuid,text,text,text)
  to service_role;

-- Keep the v1 rollout API intact for clients already released.  v2 adds a
-- read-only collection-health and safety-decision payload for the admin UI.
create or replace function public.get_agent_rollout_dashboard_v2(
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
  v_agent jsonb;
  v_now timestamptz:=clock_timestamp();
  v_limit integer;
  v_collection jsonb;
  v_decisions jsonb;
begin
  if p_workspace_id is null then
    raise exception 'workspace required' using errcode='22023';
  end if;
  v_limit:=least(greatest(coalesce(p_recent_limit,50),1),100);
  v_agent:=public.get_agent_rollout_dashboard_v1(
    p_workspace_id,p_include_all_workspaces,v_limit);

  with scoped_workspaces as (
    select w.id,w.display_name,w.slug from public.byeollog_workspaces w
    where w.status='active' and (p_include_all_workspaces or w.id=p_workspace_id)
  ), devices as (
    select d.workspace_id,d.device_id,d.device_name,d.registered_at,
      h.collection_state as reported_state,h.session_started_at,h.last_observed_at,
      h.last_upload_at,h.reported_at as collection_reported_at,
      case
        when h.device_id is null then 'unknown'
        when h.collection_state='active' and h.last_observed_at>=v_now-interval '2 minutes' then 'collecting'
        when h.collection_state='active' then 'stalled'
        else h.collection_state
      end as collection_state
    from byeollog_automation.agent_devices d
    join scoped_workspaces sw on sw.id=d.workspace_id
    left join byeollog_automation.agent_collection_health h
      on h.workspace_id=d.workspace_id and h.device_id=d.device_id
    where d.revoked_at is null
  )
  select jsonb_build_object(
    'status',case
      when count(*)=0 then 'not_configured'
      when count(*) filter(where collection_state in ('stalled','recovering','error'))>0 then 'stalled'
      when count(*) filter(where collection_state='collecting')>0 then 'collecting'
      when count(*) filter(where collection_state='unknown')>0 then 'unknown'
      else 'idle' end,
    'activeDeviceCount',count(*)::integer,
    'collectingDeviceCount',count(*) filter(where collection_state='collecting')::integer,
    'lastObservedAt',max(last_observed_at),
    'lastUploadAt',max(last_upload_at),
    'lastCollectionReportAt',max(collection_reported_at),
    'devices',coalesce(jsonb_agg(jsonb_build_object(
      'workspaceId',workspace_id,'deviceId',device_id,'displayName',device_name,
      'state',collection_state,'reportedState',reported_state,
      'sessionStartedAt',session_started_at,'lastObservedAt',last_observed_at,
      'lastUploadAt',last_upload_at,'reportedAt',collection_reported_at
    ) order by coalesce(collection_reported_at,registered_at) desc,device_id), '[]'::jsonb)
  ) into v_collection from devices;

  with scoped_workspaces as (
    select w.id,w.display_name from public.byeollog_workspaces w
    where w.status='active' and (p_include_all_workspaces or w.id=p_workspace_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',d.id,'workspaceId',d.workspace_id,'workspaceName',sw.display_name,
    'decisionType',d.decision_type,'decisionReason',d.decision_reason,
    'occurredAt',d.occurred_at,'receivedAt',d.received_at,'recordedAt',d.recorded_at,
    'suppressedActionTypes',d.suppressed_action_types,
    'suppressedActionCount',cardinality(d.suppressed_action_types)
  ) order by d.recorded_at desc,d.id desc), '[]'::jsonb)
  into v_decisions
  from (
    select decision.* from byeollog_automation.event_runtime_decisions decision
    join scoped_workspaces sw on sw.id=decision.workspace_id
    order by decision.recorded_at desc,decision.id desc limit v_limit
  ) d
  join scoped_workspaces sw on sw.id=d.workspace_id;

  return coalesce(v_agent,'{}'::jsonb)||jsonb_build_object(
    'collectionHealth',coalesce(v_collection,jsonb_build_object(
      'status','not_configured','activeDeviceCount',0,'collectingDeviceCount',0,
      'lastObservedAt',null,'lastUploadAt',null,'lastCollectionReportAt',null,'devices','[]'::jsonb)),
    'recentSafetyDecisions',coalesce(v_decisions,'[]'::jsonb));
end;
$function$;

revoke all on function public.get_agent_rollout_dashboard_v2(uuid,boolean,integer)
  from public,anon,authenticated;
grant execute on function public.get_agent_rollout_dashboard_v2(uuid,boolean,integer)
  to service_role;

;
