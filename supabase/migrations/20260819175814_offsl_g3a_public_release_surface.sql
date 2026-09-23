-- OFFSL G3A public-release compatibility surface.
-- Approval evidence SHA-256:
-- 472aeddc19d84a1b236e4edc3dcaf6922563ec70de2081f509264ff5656ab273
--
-- The migration removes only candidate-owned single-workspace constraints.
-- Legacy Byeollog tables remain the identity source of truth. Existing
-- Collector contracts are not changed.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';

do $preflight$
begin
  perform 1 from byeollog_automation.release_gate where gate_id = 1 for update;
  if not found then
    raise exception 'G3A_PUBLIC01: release gate is missing';
  end if;
  if (select enabled from byeollog_automation.release_gate where gate_id = 1)
     or exists (select 1 from byeollog_automation.workspace_gates where enabled) then
    raise exception 'G3A_PUBLIC02: all release gates must be OFF';
  end if;
  if exists (select 1 from byeollog_automation.events)
     or exists (select 1 from byeollog_automation.executions)
     or exists (select 1 from byeollog_automation.rules)
     or exists (select 1 from public.rules) then
    raise exception 'G3A_PUBLIC03: rule/event/execution state must be empty';
  end if;
  if exists (
    select 1
    from public.byeollog_workspaces w
    left join lateral (
      select count(*) filter (where m.role = 'owner') as owner_count
      from public.byeollog_workspace_members m
      where m.workspace_id = w.id
    ) x on true
    where w.status = 'active' and x.owner_count <> 1
  ) then
    raise exception 'G3A_PUBLIC04: every active workspace must have exactly one owner';
  end if;
  if exists (
    select 1
    from public.byeollog_workspace_members m
    join public.byeollog_workspaces w on w.id = m.workspace_id
    where w.status = 'active' and m.role not in ('owner','manager','viewer')
  ) then
    raise exception 'G3A_PUBLIC05: unsupported active membership role';
  end if;
  if to_regprocedure('public.g3a_automation_schema_readiness_v1(uuid,uuid)') is null
     or to_regprocedure('public.g3a_assert_active_auth_session_v1(uuid,uuid)') is null then
    raise exception 'G3A_PUBLIC06: runtime foundation is incomplete';
  end if;
end;
$preflight$;

alter table byeollog_automation.release_gate
  drop constraint if exists release_gate_g3a_canary_scope;
alter table byeollog_automation.workspace_gates
  drop constraint if exists workspace_gate_g3a_canary_scope;
drop index if exists byeollog_automation.workspace_gates_single_enabled_idx;

alter table public.workspace_members
  drop constraint if exists workspace_members_g3a_canary_scope;
alter table public.rules
  drop constraint if exists rules_g3a_canary_scope;

do $foreign_keys$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.workspace_members'::regclass
      and conname = 'workspace_members_legacy_workspace_fk'
  ) then
    alter table public.workspace_members
      add constraint workspace_members_legacy_workspace_fk
      foreign key (workspace_id) references public.byeollog_workspaces(id)
      on delete cascade;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.workspace_members'::regclass
      and conname = 'workspace_members_auth_user_fk'
  ) then
    alter table public.workspace_members
      add constraint workspace_members_auth_user_fk
      foreign key (user_id) references auth.users(id)
      on delete cascade;
  end if;
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'byeollog_automation.workspace_gates'::regclass
      and conname = 'workspace_gates_legacy_workspace_fk'
  ) then
    alter table byeollog_automation.workspace_gates
      add constraint workspace_gates_legacy_workspace_fk
      foreign key (workspace_id) references public.byeollog_workspaces(id)
      on delete cascade;
  end if;
end;
$foreign_keys$;

insert into public.workspace_members(workspace_id,user_id,role)
select m.workspace_id,m.user_id,
  case m.role when 'owner' then 'owner' when 'manager' then 'admin' else 'viewer' end
from public.byeollog_workspace_members m
join public.byeollog_workspaces w on w.id=m.workspace_id and w.status='active'
where m.role in ('owner','manager','viewer')
on conflict (workspace_id,user_id) do update set role=excluded.role;

create or replace function byeollog_automation.assert_canary_manager_v1(
  p_workspace_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
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
  perform public.g3a_assert_active_auth_session_v1(v_uid,v_session_id);
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
$function$;

-- Compatibility name retained for already sealed clients. Public release rule
-- writes are atomic and may occur while the runtime is enabled.
create or replace function byeollog_automation.assert_rule_write_off_v1()
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $function$
begin
  return;
end;
$function$;

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
  on conflict (workspace_id,user_id) do update set role='owner';

  -- A missing row is a new eligible workspace and is enrolled. An existing
  -- disabled row is an operator stop and is deliberately never re-enabled by
  -- login.
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

create or replace function byeollog_automation.set_release_gate_v1(
  p_enabled boolean,
  p_operator_user_id uuid,
  p_evidence_sha256 text
)
returns void
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
begin
  if p_enabled is null or p_operator_user_id is null then
    raise exception 'release gate parameters are invalid' using errcode='22023';
  end if;
  if p_enabled and (p_evidence_sha256 is null or p_evidence_sha256 !~ '^[0-9a-f]{64}$') then
    raise exception 'activation evidence is required' using errcode='22023';
  end if;

  perform 1 from byeollog_automation.release_gate where gate_id=1 for update;
  if not found then
    raise exception 'global release gate is missing' using errcode='55000';
  end if;

  if p_enabled and not exists (
    select 1
    from byeollog_automation.workspace_gates g
    join public.byeollog_workspaces w on w.id=g.workspace_id and w.status='active'
    join public.byeollog_workspace_members m
      on m.workspace_id=w.id and m.user_id=p_operator_user_id and m.role in ('owner','manager')
    where g.enabled
  ) then
    raise exception 'operator must manage an enabled workspace' using errcode='42501';
  end if;

  update byeollog_automation.release_gate g
  set enabled=p_enabled,
      evidence_sha256=case when p_enabled then p_evidence_sha256 else g.evidence_sha256 end,
      enabled_at=case when p_enabled then clock_timestamp() else null end,
      disabled_at=case when p_enabled then null else clock_timestamp() end,
      changed_by=p_operator_user_id,
      changed_at=clock_timestamp()
  where g.gate_id=1;
end;
$function$;

revoke all on function public.byeollog_ensure_automation_workspace_v1(uuid,uuid,text)
  from public,anon,authenticated;
grant execute on function public.byeollog_ensure_automation_workspace_v1(uuid,uuid,text)
  to service_role;
revoke all on function byeollog_automation.assert_canary_manager_v1(uuid)
  from public,anon;
revoke all on function byeollog_automation.assert_rule_write_off_v1()
  from public,anon;
revoke all on function byeollog_automation.set_release_gate_v1(boolean,uuid,text)
  from public,anon,authenticated;
grant execute on function byeollog_automation.set_release_gate_v1(boolean,uuid,text)
  to service_role;

insert into byeollog_automation.workspace_gates(
  workspace_id,enabled,evidence_sha256,enrolled_by,enabled_at,disabled_at,
  changed_by,changed_at
)
select w.id,true,
  '472aeddc19d84a1b236e4edc3dcaf6922563ec70de2081f509264ff5656ab273',
  m.user_id,clock_timestamp(),null,m.user_id,clock_timestamp()
from public.byeollog_workspaces w
join public.byeollog_workspace_members m
  on m.workspace_id=w.id and m.role='owner'
where w.status='active'
on conflict (workspace_id) do update
set enabled=true,
    evidence_sha256=excluded.evidence_sha256,
    enabled_at=clock_timestamp(),
    disabled_at=null,
    changed_by=excluded.changed_by,
    changed_at=clock_timestamp();

update byeollog_automation.release_gate
set enabled=true,
    evidence_sha256='472aeddc19d84a1b236e4edc3dcaf6922563ec70de2081f509264ff5656ab273',
    enabled_at=clock_timestamp(),
    disabled_at=null,
    changed_by='37c0485c-2848-5a49-a35c-9aca5b3c459b'::uuid,
    changed_at=clock_timestamp()
where gate_id=1;

notify pgrst,'reload schema';

do $postflight$
declare
  v_active_workspaces integer;
  v_ready_workspaces integer;
begin
  select count(*) into v_active_workspaces
  from public.byeollog_workspaces where status='active';

  select count(*) into v_ready_workspaces
  from public.byeollog_workspace_members m
  join public.byeollog_workspaces w on w.id=m.workspace_id and w.status='active'
  where m.role='owner'
    and (select r.ready from public.g3a_automation_schema_readiness_v1(w.id,m.user_id) r);

  if not (select enabled from byeollog_automation.release_gate where gate_id=1)
     or (select count(*) from byeollog_automation.workspace_gates g
         join public.byeollog_workspaces w on w.id=g.workspace_id
         where w.status='active' and g.enabled) <> v_active_workspaces
     or (select count(*) from public.workspace_members wm
         join public.byeollog_workspace_members lm
           on lm.workspace_id=wm.workspace_id and lm.user_id=wm.user_id
         join public.byeollog_workspaces w on w.id=wm.workspace_id and w.status='active')
        <> (select count(*) from public.byeollog_workspace_members lm
            join public.byeollog_workspaces w on w.id=lm.workspace_id and w.status='active')
     or v_ready_workspaces <> v_active_workspaces
     or exists (select 1 from byeollog_automation.events)
     or exists (select 1 from byeollog_automation.executions)
     or exists (select 1 from byeollog_automation.rules)
     or exists (select 1 from public.rules) then
    raise exception 'G3A_PUBLIC07: public release postflight failed';
  end if;
end;
$postflight$;

commit;

