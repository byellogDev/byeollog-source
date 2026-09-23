-- Publishing stays explicitly opt-in per roulette. The public HTTP route also
-- has a separate default-off environment gate, so this column alone cannot
-- expose any viewer data.
alter table public.byeollog_roulette_drafts
  add column public_visible boolean not null default false;

create index byeollog_roulette_drafts_public_workspace_idx
  on public.byeollog_roulette_drafts(workspace_id,updated_at desc,id)
  where public_visible;

comment on column public.byeollog_roulette_drafts.public_visible is
  'Per-roulette publication intent. Effective only while the server viewer feature gate is enabled.';
