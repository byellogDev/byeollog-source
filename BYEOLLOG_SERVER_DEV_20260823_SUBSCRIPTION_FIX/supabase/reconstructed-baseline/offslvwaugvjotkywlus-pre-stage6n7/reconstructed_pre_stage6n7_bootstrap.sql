-- RECONSTRUCTED BOOTSTRAP — NOT THE RECOVERED ORIGINAL SOURCE.
--
-- Target state: immediately before remote migration
--   20260814121415_p0_withdraw_transaction.sql
-- Project: offslvwaugvjotkywlus
-- Reconstructed: 2026-08-31 (Asia/Seoul)
--
-- Evidence:
--   1. read-only catalog extraction from the operating Supabase project;
--   2. inverse application of the only remote migration that changes these
--      legacy public tables, 20260814130058_p1_p2_account_security.sql;
--   3. the 20260814130048 Stage 6N7 validation baseline;
--   4. the following 79 remote migration files in the adjacent reference tree.
--
-- Keep this file outside supabase/migrations until an empty-database replay and
-- final schema diff have passed. Never apply this bootstrap to the linked
-- production project.

begin;

-- ---------------------------------------------------------------------------
-- Workspace and account control plane
-- ---------------------------------------------------------------------------

create table public.byeollog_workspaces (
  id uuid default gen_random_uuid() not null,
  slug text not null,
  display_name text not null,
  soop_id text,
  owner_user_id uuid,
  status text default 'active'::text not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  public_page_enabled boolean default true not null,
  constraint byeollog_workspaces_pkey primary key (id),
  constraint byeollog_workspaces_slug_format
    check (slug = lower(slug) and slug ~ '^[a-z0-9][a-z0-9_-]{1,62}$'::text),
  constraint byeollog_workspaces_status_check
    check (status = any (array['active'::text,'suspended'::text,'closed'::text])),
  constraint byeollog_workspaces_owner_user_id_fkey
    foreign key (owner_user_id) references auth.users(id) on delete set null
);

create unique index byeollog_workspaces_slug_uq
  on public.byeollog_workspaces using btree (slug);
create unique index byeollog_workspaces_soop_id_uq
  on public.byeollog_workspaces using btree (soop_id)
  where soop_id is not null and btrim(soop_id) <> ''::text;
create table public.byeollog_workspace_members (
  workspace_id uuid not null,
  user_id uuid not null,
  role text default 'owner'::text not null,
  created_at timestamptz default now() not null,
  constraint byeollog_workspace_members_pkey primary key (workspace_id,user_id),
  constraint byeollog_workspace_members_role_check
    check (role = any (array['owner'::text,'manager'::text,'viewer'::text])),
  constraint byeollog_workspace_members_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id) on delete cascade,
  constraint byeollog_workspace_members_user_id_fkey
    foreign key (user_id) references auth.users(id) on delete cascade
);

create index byeollog_workspace_members_user_idx
  on public.byeollog_workspace_members using btree (user_id,workspace_id);

create table public.byeollog_workspace_settings (
  workspace_id uuid not null,
  public_page_enabled boolean default true not null,
  public_page_title text,
  timezone text default 'Asia/Seoul'::text not null,
  settings jsonb default '{}'::jsonb not null,
  updated_at timestamptz default now() not null,
  constraint byeollog_workspace_settings_pkey primary key (workspace_id),
  constraint byeollog_workspace_settings_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id) on delete cascade
);

create table public.byeollog_signup_applications (
  id uuid default gen_random_uuid() not null,
  auth_user_id uuid,
  email text not null,
  streamer_name text not null,
  soop_id text not null,
  station_url text default ''::text not null,
  verification_channel text not null,
  verification_account text not null,
  note text default ''::text not null,
  status text default 'pending'::text not null,
  rejection_reason text default ''::text not null,
  reviewed_by uuid,
  reviewed_at timestamptz,
  workspace_id uuid,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  status_token_hash text,
  constraint byeollog_signup_applications_pkey primary key (id),
  constraint byeollog_signup_applications_email_key unique (email),
  constraint byeollog_signup_applications_status_check
    check (status = any (array['pending'::text,'approved'::text,'rejected'::text])),
  -- Stage 6N8 explicitly changed this relationship to ON DELETE SET NULL.
  -- Its pre-migration behavior is reconstructed as CASCADE from the migration comment.
  constraint byeollog_signup_applications_auth_user_id_fkey
    foreign key (auth_user_id) references auth.users(id) on delete cascade,
  constraint byeollog_signup_applications_reviewed_by_fkey
    foreign key (reviewed_by) references auth.users(id) on delete set null,
  constraint byeollog_signup_applications_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id) on delete set null
);

create unique index byeollog_signup_applications_auth_user_id_uidx
  on public.byeollog_signup_applications using btree (auth_user_id)
  where auth_user_id is not null;
create unique index byeollog_signup_applications_status_token_hash_idx
  on public.byeollog_signup_applications using btree (status_token_hash)
  where status_token_hash is not null;
create index byeollog_signup_applications_status_created_idx
  on public.byeollog_signup_applications using btree (status,created_at desc);

create table public.byeollog_inquiries (
  id uuid default gen_random_uuid() not null,
  contact text not null,
  message text not null,
  status text default 'new'::text not null,
  ip_hash text,
  user_agent text,
  created_at timestamptz default now() not null,
  read_at timestamptz,
  constraint byeollog_inquiries_pkey primary key (id),
  constraint byeollog_inquiries_status_check
    check (status = any (array['new'::text,'read'::text,'archived'::text]))
);

create index byeollog_inquiries_status_created_idx
  on public.byeollog_inquiries using btree (status,created_at desc);

create table public.byeollog_collector_devices (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  device_name text default 'Collector'::text not null,
  token_hash text,
  pairing_code_hash text,
  pairing_expires_at timestamptz,
  status text default 'pending'::text not null,
  collector_version text,
  last_seen_at timestamptz,
  last_upload_at timestamptz,
  created_at timestamptz default now() not null,
  revoked_at timestamptz,
  paired_at timestamptz,
  last_ip_hash text,
  token_expires_at timestamptz,
  last_rotated_at timestamptz,
  created_by_user_id uuid,
  constraint byeollog_collector_devices_pkey primary key (id),
  constraint byeollog_collector_devices_status_check
    check (status = any (array['pending'::text,'active'::text,'revoked'::text])),
  constraint byeollog_collector_devices_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id) on delete cascade
);

create unique index byeollog_collector_devices_token_hash_uq
  on public.byeollog_collector_devices using btree (token_hash)
  where token_hash is not null;
create index byeollog_collector_devices_pairing_idx
  on public.byeollog_collector_devices using btree (pairing_code_hash,pairing_expires_at)
  where pairing_code_hash is not null;
create index byeollog_collector_devices_token_expires_idx
  on public.byeollog_collector_devices using btree (token_expires_at)
  where status = 'active'::text and token_expires_at is not null;
create index byeollog_collector_devices_workspace_idx
  on public.byeollog_collector_devices using btree (workspace_id,status,last_seen_at desc);

create table public.byeollog_dashboard_handoffs (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  device_id uuid not null,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now() not null,
  collector_device_id uuid,
  constraint byeollog_dashboard_handoffs_pkey primary key (id),
  constraint byeollog_dashboard_handoffs_code_hash_key unique (code_hash),
  constraint byeollog_dashboard_handoffs_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id) on delete cascade,
  constraint byeollog_dashboard_handoffs_device_id_fkey
    foreign key (device_id) references public.byeollog_collector_devices(id) on delete cascade,
  constraint byeollog_dashboard_handoffs_collector_device_id_fkey
    foreign key (collector_device_id) references public.byeollog_collector_devices(id) on delete cascade
);

create index byeollog_dashboard_handoffs_device_idx
  on public.byeollog_dashboard_handoffs using btree (collector_device_id);
create index byeollog_dashboard_handoffs_lookup_idx
  on public.byeollog_dashboard_handoffs using btree (code_hash,expires_at)
  where used_at is null;
create index byeollog_dashboard_handoffs_workspace_idx
  on public.byeollog_dashboard_handoffs using btree (workspace_id,created_at desc);

create table public.byeollog_audit_log (
  id bigint generated always as identity not null,
  workspace_id uuid,
  actor_user_id uuid,
  actor_kind text default 'system'::text not null,
  action text not null,
  target_type text,
  target_id text,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamptz default now() not null,
  constraint byeollog_audit_log_pkey primary key (id),
  constraint byeollog_audit_log_actor_kind_check
    check (actor_kind = any (array['user'::text,'collector'::text,'system'::text,'super_admin'::text])),
  constraint byeollog_audit_log_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id) on delete set null,
  constraint byeollog_audit_log_actor_user_id_fkey
    foreign key (actor_user_id) references auth.users(id) on delete set null
);

create index byeollog_audit_log_workspace_time_idx
  on public.byeollog_audit_log using btree (workspace_id,created_at desc);

-- ---------------------------------------------------------------------------
-- Legacy Bangsel operational tables
-- ---------------------------------------------------------------------------

create table public.bangsel_fans (
  soop_id text not null,
  alias text not null,
  current_nickname text,
  station_url text,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  workspace_id uuid not null,
  constraint bangsel_fans_pkey primary key (workspace_id,soop_id),
  constraint bangsel_fans_alias_nonempty check (length(btrim(alias)) > 0),
  constraint bangsel_fans_soop_id_nonempty check (length(btrim(soop_id)) > 0),
  constraint bangsel_fans_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id)
);

create index idx_bangsel_fans_workspace_id
  on public.bangsel_fans using btree (workspace_id);

create table public.bangsel_fan_stations (
  fan text not null,
  station_url text default ''::text not null,
  updated_at timestamptz default now() not null,
  workspace_id uuid not null,
  constraint bangsel_fan_stations_pkey primary key (workspace_id,fan),
  constraint bangsel_fan_stations_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id)
);

create index idx_bangsel_fan_stations_workspace_id
  on public.bangsel_fan_stations using btree (workspace_id);

create table public.bangsel_roulette_rules (
  result_text text not null,
  action text default 'review'::text not null,
  output_types jsonb default '[]'::jsonb not null,
  updated_at timestamptz default now() not null,
  workspace_id uuid not null,
  constraint bangsel_roulette_rules_pkey primary key (workspace_id,result_text),
  constraint bangsel_roulette_rules_action_check
    check (action = any (array['include'::text,'exclude'::text,'review'::text])),
  constraint bangsel_roulette_rules_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id)
);

create index idx_bangsel_roulette_rules_workspace_id
  on public.bangsel_roulette_rules using btree (workspace_id);

create table public.bangsel_tasks (
  id uuid default gen_random_uuid() not null,
  fan text not null,
  event text default ''::text not null,
  type text not null,
  total_qty integer default 1 not null,
  done_qty integer default 0 not null,
  memo text default ''::text not null,
  created_at timestamptz default now() not null,
  updated_at timestamptz default now() not null,
  added_date date default ((now() at time zone 'Asia/Seoul'::text))::date,
  fan_soop_id text,
  source text default 'manual'::text not null,
  source_event_key text,
  workspace_id uuid not null,
  public_comment text default ''::text not null,
  constraint bangsel_tasks_pkey primary key (id),
  constraint bangsel_tasks_total_qty_check check (total_qty >= 1),
  constraint bangsel_tasks_done_qty_check check (done_qty >= 0 and done_qty <= total_qty),
  constraint bangsel_tasks_check check (done_qty >= 0 and done_qty <= total_qty),
  constraint bangsel_tasks_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id),
  constraint bangsel_tasks_fan_soop_id_fkey
    foreign key (workspace_id,fan_soop_id)
    references public.bangsel_fans(workspace_id,soop_id)
    on update cascade on delete set null
);

create unique index bangsel_tasks_source_event_key_uidx
  on public.bangsel_tasks using btree (source_event_key)
  where source_event_key is not null;
create index bangsel_tasks_fan_soop_id_idx
  on public.bangsel_tasks using btree (fan_soop_id);
create index bangsel_tasks_source_idx
  on public.bangsel_tasks using btree (source);
create index idx_bangsel_tasks_workspace_id
  on public.bangsel_tasks using btree (workspace_id);

create table public.bangsel_task_import_items (
  source_event_key text not null,
  task_id uuid not null,
  source text default 'weflab_roulette'::text not null,
  created_at timestamptz default now() not null,
  workspace_id uuid not null,
  constraint bangsel_task_import_items_pkey primary key (workspace_id,source_event_key),
  constraint bangsel_task_import_items_task_id_fkey
    foreign key (task_id) references public.bangsel_tasks(id) on delete cascade,
  constraint bangsel_task_import_items_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id)
);

create index bangsel_task_import_items_task_id_idx
  on public.bangsel_task_import_items using btree (task_id);
create index idx_bangsel_task_import_items_workspace_id
  on public.bangsel_task_import_items using btree (workspace_id);

create table public.bangsel_donations (
  source_event_key text not null,
  source text default 'weflab_batch'::text not null,
  donation_type text not null,
  donated_date date not null,
  donated_time time without time zone not null,
  donated_at timestamptz not null,
  soop_id text not null,
  nickname text not null,
  balloons integer not null,
  message text,
  had_roulette boolean default false not null,
  roulette_count integer default 0 not null,
  roulette_results jsonb default '[]'::jsonb not null,
  event_name text,
  raw_payload jsonb default '{}'::jsonb not null,
  imported_at timestamptz default now() not null,
  workspace_id uuid not null,
  constraint bangsel_donations_pkey primary key (workspace_id,source_event_key),
  constraint bangsel_donations_balloons_check check (balloons > 0),
  constraint bangsel_donations_roulette_count_check check (roulette_count >= 0),
  constraint bangsel_donations_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id)
);

create index bangsel_donations_balloons_idx
  on public.bangsel_donations using btree (balloons);
create index bangsel_donations_date_idx
  on public.bangsel_donations using btree (donated_date desc);
create index bangsel_donations_donated_at_idx
  on public.bangsel_donations using btree (donated_at desc);
create index bangsel_donations_soop_id_idx
  on public.bangsel_donations using btree (soop_id);
create index idx_bangsel_donations_workspace_id
  on public.bangsel_donations using btree (workspace_id);

create table public.bangsel_collector_staging (
  source_uid text not null,
  session_id text not null,
  broadcast_start_local timestamp without time zone,
  broadcast_end_local timestamp without time zone,
  donated_time_text text,
  nickname text,
  soop_id text,
  balloons integer default 0 not null,
  roulette text,
  collector_version text,
  raw_payload jsonb default '{}'::jsonb not null,
  uploaded_at timestamptz default now() not null,
  event_name text,
  expected_spins integer,
  actual_spins integer default 0 not null,
  validation text default 'unmapped'::text not null,
  roulette_results jsonb default '[]'::jsonb not null,
  process_status text default 'pending'::text not null,
  processed_at timestamptz,
  source_scope text default 'soop'::text not null,
  processing_started_at timestamptz,
  process_error text,
  process_attempts integer default 0 not null,
  fixed_rewards jsonb default '[]'::jsonb not null,
  workspace_id uuid not null,
  constraint bangsel_collector_staging_pkey
    primary key (workspace_id,source_scope,source_uid),
  constraint bangsel_collector_staging_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id)
);

create unique index bangsel_collector_staging_workspace_uid_uq
  on public.bangsel_collector_staging using btree (workspace_id,source_uid);
create index bangsel_collector_staging_processing_idx
  on public.bangsel_collector_staging using btree (process_status,processing_started_at,uploaded_at);
create index bangsel_collector_staging_session_idx
  on public.bangsel_collector_staging using btree (session_id,uploaded_at desc);
create index bangsel_collector_staging_soop_id_idx
  on public.bangsel_collector_staging using btree (soop_id)
  where soop_id is not null;
create index bangsel_collector_staging_status_idx
  on public.bangsel_collector_staging using btree (process_status,uploaded_at);
create index bangsel_collector_staging_time_idx
  on public.bangsel_collector_staging using btree (donated_time_text);
create index idx_bangsel_collector_staging_workspace_id
  on public.bangsel_collector_staging using btree (workspace_id);

create table public.bangsel_roulette_invalidations (
  source_uid text not null,
  reason text,
  invalidated_at timestamptz default now() not null,
  workspace_id uuid not null,
  constraint bangsel_roulette_invalidations_pkey primary key (workspace_id,source_uid),
  constraint bangsel_roulette_invalidations_workspace_id_fkey
    foreign key (workspace_id) references public.byeollog_workspaces(id),
  constraint bangsel_roulette_invalidations_source_uid_fkey
    foreign key (workspace_id,source_uid)
    references public.bangsel_collector_staging(workspace_id,source_uid)
    on delete cascade
);

create index bangsel_roulette_invalidations_invalidated_at_idx
  on public.bangsel_roulette_invalidations using btree (invalidated_at desc);
create index idx_bangsel_roulette_invalidations_workspace_id
  on public.bangsel_roulette_invalidations using btree (workspace_id);

-- Stage 6N8 adds workspace_id, device_id and retained_until to this table.
create table public.bangsel_collector_logs (
  id bigint generated by default as identity not null,
  received_at timestamptz default now() not null,
  occurred_at_local text,
  collector_version text,
  session_id text,
  level text default 'error'::text not null,
  event_type text default 'diagnostic'::text not null,
  upload_mode text,
  http_status integer,
  record_count integer,
  accepted_count integer,
  error_type text,
  message text,
  constraint bangsel_collector_logs_pkey primary key (id)
);

create index bangsel_collector_logs_received_at_idx
  on public.bangsel_collector_logs using btree (received_at desc);
create index bangsel_collector_logs_session_idx
  on public.bangsel_collector_logs using btree (session_id,received_at desc);

-- ---------------------------------------------------------------------------
-- Timestamp trigger functions and triggers present on the legacy tables
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.set_fan_station_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.set_bangsel_fans_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.set_bangsel_roulette_rules_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger bangsel_tasks_set_updated_at
before update on public.bangsel_tasks
for each row execute function public.set_updated_at();

create trigger bangsel_fan_stations_set_updated_at
before update on public.bangsel_fan_stations
for each row execute function public.set_fan_station_updated_at();

create trigger trg_bangsel_fans_updated_at
before update on public.bangsel_fans
for each row execute function public.set_bangsel_fans_updated_at();

create trigger trg_bangsel_roulette_rules_updated_at
before update on public.bangsel_roulette_rules
for each row execute function public.set_bangsel_roulette_rules_updated_at();

-- ---------------------------------------------------------------------------
-- Stage 6N7-required RPC surface before p0 creates withdraw_account
-- ---------------------------------------------------------------------------

create or replace function public.get_public_workspace(p_workspace_slug text)
returns table(slug text,display_name text,public_page_enabled boolean)
language sql
stable
security definer
set search_path = public
as $$
  select
    w.slug,
    w.display_name,
    coalesce(w.public_page_enabled,true) as public_page_enabled
  from public.byeollog_workspaces as w
  where w.slug = lower(btrim(p_workspace_slug))
    and w.status = 'active'
  limit 1;
$$;

create or replace function public.get_public_bangsel(
  p_workspace_slug text,
  p_search text default null
)
returns table(fan text,event text,type text,remaining integer,comment text)
language sql
stable
security definer
set search_path = public
as $$
  with ws as (
    select w.id
    from public.byeollog_workspaces as w
    where w.slug = lower(btrim(p_workspace_slug))
      and w.status = 'active'
      and coalesce(w.public_page_enabled,true) = true
    limit 1
  ),
  q as (
    select nullif(lower(btrim(coalesce(p_search,''))), '') as term
  )
  select
    t.fan,
    t.event,
    t.type,
    greatest(t.total_qty-t.done_qty,0)::integer as remaining,
    btrim(split_part(replace(replace(coalesce(t.public_comment,''),E'\\r\\n',E'\\n'),E'\\r',E'\\n'),E'\\n',1)) as comment
  from public.bangsel_tasks as t
  cross join ws
  cross join q
  where t.workspace_id = ws.id
    and t.total_qty > t.done_qty
    and (
      q.term is null
      or lower(coalesce(t.fan,'')) like '%' || q.term || '%'
      or lower(coalesce(t.fan_soop_id,'')) like '%' || q.term || '%'
      or exists (
        select 1
        from public.bangsel_fans as f
        where f.workspace_id = t.workspace_id
          and f.soop_id is not null
          and f.soop_id = t.fan_soop_id
          and (
            lower(coalesce(f.alias,'')) like '%' || q.term || '%'
            or lower(coalesce(f.current_nickname,'')) like '%' || q.term || '%'
          )
      )
    )
  order by t.fan,t.event,t.type,t.created_at;
$$;

create or replace function public.byeollog_approve_signup_application(
  p_application_id uuid,
  p_reviewer uuid default null
)
returns table(workspace_id uuid,workspace_slug text,display_name text)
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.byeollog_signup_applications%rowtype;
  v_workspace_id uuid;
  v_base text;
  v_slug text;
  v_suffix integer := 1;
begin
  select * into a
  from public.byeollog_signup_applications
  where id = p_application_id
  for update;

  if not found then raise exception '가입 신청을 찾을 수 없습니다.'; end if;
  if a.status <> 'pending' then raise exception '이미 처리된 가입 신청입니다.'; end if;
  if a.auth_user_id is null then
    raise exception '인증 계정이 아직 연결되지 않았습니다. 서버에서 Auth 생성 후 다시 승인하세요.';
  end if;
  if exists (select 1 from public.byeollog_workspace_members where user_id = a.auth_user_id) then
    raise exception '이미 워크스페이스에 연결된 계정입니다.';
  end if;

  v_base := lower(coalesce(nullif(btrim(a.soop_id),''),split_part(a.email,'@',1)));
  v_base := regexp_replace(v_base,'[^a-z0-9_-]+','-','g');
  v_base := trim(both '-' from v_base);
  if length(v_base) < 2 then v_base := 'streamer'; end if;
  v_base := left(v_base,48);
  v_slug := v_base;
  while exists (select 1 from public.byeollog_workspaces where lower(slug)=lower(v_slug)) loop
    v_suffix := v_suffix+1;
    v_slug := left(v_base,48-length(v_suffix::text)-1) || '-' || v_suffix::text;
  end loop;

  insert into public.byeollog_workspaces(slug,display_name,status)
  values(v_slug,a.streamer_name,'active')
  returning id into v_workspace_id;

  insert into public.byeollog_workspace_members(user_id,workspace_id,role)
  values(a.auth_user_id,v_workspace_id,'owner');

  update public.byeollog_signup_applications
  set status='approved',workspace_id=v_workspace_id,reviewed_by=p_reviewer,
      reviewed_at=now(),updated_at=now(),rejection_reason=''
  where id=a.id;

  return query select v_workspace_id,v_slug,a.streamer_name;
end;
$$;

-- Every Stage 6N7 table had RLS enabled. Explicit deny policies are intentionally
-- absent here: remote migration 20260823011107 adds them later in the chain.
alter table public.bangsel_collector_logs enable row level security;
alter table public.bangsel_collector_staging enable row level security;
alter table public.bangsel_donations enable row level security;
alter table public.bangsel_fan_stations enable row level security;
alter table public.bangsel_fans enable row level security;
alter table public.bangsel_roulette_invalidations enable row level security;
alter table public.bangsel_roulette_rules enable row level security;
alter table public.bangsel_task_import_items enable row level security;
alter table public.bangsel_tasks enable row level security;
alter table public.byeollog_audit_log enable row level security;
alter table public.byeollog_collector_devices enable row level security;
alter table public.byeollog_dashboard_handoffs enable row level security;
alter table public.byeollog_inquiries enable row level security;
alter table public.byeollog_signup_applications enable row level security;
alter table public.byeollog_workspace_members enable row level security;
alter table public.byeollog_workspace_settings enable row level security;
alter table public.byeollog_workspaces enable row level security;

revoke all on table
  public.bangsel_collector_logs,
  public.bangsel_collector_staging,
  public.bangsel_donations,
  public.bangsel_fan_stations,
  public.bangsel_fans,
  public.bangsel_roulette_invalidations,
  public.bangsel_roulette_rules,
  public.bangsel_task_import_items,
  public.bangsel_tasks,
  public.byeollog_audit_log,
  public.byeollog_collector_devices,
  public.byeollog_dashboard_handoffs,
  public.byeollog_inquiries,
  public.byeollog_signup_applications,
  public.byeollog_workspace_members,
  public.byeollog_workspace_settings,
  public.byeollog_workspaces
from public,anon,authenticated;

grant select,insert,update,delete on table
  public.bangsel_collector_logs,
  public.bangsel_collector_staging,
  public.bangsel_donations,
  public.bangsel_fan_stations,
  public.bangsel_fans,
  public.bangsel_roulette_invalidations,
  public.bangsel_roulette_rules,
  public.bangsel_task_import_items,
  public.bangsel_tasks,
  public.byeollog_audit_log,
  public.byeollog_collector_devices,
  public.byeollog_dashboard_handoffs,
  public.byeollog_inquiries,
  public.byeollog_signup_applications,
  public.byeollog_workspace_members,
  public.byeollog_workspace_settings,
  public.byeollog_workspaces
to service_role;

grant usage,select on sequence
  public.bangsel_collector_logs_id_seq,
  public.byeollog_audit_log_id_seq
to service_role;

revoke all on function public.get_public_workspace(text) from public,anon,authenticated;
grant execute on function public.get_public_workspace(text) to anon,authenticated,service_role;
revoke all on function public.get_public_bangsel(text,text) from public,anon,authenticated;
grant execute on function public.get_public_bangsel(text,text) to anon,authenticated,service_role;
revoke all on function public.byeollog_approve_signup_application(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.byeollog_approve_signup_application(uuid,uuid)
  to service_role;

commit;
