create table public.byeollog_minecraft_servers (
  id uuid primary key,
  server_key text not null unique
    check (server_key ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  display_name text not null
    check (char_length(btrim(display_name)) between 1 and 80),
  api_key_hash text not null unique
    check (api_key_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  key_rotated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
)

create table public.byeollog_minecraft_server_player_grants (
  server_id uuid not null
    references public.byeollog_minecraft_servers(id) on delete cascade,
  binding_id uuid not null
    references public.byeollog_game_identity_bindings(id) on delete cascade,
  status text not null default 'active'
    check (status in ('active', 'revoked')),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (server_id, binding_id),
  check (
    (status = 'active' and revoked_at is null)
    or (status = 'revoked' and revoked_at is not null)
  )
)

create index byeollog_minecraft_server_player_grants_binding_idx
  on public.byeollog_minecraft_server_player_grants (binding_id, server_id)
  where status = 'active'

create table public.byeollog_minecraft_server_request_nonces (
  server_id uuid not null
    references public.byeollog_minecraft_servers(id) on delete cascade,
  request_id_hash text not null
    check (request_id_hash ~ '^[a-f0-9]{64}$'),
  requested_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (server_id, request_id_hash)
)

create index byeollog_minecraft_server_request_nonces_expiry_idx
  on public.byeollog_minecraft_server_request_nonces (expires_at)

create table public.byeollog_minecraft_server_audit (
  id bigint generated always as identity primary key,
  event_type text not null,
  server_id uuid references public.byeollog_minecraft_servers(id) on delete set null,
  binding_id uuid references public.byeollog_game_identity_bindings(id) on delete set null,
  minecraft_uuid text,
  request_id_hash text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (minecraft_uuid is null or minecraft_uuid ~ '^[a-f0-9]{32}$'),
  check (request_id_hash is null or request_id_hash ~ '^[a-f0-9]{64}$')
)

create index byeollog_minecraft_server_audit_server_time_idx
  on public.byeollog_minecraft_server_audit (server_id, created_at desc)

alter table public.byeollog_minecraft_servers enable row level security

alter table public.byeollog_minecraft_server_player_grants enable row level security

alter table public.byeollog_minecraft_server_request_nonces enable row level security

alter table public.byeollog_minecraft_server_audit enable row level security

revoke all on table public.byeollog_minecraft_servers
  from public, anon, authenticated

revoke all on table public.byeollog_minecraft_server_player_grants
  from public, anon, authenticated

revoke all on table public.byeollog_minecraft_server_request_nonces
  from public, anon, authenticated

revoke all on table public.byeollog_minecraft_server_audit
  from public, anon, authenticated

grant select, insert, update, delete on table public.byeollog_minecraft_servers
  to service_role

grant select, insert, update, delete on table public.byeollog_minecraft_server_player_grants
  to service_role

grant select, insert, delete on table public.byeollog_minecraft_server_request_nonces
  to service_role

grant select, insert on table public.byeollog_minecraft_server_audit
  to service_role

grant usage, select on sequence public.byeollog_minecraft_server_audit_id_seq
  to service_role

create or replace function public.byeollog_authorize_minecraft_server_player(
  p_server_id uuid,
  p_api_key_hash text,
  p_request_id_hash text,
  p_requested_at timestamptz,
  p_minecraft_uuid text
)
returns table (
  server_id uuid,
  binding_id uuid,
  soop_user_id text,
  minecraft_uuid text,
  minecraft_name text
)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_server public.byeollog_minecraft_servers%rowtype;
  v_binding public.byeollog_game_identity_bindings%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_api_key_hash !~ '^[a-f0-9]{64}$'
     or p_request_id_hash !~ '^[a-f0-9]{64}$'
     or p_minecraft_uuid !~ '^[a-f0-9]{32}$' then
    raise exception using message = 'minecraft_server_request_invalid';
  end if;

  if p_requested_at < v_now - interval '5 minutes'
     or p_requested_at > v_now + interval '5 minutes' then
    raise exception using message = 'minecraft_server_request_expired';
  end if;

  select s.* into v_server
  from public.byeollog_minecraft_servers s
  where s.id = p_server_id
    and s.status = 'active'
    and s.api_key_hash = p_api_key_hash;

  if not found then
    raise exception using message = 'minecraft_server_auth_invalid';
  end if;

  delete from public.byeollog_minecraft_server_request_nonces n
  where n.server_id = p_server_id
    and n.expires_at < v_now;

  begin
    insert into public.byeollog_minecraft_server_request_nonces (
      server_id, request_id_hash, requested_at, expires_at
    ) values (
      p_server_id, p_request_id_hash, p_requested_at, v_now + interval '10 minutes'
    );
  exception when unique_violation then
    raise exception using message = 'minecraft_server_request_replayed';
  end;

  select b.* into v_binding
  from public.byeollog_minecraft_server_player_grants g
  join public.byeollog_game_identity_bindings b on b.id = g.binding_id
  where g.server_id = p_server_id
    and g.status = 'active'
    and b.minecraft_uuid = p_minecraft_uuid
    and b.status = 'active';

  if not found then
    insert into public.byeollog_minecraft_server_audit (
      event_type, server_id, minecraft_uuid, request_id_hash
    ) values (
      'minecraft_server_player_lookup_denied',
      p_server_id,
      p_minecraft_uuid,
      p_request_id_hash
    );
    return;
  end if;

  insert into public.byeollog_minecraft_server_audit (
    event_type, server_id, binding_id, minecraft_uuid, request_id_hash
  ) values (
    'minecraft_server_player_lookup_allowed',
    p_server_id,
    v_binding.id,
    v_binding.minecraft_uuid,
    p_request_id_hash
  );

  return query
  select p_server_id, b.id, b.soop_user_id, b.minecraft_uuid, b.minecraft_name
  from public.byeollog_game_identity_bindings b
  where b.id = v_binding.id;
end;
$$

revoke all on function public.byeollog_authorize_minecraft_server_player(
  uuid, text, text, timestamptz, text
) from public, anon, authenticated

grant execute on function public.byeollog_authorize_minecraft_server_player(
  uuid, text, text, timestamptz, text
) to service_role

create or replace function public.byeollog_provision_minecraft_server(
  p_server_id uuid,
  p_server_key text,
  p_display_name text,
  p_api_key_hash text,
  p_minecraft_uuid text
)
returns table (server_id uuid, binding_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_binding_id uuid;
begin
  if p_server_key !~ '^[a-z0-9][a-z0-9_-]{2,63}$'
     or char_length(btrim(p_display_name)) not between 1 and 80
     or p_api_key_hash !~ '^[a-f0-9]{64}$'
     or p_minecraft_uuid !~ '^[a-f0-9]{32}$' then
    raise exception using message = 'minecraft_server_provision_input_invalid';
  end if;

  select b.id into v_binding_id
  from public.byeollog_game_identity_bindings b
  where b.minecraft_uuid = p_minecraft_uuid
    and b.status = 'active';

  if not found then
    raise exception using message = 'minecraft_server_binding_not_found';
  end if;

  insert into public.byeollog_minecraft_servers (
    id, server_key, display_name, api_key_hash
  ) values (
    p_server_id, p_server_key, btrim(p_display_name), p_api_key_hash
  );

  insert into public.byeollog_minecraft_server_player_grants (
    server_id, binding_id
  ) values (
    p_server_id, v_binding_id
  );

  insert into public.byeollog_minecraft_server_audit (
    event_type, server_id, binding_id, minecraft_uuid
  ) values (
    'minecraft_server_provisioned',
    p_server_id,
    v_binding_id,
    p_minecraft_uuid
  );

  return query select p_server_id, v_binding_id;
end;
$$

revoke all on function public.byeollog_provision_minecraft_server(
  uuid, text, text, text, text
) from public, anon, authenticated

grant execute on function public.byeollog_provision_minecraft_server(
  uuid, text, text, text, text
) to service_role

comment on table public.byeollog_minecraft_servers is
  'Server credentials for Minecraft API isolation. Only SHA-256 API key hashes are stored.'

comment on table public.byeollog_minecraft_server_player_grants is
  'Explicit per-server allow-list for globally linked Minecraft identities.'

comment on function public.byeollog_authorize_minecraft_server_player(
  uuid, text, text, timestamptz, text
) is
  'Authenticates one server request, rejects replay, and returns a player only when that server has an active grant.'
