-- Classification only: this does not restore the retired native roulette runtime.
create table if not exists public.byeollog_roulette_classification_rules (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  roulette_name text not null,
  result_text text not null,
  action text not null default 'review',
  output_types jsonb not null default '[]'::jsonb,
  source_url text,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, roulette_name, result_text),
  constraint byeollog_roulette_classification_name_check
    check (char_length(btrim(roulette_name)) between 1 and 120 and roulette_name !~ '[[:cntrl:]]'),
  constraint byeollog_roulette_classification_result_check
    check (char_length(btrim(result_text)) between 1 and 120 and result_text !~ '[[:cntrl:]]'),
  constraint byeollog_roulette_classification_action_check
    check (action in ('include','exclude','review')),
  constraint byeollog_roulette_classification_outputs_check
    check (jsonb_typeof(output_types)='array' and jsonb_array_length(output_types)<=20),
  constraint byeollog_roulette_classification_source_url_check
    check (source_url is null or char_length(source_url)<=500)
);
create index if not exists idx_byeollog_roulette_classification_workspace_updated
  on public.byeollog_roulette_classification_rules(workspace_id, updated_at desc);
alter table public.byeollog_roulette_classification_rules enable row level security;
revoke all on table public.byeollog_roulette_classification_rules from public, anon, authenticated;
grant select, insert, update, delete on table public.byeollog_roulette_classification_rules to service_role;
comment on table public.byeollog_roulette_classification_rules is
  'Service-only Upbo classification rules scoped by external roulette name and result; no roulette execution state.';
