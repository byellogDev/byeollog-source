-- Record the chat message that would be sent only after OBS has visibly
-- completed a roulette landing.  This migration deliberately has no live
-- delivery path: every row is immutable dry-run evidence for later review.

create table byeollog_automation.native_roulette_chat_dry_runs_v1 (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  event_id uuid not null,
  spin_id uuid not null,
  overlay_command_id uuid not null
    references byeollog_automation.native_roulette_overlay_outbox_v2(id) on delete cascade,
  message text not null,
  delivery_mode text not null default 'dry_run'
    check (delivery_mode='dry_run'),
  status text not null default 'recorded'
    check (status='recorded'),
  overlay_client_id text not null,
  overlay_attempt_count integer not null check (overlay_attempt_count between 1 and 20),
  revealed_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  unique(spin_id),
  unique(overlay_command_id),
  foreign key(event_id,workspace_id)
    references byeollog_automation.native_roulette_events_v2(id,workspace_id) on delete cascade,
  foreign key(spin_id,workspace_id)
    references byeollog_automation.native_roulette_spins_v2(id,workspace_id) on delete cascade,
  check (char_length(message) between 1 and 220 and message!~'[[:cntrl:]]'),
  check (char_length(overlay_client_id) between 8 and 180 and overlay_client_id!~'[[:cntrl:]]')
);

create index native_roulette_chat_dry_runs_v1_workspace_revealed_idx
  on byeollog_automation.native_roulette_chat_dry_runs_v1(workspace_id,revealed_at desc);

alter table byeollog_automation.native_roulette_chat_dry_runs_v1 enable row level security;
create policy native_roulette_chat_dry_runs_v1_explicit_deny
  on byeollog_automation.native_roulette_chat_dry_runs_v1
  for all to anon,authenticated using(false) with check(false);

revoke all on table byeollog_automation.native_roulette_chat_dry_runs_v1
  from public,anon,authenticated,service_role;

comment on table byeollog_automation.native_roulette_chat_dry_runs_v1 is
  'Dry-run-only record of the exact streamer chat text requested after an OBS roulette result became visible. No live sender reads this table.';

create or replace function public.record_native_roulette_chat_dry_run_v1(
  p_workspace_id uuid,
  p_token_version uuid,
  p_command_id uuid,
  p_client_id text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_command byeollog_automation.native_roulette_overlay_outbox_v2%rowtype;
  v_spin byeollog_automation.native_roulette_spins_v2%rowtype;
  v_existing byeollog_automation.native_roulette_chat_dry_runs_v1%rowtype;
  v_inserted byeollog_automation.native_roulette_chat_dry_runs_v1%rowtype;
  v_message text;
begin
  if p_workspace_id is null or p_token_version is null or p_command_id is null
     or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
  then
    raise exception 'native roulette chat dry-run identity is invalid' using errcode='22023';
  end if;

  if not exists(
    select 1
    from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id
      and service.state='active'
      and service.overlay_token_version=p_token_version
      and service.overlay_client_id=btrim(p_client_id)
  )
  then
    raise exception 'native roulette overlay client is unavailable' using errcode='55000';
  end if;

  select * into v_command
  from byeollog_automation.native_roulette_overlay_outbox_v2 command
  where command.id=p_command_id
    and command.workspace_id=p_workspace_id
    and command.command_kind='roulette_spin'
    and command.spin_id is not null
  for update;

  if not found
     or v_command.client_id is distinct from btrim(p_client_id)
     or v_command.status not in ('processing','succeeded')
     or (v_command.status='processing' and v_command.lease_expires_at<=clock_timestamp())
     or (v_command.status='succeeded' and (
       v_command.processed_at is null
       or v_command.processed_at<clock_timestamp()-interval '5 minutes'))
  then
    raise exception 'native roulette reveal command is unavailable' using errcode='55000';
  end if;

  select * into strict v_spin
  from byeollog_automation.native_roulette_spins_v2 spin
  where spin.id=v_command.spin_id
    and spin.event_id=v_command.event_id
    and spin.workspace_id=p_workspace_id;

  v_message:='룰렛 결과 : '||btrim(v_spin.result_text);

  insert into byeollog_automation.native_roulette_chat_dry_runs_v1(
    workspace_id,event_id,spin_id,overlay_command_id,message,
    overlay_client_id,overlay_attempt_count)
  values(
    p_workspace_id,v_command.event_id,v_spin.id,v_command.id,v_message,
    btrim(p_client_id),v_command.attempt_count)
  on conflict(spin_id) do nothing
  returning * into v_inserted;

  if found then
    return jsonb_build_object(
      'dryRunId',v_inserted.id,
      'commandId',v_command.id,
      'spinId',v_spin.id,
      'message',v_inserted.message,
      'status',v_inserted.status,
      'revealedAt',v_inserted.revealed_at,
      'idempotent',false);
  end if;

  select * into strict v_existing
  from byeollog_automation.native_roulette_chat_dry_runs_v1 dry_run
  where dry_run.spin_id=v_spin.id;

  if v_existing.workspace_id<>p_workspace_id
     or v_existing.overlay_command_id<>v_command.id
     or v_existing.message<>v_message
  then
    raise exception 'native roulette chat dry-run identity changed' using errcode='40001';
  end if;

  return jsonb_build_object(
    'dryRunId',v_existing.id,
    'commandId',v_command.id,
    'spinId',v_spin.id,
    'message',v_existing.message,
    'status',v_existing.status,
    'revealedAt',v_existing.revealed_at,
    'idempotent',true);
end
$function$;

revoke all on function public.record_native_roulette_chat_dry_run_v1(
  uuid,uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.record_native_roulette_chat_dry_run_v1(
  uuid,uuid,uuid,text)
  to service_role;

comment on function public.record_native_roulette_chat_dry_run_v1(
  uuid,uuid,uuid,text) is
  'Records exactly one dry-run chat message for a roulette spin after its lease-owning OBS client reports the visible result landing.';
