-- Web control-plane drafts are deliberately separate from the dormant SOOP
-- runtime schema. They let streamers prepare multiple roulettes without
-- activating, dispatching, or otherwise changing the current service path.
create table public.byeollog_roulette_drafts (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  roulette_name text not null,
  version_number integer not null default 1 check (version_number between 1 and 2147483647),
  draft jsonb not null check (jsonb_typeof(draft)='object'),
  source_kind text not null default 'manual' check (source_kind in ('manual','weflab_public')),
  source_url text,
  source_fingerprint text,
  created_by_user_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check (char_length(btrim(roulette_name)) between 1 and 120),
  check (source_url is null or char_length(source_url) between 1 and 500),
  check (source_fingerprint is null or source_fingerprint~'^[0-9a-f]{64}$'),
  check (
    source_kind='manual'
    or (source_kind='weflab_public' and source_url is not null and source_fingerprint is not null)
  ),
  unique(workspace_id,id)
);

create index byeollog_roulette_drafts_workspace_updated_idx
  on public.byeollog_roulette_drafts(workspace_id,updated_at desc,id);

alter table public.byeollog_roulette_drafts enable row level security;

create policy explicitly_deny_direct_client_access
  on public.byeollog_roulette_drafts
  for all to anon, authenticated
  using (false) with check (false);

revoke all on table public.byeollog_roulette_drafts
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_roulette_drafts
  to service_role;

comment on table public.byeollog_roulette_drafts is
  'Server-only web drafts. These rows do not activate or execute a roulette.';
