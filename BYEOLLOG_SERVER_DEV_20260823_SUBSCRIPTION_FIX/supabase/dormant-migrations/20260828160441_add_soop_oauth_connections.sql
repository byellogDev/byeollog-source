-- Dormant until the SOOP OAuth production activation gate is explicitly opened.
-- Tokens are encrypted by the Vercel server before they reach this table.
create table public.byeollog_soop_connections (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  connected_by_user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'connected'
    check (status in ('connected','reauthorization_required','revoked')),
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  access_token_expires_at timestamptz,
  connected_at timestamptz not null default clock_timestamp(),
  refreshed_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(workspace_id),
  check (access_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  check (refresh_token_ciphertext ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'),
  check (last_error_code is null or char_length(last_error_code) between 1 and 120),
  check (
    (status='connected' and revoked_at is null)
    or (status in ('reauthorization_required','revoked'))
  )
);

create index byeollog_soop_connections_status_refresh_idx
  on public.byeollog_soop_connections(status,access_token_expires_at,workspace_id);

alter table public.byeollog_soop_connections enable row level security;

create policy explicitly_deny_direct_client_access
  on public.byeollog_soop_connections
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table public.byeollog_soop_connections
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_soop_connections
  to service_role;

comment on table public.byeollog_soop_connections is
  'Server-only encrypted SOOP OAuth tokens, dormant until the production activation gate opens.';
