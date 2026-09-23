-- Additive, server-only, short-lived account handoffs. Legacy devices unchanged.
create table public.byeollog_agent_dashboard_handoffs (
  code_hash text primary key check (code_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  session_epoch bigint not null default 0 check (session_epoch >= 0),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at and expires_at <= created_at + interval '90 seconds')
);
create index byeollog_agent_dashboard_handoffs_expiry_idx on public.byeollog_agent_dashboard_handoffs(expires_at);
create index byeollog_agent_dashboard_handoffs_user_idx on public.byeollog_agent_dashboard_handoffs(user_id);
create index byeollog_agent_dashboard_handoffs_workspace_idx on public.byeollog_agent_dashboard_handoffs(workspace_id);
alter table public.byeollog_agent_dashboard_handoffs enable row level security;
revoke all on public.byeollog_agent_dashboard_handoffs from public,anon,authenticated;
grant select,insert,delete on public.byeollog_agent_dashboard_handoffs to service_role;
comment on table public.byeollog_agent_dashboard_handoffs is 'Server-only 45-second single-use dashboard links; hashed codes only; pruned on issue and deleted on redemption.';


