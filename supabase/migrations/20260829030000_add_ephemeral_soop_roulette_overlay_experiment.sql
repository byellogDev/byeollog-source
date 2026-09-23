-- Short-lived control plane for the zero-business-record SOOP roulette test.
-- Donation, chat, draw and result payloads never enter Postgres in this mode.

alter table public.byeollog_soop_runtime_controls
  add column if not exists overlay_experiment_enabled boolean not null default false,
  add column if not exists overlay_experiment_draft_id uuid,
  add column if not exists overlay_experiment_expires_at timestamptz

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname='byeollog_soop_runtime_controls_overlay_experiment_draft_fk'
  ) then
    alter table public.byeollog_soop_runtime_controls
      add constraint byeollog_soop_runtime_controls_overlay_experiment_draft_fk
      foreign key(overlay_experiment_draft_id)
      references public.byeollog_roulette_drafts(id)
      on delete set null;
  end if;
end;
$$

alter table public.byeollog_soop_runtime_controls
  drop constraint if exists byeollog_soop_runtime_controls_overlay_experiment_check

alter table public.byeollog_soop_runtime_controls
  add constraint byeollog_soop_runtime_controls_overlay_experiment_check check (
    (not overlay_experiment_enabled and overlay_experiment_draft_id is null and overlay_experiment_expires_at is null)
    or
    (overlay_experiment_enabled and gateway_enabled and not native_roulette_enabled and overlay_experiment_draft_id is not null and overlay_experiment_expires_at is not null)
  )

comment on column public.byeollog_soop_runtime_controls.overlay_experiment_enabled is
  'Bounded SOOP->roulette overlay experiment. Event/result payloads stay out of Postgres.'
