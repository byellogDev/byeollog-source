-- One editor gesture must result in one successful write. Older pages can still
-- submit a stale revision after a new donation arrives, so layout-only updates
-- are merged onto the currently selected tiles instead of raising 40001 and
-- triggering an unbounded client retry loop. A future revision remains invalid.
do $migration$
declare
  v_signature regprocedure;
  v_definition text;
  v_before text :=
    'if v_revision<>p_expected_revision then' || chr(10) ||
    '    raise exception ''wallpaper layout revision conflict'' using errcode=''40001'';' || chr(10) ||
    '  end if;';
  v_after text :=
    'if p_expected_revision>v_revision then' || chr(10) ||
    '    raise exception ''wallpaper layout revision is ahead of the server'' using errcode=''22023'';' || chr(10) ||
    '  end if;';
begin
  foreach v_signature in array array[
    'public.save_wallpaper_overlay_layout_v3(uuid,uuid,bigint,integer,jsonb)'::regprocedure,
    'public.save_wallpaper_overlay_layout_v4(uuid,uuid,bigint,integer,jsonb)'::regprocedure
  ] loop
    select pg_catalog.pg_get_functiondef(v_signature) into v_definition;
    if pg_catalog.strpos(v_definition,v_before)=0 then
      raise exception 'expected wallpaper conflict guard was not found in %',v_signature;
    end if;
    execute pg_catalog.replace(v_definition,v_before,v_after);
  end loop;
end
$migration$;

comment on function public.save_wallpaper_overlay_layout_v3(uuid,uuid,bigint,integer,jsonb)
  is 'Legacy protocol 2 layout save. Stale revisions merge selected tile layout without retry storms.';
comment on function public.save_wallpaper_overlay_layout_v4(uuid,uuid,bigint,integer,jsonb)
  is 'Protocol 3 layout save. Stale revisions merge selected tile layout without retry storms.';

create table if not exists public.byeollog_workspace_backup_leases(
  workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,
  lease_id uuid not null unique,
  reason text not null check(reason in ('automatic','manual','pre_restore')),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table if not exists public.byeollog_account_withdrawal_intents(
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  intent_token uuid not null unique,
  is_workspace_owner boolean not null,
  storage_confirmed boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

alter table public.byeollog_workspace_backup_leases enable row level security;
alter table public.byeollog_account_withdrawal_intents enable row level security;
revoke all on table public.byeollog_workspace_backup_leases from public,anon,authenticated;
revoke all on table public.byeollog_account_withdrawal_intents from public,anon,authenticated;
grant select,insert,update,delete on table public.byeollog_workspace_backup_leases to service_role;
grant select,insert,update,delete on table public.byeollog_account_withdrawal_intents to service_role;

create or replace function public.begin_workspace_backup_v1(
  p_workspace_id uuid,
  p_lease_id uuid,
  p_reason text,
  p_lease_seconds integer
)
returns table(lease_id uuid,expires_at timestamptz)
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='3s'
as $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_workspace_id is null or p_lease_id is null
    or p_reason not in ('automatic','manual','pre_restore')
    or p_lease_seconds not between 30 and 3600
  then
    raise exception 'backup lease request is invalid' using errcode='22023';
  end if;

  perform 1 from public.byeollog_workspaces
  where id=p_workspace_id for update;
  if not found then
    raise exception 'workspace was not found' using errcode='P0002';
  end if;

  delete from public.byeollog_workspace_backup_leases lease
  where lease.workspace_id=p_workspace_id and lease.expires_at<=v_now;
  delete from public.byeollog_account_withdrawal_intents intent
  where intent.expires_at<=v_now;

  if exists(
    select 1 from public.byeollog_account_withdrawal_intents intent
    where intent.workspace_id=p_workspace_id and intent.is_workspace_owner and intent.expires_at>v_now
  ) then
    raise exception 'account withdrawal is in progress' using errcode='55000';
  end if;
  if exists(
    select 1 from public.byeollog_workspace_backup_leases lease
    where lease.workspace_id=p_workspace_id and lease.expires_at>v_now
  ) then
    raise exception 'workspace backup is already running' using errcode='55P03';
  end if;

  v_expires_at:=v_now+pg_catalog.make_interval(secs=>p_lease_seconds);
  insert into public.byeollog_workspace_backup_leases(
    workspace_id,lease_id,reason,expires_at,created_at,updated_at)
  values(p_workspace_id,p_lease_id,p_reason,v_expires_at,v_now,v_now);
  return query select p_lease_id,v_expires_at;
end
$function$;

create or replace function public.release_workspace_backup_lease_v1(
  p_workspace_id uuid,p_lease_id uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='3s'
as $function$
begin
  if p_workspace_id is null or p_lease_id is null then
    raise exception 'backup lease release request is invalid' using errcode='22023';
  end if;
  delete from public.byeollog_workspace_backup_leases
  where workspace_id=p_workspace_id and lease_id=p_lease_id;
  return found;
end
$function$;

create or replace function public.prepare_account_withdrawal_v1(
  p_user_id uuid,p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='5s'
as $function$
declare
  v_role text;
  v_owner_user_id uuid;
  v_is_owner boolean;
  v_token uuid:=gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_manifest jsonb:='[]'::jsonb;
begin
  if p_user_id is null or p_workspace_id is null then
    raise exception 'withdrawal request is invalid' using errcode='22023';
  end if;
  select member.role,workspace.owner_user_id
  into v_role,v_owner_user_id
  from public.byeollog_workspace_members member
  join public.byeollog_workspaces workspace on workspace.id=member.workspace_id
  where member.user_id=p_user_id and member.workspace_id=p_workspace_id
  for update of member,workspace;
  if not found then
    raise exception 'active membership was not found' using errcode='P0002';
  end if;
  v_is_owner:=v_role='owner' or v_owner_user_id=p_user_id;

  delete from public.byeollog_workspace_backup_leases
  where workspace_id=p_workspace_id and expires_at<=v_now;
  delete from public.byeollog_account_withdrawal_intents
  where user_id=p_user_id or expires_at<=v_now;
  if v_is_owner and exists(
    select 1 from public.byeollog_workspace_backup_leases
    where workspace_id=p_workspace_id and expires_at>v_now
  ) then
    raise exception 'workspace backup is in progress' using errcode='55P03';
  end if;

  if v_is_owner then
    select coalesce(jsonb_agg(jsonb_build_object(
      'bucketId',object.bucket_id,'name',object.name
    ) order by object.bucket_id,object.name),'[]'::jsonb)
    into v_manifest
    from storage.objects object
    where object.name like 'workspaces/'||p_workspace_id::text||'/%';
  end if;

  insert into public.byeollog_account_withdrawal_intents(
    user_id,workspace_id,intent_token,is_workspace_owner,expires_at,
    storage_confirmed,created_at,updated_at)
  values(p_user_id,p_workspace_id,v_token,v_is_owner,v_now+interval '20 minutes',
    false,v_now,v_now);

  return jsonb_build_object(
    'workspaceId',p_workspace_id,
    'intentToken',v_token,
    'blocksWorkspaceBackups',v_is_owner,
    'storageManifest',v_manifest
  );
end
$function$;

create or replace function public.confirm_account_withdrawal_storage_v1(
  p_user_id uuid,p_workspace_id uuid,p_intent_token uuid
)
returns boolean
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='5s'
as $function$
declare v_owner boolean;
begin
  select intent.is_workspace_owner into v_owner
  from public.byeollog_account_withdrawal_intents intent
  where intent.user_id=p_user_id
    and intent.workspace_id=p_workspace_id
    and intent.intent_token=p_intent_token
    and intent.expires_at>clock_timestamp()
  for update;
  if not found then
    raise exception 'withdrawal intent is invalid or expired' using errcode='22023';
  end if;
  if v_owner and exists(
    select 1 from storage.objects object
    where object.name like 'workspaces/'||p_workspace_id::text||'/%'
  ) then
    raise exception 'workspace storage objects remain' using errcode='55000';
  end if;
  update public.byeollog_account_withdrawal_intents
  set storage_confirmed=true,updated_at=clock_timestamp()
  where user_id=p_user_id;
  return true;
end
$function$;

create or replace function public.byeollog_withdraw_account(
  p_user_id uuid,p_workspace_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='15s'
as $function$
declare
  v_role text;
  v_is_owner boolean;
  v_email text;
begin
  if p_user_id is null or p_workspace_id is null then
    raise exception 'user_id and workspace_id are required' using errcode='22023';
  end if;

  select member.role,
    (member.role='owner' or workspace.owner_user_id=p_user_id)
  into v_role,v_is_owner
  from public.byeollog_workspace_members member
  join public.byeollog_workspaces workspace on workspace.id=member.workspace_id
  where member.user_id=p_user_id and member.workspace_id=p_workspace_id
  for update of member,workspace;
  if not found then raise exception 'active membership not found' using errcode='P0002'; end if;

  perform 1 from public.byeollog_account_withdrawal_intents intent
  where intent.user_id=p_user_id
    and intent.workspace_id=p_workspace_id
    and intent.is_workspace_owner=v_is_owner
    and intent.storage_confirmed
    and intent.expires_at>clock_timestamp()
  for update;
  if not found then
    raise exception 'confirmed withdrawal intent is required' using errcode='55000';
  end if;
  if v_is_owner and exists(
    select 1 from public.byeollog_workspace_backup_leases
    where workspace_id=p_workspace_id and expires_at>clock_timestamp()
  ) then
    raise exception 'workspace backup is in progress' using errcode='55P03';
  end if;
  if v_is_owner and exists(
    select 1 from storage.objects object
    where object.name like 'workspaces/'||p_workspace_id::text||'/%'
  ) then
    raise exception 'workspace storage objects remain' using errcode='55000';
  end if;

  select lower(auth_user.email) into v_email
  from auth.users auth_user where auth_user.id=p_user_id for update;
  if not found then raise exception 'auth user not found' using errcode='P0002'; end if;

  if v_is_owner then
    delete from public.byeollog_audit_log
      where workspace_id=p_workspace_id or actor_user_id=p_user_id;
    delete from public.bangsel_task_import_items where workspace_id=p_workspace_id;
    delete from public.bangsel_roulette_invalidations where workspace_id=p_workspace_id;
    delete from public.bangsel_collector_staging where workspace_id=p_workspace_id;
    delete from public.bangsel_donations where workspace_id=p_workspace_id;
    delete from public.bangsel_tasks where workspace_id=p_workspace_id;
    delete from public.bangsel_roulette_rules where workspace_id=p_workspace_id;
    delete from public.bangsel_fan_stations where workspace_id=p_workspace_id;
    delete from public.bangsel_fans where workspace_id=p_workspace_id;
    delete from public.byeollog_dashboard_handoffs where workspace_id=p_workspace_id;
    delete from public.byeollog_collector_devices where workspace_id=p_workspace_id;
    delete from public.byeollog_workspace_settings where workspace_id=p_workspace_id;
    delete from public.byeollog_workspace_members where workspace_id=p_workspace_id;
    delete from public.byeollog_workspaces where id=p_workspace_id;
  else
    delete from public.byeollog_account_withdrawal_intents where user_id=p_user_id;
    delete from public.byeollog_audit_log where actor_user_id=p_user_id;
    delete from public.byeollog_workspace_members
    where workspace_id=p_workspace_id and user_id=p_user_id;
  end if;

  delete from public.byeollog_signup_applications
  where auth_user_id=p_user_id or lower(email)=v_email;
  delete from auth.users where id=p_user_id;
  if not found then raise exception 'auth user delete failed'; end if;
  return jsonb_build_object('ok',true,'workspace_deleted',v_is_owner,'user_deleted',true);
end
$function$;

revoke all on function public.begin_workspace_backup_v1(uuid,uuid,text,integer) from public,anon,authenticated,service_role;
revoke all on function public.release_workspace_backup_lease_v1(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.prepare_account_withdrawal_v1(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.confirm_account_withdrawal_storage_v1(uuid,uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function public.byeollog_withdraw_account(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.begin_workspace_backup_v1(uuid,uuid,text,integer) to service_role;
grant execute on function public.release_workspace_backup_lease_v1(uuid,uuid) to service_role;
grant execute on function public.prepare_account_withdrawal_v1(uuid,uuid) to service_role;
grant execute on function public.confirm_account_withdrawal_storage_v1(uuid,uuid,uuid) to service_role;
grant execute on function public.byeollog_withdraw_account(uuid,uuid) to service_role;

-- The web application uses only server-side service-role access. Remove old
-- direct browser grants, including TRUNCATE, from superseded tables.
revoke all on table public.bangsel_fan_stations from public,anon,authenticated;
revoke all on table public.bangsel_tasks from public,anon,authenticated;
revoke all on table public.overlay_asset_durations from public,anon,authenticated;
revoke all on table public.overlay_assets from public,anon,authenticated;
revoke all on table public.rule_actions from public,anon,authenticated;
revoke all on table public.rule_conditions from public,anon,authenticated;
revoke all on table public.rules from public,anon,authenticated;
revoke all on table public.workspace_members from public,anon,authenticated;

-- These public wrappers belong to removed roulette/action UI surfaces.
do $acl$
declare v_function regprocedure;
begin
  for v_function in
    select procedure.oid::regprocedure
    from pg_proc procedure
    join pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname in ('public','byeollog_automation')
      and (
        procedure.proname like 'save_guided_rule_%'
        or procedure.proname in (
          'draw_next_raffle_winner_v2','get_raffle_state_v2',
          'reannounce_raffle_winner_v1','start_raffle_draw_v2'
        )
      )
  loop
    execute pg_catalog.format(
      'revoke all on function %s from public,anon,authenticated',
      v_function
    );
  end loop;
end
$acl$;

create index if not exists byeollog_soop_core_roulette_results_donation_id_idx
  on public.byeollog_soop_core_roulette_results(donation_id);

do $cron$
declare v_job_id bigint;
begin
  select jobid into v_job_id from cron.job
  where jobname='byeollog-expire-stale-native-overlay-v1';
  if v_job_id is not null then perform cron.unschedule(v_job_id); end if;
end
$cron$;
