create table if not exists public.byeollog_game_link_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  browser_token_hash text not null unique check (browser_token_hash ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('soop_pending', 'soop_verified', 'microsoft_pending', 'completed', 'expired')),
  soop_user_id text check (soop_user_id is null or soop_user_id ~ '^[a-z0-9_.-]{2,80}$'),
  soop_oauth_state_hash text check (soop_oauth_state_hash is null or soop_oauth_state_hash ~ '^[a-f0-9]{64}$'),
  microsoft_oauth_state_hash text check (microsoft_oauth_state_hash is null or microsoft_oauth_state_hash ~ '^[a-f0-9]{64}$'),
  pkce_verifier_ciphertext text,
  expires_at timestamptz not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

create index if not exists byeollog_game_link_sessions_expiry_idx
  on public.byeollog_game_link_sessions (expires_at)
  where status <> 'completed'

create table if not exists public.byeollog_game_identity_bindings (
  id uuid primary key default extensions.gen_random_uuid(),
  soop_user_id text not null unique check (soop_user_id ~ '^[a-z0-9_.-]{2,80}$'),
  minecraft_uuid text not null unique check (minecraft_uuid ~ '^[a-f0-9]{32}$'),
  minecraft_name text not null check (minecraft_name ~ '^[A-Za-z0-9_]{3,16}$'),
  byeollog_user_id uuid references auth.users(id) on delete set null,
  workspace_id uuid references public.byeollog_workspaces(id) on delete set null,
  status text not null default 'active' check (status in ('active', 'suspended', 'unlinked')),
  linked_at timestamptz not null default now(),
  verified_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

create index if not exists byeollog_game_identity_bindings_workspace_idx
  on public.byeollog_game_identity_bindings (workspace_id)
  where workspace_id is not null

create table if not exists public.byeollog_game_identity_audit (
  id bigint generated always as identity primary key,
  event_type text not null,
  binding_id uuid references public.byeollog_game_identity_bindings(id) on delete set null,
  soop_user_id text,
  minecraft_uuid text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
)

create index if not exists byeollog_game_identity_audit_binding_time_idx
  on public.byeollog_game_identity_audit (binding_id, created_at desc)

alter table public.byeollog_game_link_sessions enable row level security

alter table public.byeollog_game_identity_bindings enable row level security

alter table public.byeollog_game_identity_audit enable row level security

revoke all on table public.byeollog_game_link_sessions from anon, authenticated

revoke all on table public.byeollog_game_identity_bindings from anon, authenticated

revoke all on table public.byeollog_game_identity_audit from anon, authenticated

grant select, insert, update, delete on table public.byeollog_game_link_sessions to service_role

grant select, insert, update, delete on table public.byeollog_game_identity_bindings to service_role

grant select, insert on table public.byeollog_game_identity_audit to service_role

grant usage, select on sequence public.byeollog_game_identity_audit_id_seq to service_role

create or replace function public.byeollog_complete_game_link(
  p_session_token_hash text,
  p_microsoft_state_hash text,
  p_minecraft_uuid text,
  p_minecraft_name text,
  p_entitlement_count integer default 0
)
returns table (
  id uuid,
  soop_user_id text,
  minecraft_uuid text,
  minecraft_name text,
  byeollog_user_id uuid,
  workspace_id uuid,
  status text,
  linked_at timestamptz,
  verified_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_session public.byeollog_game_link_sessions%rowtype;
  v_binding public.byeollog_game_identity_bindings%rowtype;
  v_byeollog_user_id uuid;
  v_workspace_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_microsoft_state_hash !~ '^[a-f0-9]{64}$'
     or p_minecraft_uuid !~ '^[a-f0-9]{32}$'
     or p_minecraft_name !~ '^[A-Za-z0-9_]{3,16}$' then
    raise exception using message = 'game_link_input_invalid';
  end if;

  select s.* into v_session
  from public.byeollog_game_link_sessions s
  where s.browser_token_hash = p_session_token_hash
  for update;

  if not found then
    raise exception using message = 'game_link_session_not_found';
  end if;
  if v_session.status <> 'microsoft_pending' or v_session.expires_at <= v_now then
    raise exception using message = 'game_link_session_expired_or_invalid';
  end if;
  if v_session.microsoft_oauth_state_hash is distinct from p_microsoft_state_hash then
    raise exception using message = 'microsoft_oauth_state_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('soop:' || v_session.soop_user_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('minecraft:' || p_minecraft_uuid, 0));

  select b.* into v_binding
  from public.byeollog_game_identity_bindings b
  where b.soop_user_id = v_session.soop_user_id
  for update;

  if found and v_binding.minecraft_uuid <> p_minecraft_uuid then
    raise exception using message = 'game_link_soop_conflict';
  end if;

  if not found then
    select b.* into v_binding
    from public.byeollog_game_identity_bindings b
    where b.minecraft_uuid = p_minecraft_uuid
    for update;

    if found and v_binding.soop_user_id <> v_session.soop_user_id then
      raise exception using message = 'game_link_minecraft_conflict';
    end if;
  end if;

  -- A person may link a game before or after joining Byeollog. SOOP is the
  -- canonical anchor, so an existing active workspace is attached here and a
  -- later workspace creation is handled by the trigger below.
  select w.owner_user_id, w.id
  into v_byeollog_user_id, v_workspace_id
  from public.byeollog_workspaces w
  where lower(btrim(w.soop_id)) = v_session.soop_user_id
    and w.status = 'active'
    and w.owner_user_id is not null
  limit 1;

  if v_binding.id is null then
    insert into public.byeollog_game_identity_bindings (
      soop_user_id, minecraft_uuid, minecraft_name, byeollog_user_id, workspace_id,
      status, linked_at, verified_at, updated_at
    ) values (
      v_session.soop_user_id, p_minecraft_uuid, p_minecraft_name,
      v_byeollog_user_id, v_workspace_id, 'active', v_now, v_now, v_now
    ) returning * into v_binding;
  else
    update public.byeollog_game_identity_bindings b
    set minecraft_name = p_minecraft_name,
        byeollog_user_id = coalesce(v_byeollog_user_id, b.byeollog_user_id),
        workspace_id = coalesce(v_workspace_id, b.workspace_id),
        status = 'active',
        verified_at = v_now,
        updated_at = v_now
    where b.id = v_binding.id
    returning * into v_binding;
  end if;

  update public.byeollog_game_link_sessions s
  set status = 'completed',
      microsoft_oauth_state_hash = null,
      pkce_verifier_ciphertext = null,
      completed_at = v_now,
      updated_at = v_now
  where s.id = v_session.id;

  insert into public.byeollog_game_identity_audit (
    event_type, binding_id, soop_user_id, minecraft_uuid, details, created_at
  ) values (
    'game_link_completed',
    v_binding.id,
    v_binding.soop_user_id,
    v_binding.minecraft_uuid,
    jsonb_build_object(
      'minecraft_name', v_binding.minecraft_name,
      'entitlement_count', greatest(coalesce(p_entitlement_count, 0), 0)
    ),
    v_now
  );

  return query
  select b.id, b.soop_user_id, b.minecraft_uuid, b.minecraft_name,
         b.byeollog_user_id, b.workspace_id,
         b.status, b.linked_at, b.verified_at, b.updated_at
  from public.byeollog_game_identity_bindings b
  where b.id = v_binding.id;
end;
$$

revoke all on function public.byeollog_complete_game_link(text, text, text, text, integer)
  from public, anon, authenticated

grant execute on function public.byeollog_complete_game_link(text, text, text, text, integer)
  to service_role

-- Joining Byeollog after linking Minecraft must enrich the existing binding,
-- never create a second identity. This fires inside the existing atomic signup
-- transaction when its workspace row is inserted.
create or replace function public.byeollog_attach_game_identity_to_workspace_v1()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_binding public.byeollog_game_identity_bindings%rowtype;
  v_old_binding public.byeollog_game_identity_bindings%rowtype;
  v_soop_user_id text := lower(btrim(new.soop_id));
begin
  if tg_op = 'UPDATE'
     and old.soop_id is not null
     and lower(btrim(old.soop_id)) is distinct from v_soop_user_id then
    update public.byeollog_game_identity_bindings b
    set byeollog_user_id = null,
        workspace_id = null,
        updated_at = clock_timestamp()
    where b.workspace_id = new.id
    returning b.* into v_old_binding;

    if v_old_binding.id is not null then
      insert into public.byeollog_game_identity_audit (
        event_type, binding_id, soop_user_id, minecraft_uuid, details
      ) values (
        'game_link_byeollog_account_detached',
        v_old_binding.id,
        v_old_binding.soop_user_id,
        v_old_binding.minecraft_uuid,
        jsonb_build_object('workspace_id', new.id)
      );
    end if;
  end if;

  if v_soop_user_id is null
     or v_soop_user_id = ''
     or new.owner_user_id is null
     or new.status <> 'active' then
    return new;
  end if;

  select b.* into v_binding
  from public.byeollog_game_identity_bindings b
  where b.soop_user_id = v_soop_user_id
  for update;

  if found
     and (v_binding.byeollog_user_id is distinct from new.owner_user_id
          or v_binding.workspace_id is distinct from new.id) then
    update public.byeollog_game_identity_bindings b
    set byeollog_user_id = new.owner_user_id,
        workspace_id = new.id,
        updated_at = clock_timestamp()
    where b.id = v_binding.id
    returning b.* into v_binding;

    insert into public.byeollog_game_identity_audit (
      event_type, binding_id, soop_user_id, minecraft_uuid, details
    ) values (
      'game_link_byeollog_account_attached',
      v_binding.id,
      v_binding.soop_user_id,
      v_binding.minecraft_uuid,
      jsonb_build_object(
        'workspace_id', new.id,
        'byeollog_user_id', new.owner_user_id
      )
    );
  end if;

  return new;
end;
$$

revoke all on function public.byeollog_attach_game_identity_to_workspace_v1()
  from public, anon, authenticated, service_role

drop trigger if exists byeollog_attach_game_identity_to_workspace_v1
  on public.byeollog_workspaces

create trigger byeollog_attach_game_identity_to_workspace_v1
after insert or update of soop_id, owner_user_id, status
on public.byeollog_workspaces
for each row execute function public.byeollog_attach_game_identity_to_workspace_v1()

-- Idempotent backfill for accounts that already existed when this migration ran.
update public.byeollog_game_identity_bindings b
set byeollog_user_id = w.owner_user_id,
    workspace_id = w.id,
    updated_at = clock_timestamp()
from public.byeollog_workspaces w
where lower(btrim(w.soop_id)) = b.soop_user_id
  and w.status = 'active'
  and w.owner_user_id is not null
  and (b.byeollog_user_id is distinct from w.owner_user_id
       or b.workspace_id is distinct from w.id)

comment on table public.byeollog_game_identity_bindings is
  'SOOP-anchored Minecraft binding, optionally attached to a later Byeollog signup. OAuth access and refresh tokens are never stored here.'

comment on table public.byeollog_game_link_sessions is
  'Short-lived server-only OAuth linking state. Delete expired rows with routine maintenance.'
