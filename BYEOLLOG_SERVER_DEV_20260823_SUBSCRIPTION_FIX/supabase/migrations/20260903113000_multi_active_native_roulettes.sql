-- A workspace may run several roulettes at once. Trigger amounts remain
-- exclusive so one donation can never ambiguously select two roulettes.

create table if not exists public.byeollog_native_roulette_activations (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  draft_id uuid not null,
  draft_version integer not null check (draft_version>=1),
  activation_snapshot jsonb not null,
  trigger_amounts bigint[] not null,
  activated_by_user_id uuid,
  activated_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,draft_id),
  foreign key(workspace_id,draft_id)
    references public.byeollog_roulette_drafts(workspace_id,id) on delete restrict,
  check (cardinality(trigger_amounts) between 1 and 2),
  check (array_position(trigger_amounts,0) is null)
);

create index if not exists byeollog_native_roulette_activations_trigger_idx
  on public.byeollog_native_roulette_activations using gin(trigger_amounts);

alter table public.byeollog_native_roulette_activations enable row level security;
create policy byeollog_native_roulette_activations_service_only
  on public.byeollog_native_roulette_activations for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_native_roulette_activations from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_native_roulette_activations to service_role;

comment on table public.byeollog_native_roulette_activations is
  'Service-only active roulette registry. Trigger amounts are unique per workspace; the legacy service row remains the shared overlay and gateway control plane.';

-- Preserve every currently running roulette when this migration lands.
insert into public.byeollog_native_roulette_activations(
  workspace_id,draft_id,draft_version,activation_snapshot,trigger_amounts,
  activated_by_user_id,activated_at,updated_at)
select service.workspace_id,service.active_draft_id,service.active_draft_version,
  service.activation_snapshot,
  array_remove(array[
    (service.activation_snapshot->>'balloonsPerSpin')::bigint,
    case when coalesce((service.activation_snapshot->>'seriesEnabled')::boolean,false)
      then (service.activation_snapshot->>'seriesBalloons')::bigint end
  ],null),service.activated_by_user_id,service.activated_at,service.updated_at
from public.byeollog_native_roulette_services service
where service.state='active' and service.active_draft_id is not null
  and service.activation_snapshot is not null
on conflict(workspace_id,draft_id) do nothing;

create or replace function public.activate_native_roulette_draft_v3(
  p_workspace_id uuid,p_authorized_user_id uuid,p_draft_id uuid,p_snapshot jsonb,
  p_expected_draft_version integer,
  p_sound_volume_percent integer default 80,p_tts_volume_percent integer default 80)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_draft public.byeollog_roulette_drafts%rowtype;
  v_service public.byeollog_native_roulette_services%rowtype;
  v_amounts bigint[];
  v_conflict public.byeollog_native_roulette_activations%rowtype;
  v_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  perform byeollog_automation.assert_native_roulette_snapshot_v2(p_snapshot);
  if p_draft_id is null or p_expected_draft_version is null or p_expected_draft_version<1
     or p_sound_volume_percent not between 0 and 100
     or p_tts_volume_percent not between 0 and 100 then
    raise exception 'native roulette activation request is invalid' using errcode='22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('native-roulette-active-set:'||p_workspace_id::text,8273));

  select * into v_draft from public.byeollog_roulette_drafts
  where workspace_id=p_workspace_id and id=p_draft_id for update;
  if not found then raise exception 'roulette draft was not found' using errcode='P0002'; end if;
  if v_draft.version_number<>p_expected_draft_version then
    raise exception 'roulette draft version changed before activation'
      using errcode='P0001',detail='stale_draft_version';
  end if;

  v_amounts:=array_remove(array[
    (p_snapshot->>'balloonsPerSpin')::bigint,
    case when coalesce((p_snapshot->>'seriesEnabled')::boolean,false)
      then (p_snapshot->>'seriesBalloons')::bigint end
  ],null);

  select activation.* into v_conflict
  from public.byeollog_native_roulette_activations activation
  where activation.workspace_id=p_workspace_id
    and activation.draft_id<>p_draft_id
    and activation.trigger_amounts&&v_amounts
  order by activation.activated_at limit 1;
  if found then
    raise exception 'roulette trigger amount overlaps an active roulette'
      using errcode='23505',detail=array_to_string(
        array(select unnest(v_conflict.trigger_amounts) intersect select unnest(v_amounts)),',');
  end if;

  insert into public.byeollog_native_roulette_activations(
    workspace_id,draft_id,draft_version,activation_snapshot,trigger_amounts,
    activated_by_user_id,activated_at,updated_at)
  values(p_workspace_id,p_draft_id,v_draft.version_number,p_snapshot,v_amounts,
    p_authorized_user_id,clock_timestamp(),clock_timestamp())
  on conflict(workspace_id,draft_id) do update set
    draft_version=excluded.draft_version,
    activation_snapshot=excluded.activation_snapshot,
    trigger_amounts=excluded.trigger_amounts,
    activated_by_user_id=excluded.activated_by_user_id,
    updated_at=clock_timestamp();

  insert into public.byeollog_native_roulette_services(
    workspace_id,active_draft_id,active_draft_version,activation_snapshot,state,
    service_revision,sound_volume_percent,tts_volume_percent,activated_by_user_id,
    activated_at,paused_at,updated_at)
  values(p_workspace_id,p_draft_id,v_draft.version_number,p_snapshot,'active',1,
    p_sound_volume_percent,p_tts_volume_percent,p_authorized_user_id,
    clock_timestamp(),null,clock_timestamp())
  on conflict(workspace_id) do update set
    active_draft_id=excluded.active_draft_id,
    active_draft_version=excluded.active_draft_version,
    activation_snapshot=excluded.activation_snapshot,
    state='active',service_revision=public.byeollog_native_roulette_services.service_revision+1,
    sound_volume_percent=excluded.sound_volume_percent,
    tts_volume_percent=excluded.tts_volume_percent,
    activated_by_user_id=excluded.activated_by_user_id,
    activated_at=clock_timestamp(),paused_at=null,updated_at=clock_timestamp()
  returning * into v_service;

  insert into public.byeollog_soop_runtime_controls(
    workspace_id,gateway_enabled,native_roulette_enabled,synthetic_test_enabled,
    live_diagnostics_enabled,overlay_experiment_enabled,updated_by_user_id)
  values(p_workspace_id,true,true,false,true,false,p_authorized_user_id)
  on conflict(workspace_id) do update set
    gateway_enabled=true,native_roulette_enabled=true,synthetic_test_enabled=false,
    live_diagnostics_enabled=true,overlay_experiment_enabled=false,
    overlay_experiment_draft_id=null,overlay_experiment_expires_at=null,
    updated_by_user_id=p_authorized_user_id,updated_at=clock_timestamp();

  select count(*)::integer into v_count
  from public.byeollog_native_roulette_activations activation
  where activation.workspace_id=p_workspace_id;
  return jsonb_build_object('active',true,'draftId',p_draft_id,
    'draftVersion',v_draft.version_number,'activeRouletteCount',v_count,
    'serviceRevision',v_service.service_revision,
    'overlayTokenVersion',v_service.overlay_token_version,'activatedAt',v_service.activated_at);
end
$function$;

revoke all on function public.activate_native_roulette_draft_v3(
  uuid,uuid,uuid,jsonb,integer,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.activate_native_roulette_draft_v3(
  uuid,uuid,uuid,jsonb,integer,integer,integer) to service_role;

-- Compatibility entry point for already deployed callers. The old implementation
-- compared raw JSON with a normalized snapshot and raised SQLSTATE 40001. Clients
-- correctly retry 40001, so a harmless representation difference became an
-- unbounded activation storm. Resolve the current version once and delegate to
-- the non-retryable, version-aware implementation instead.
create or replace function public.activate_native_roulette_service_v2(
  p_workspace_id uuid,p_authorized_user_id uuid,p_draft_id uuid,p_snapshot jsonb,
  p_sound_volume_percent integer default 80,p_tts_volume_percent integer default 80)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare v_draft_version integer;
begin
  select draft.version_number into v_draft_version
  from public.byeollog_roulette_drafts draft
  where draft.workspace_id=p_workspace_id and draft.id=p_draft_id;
  if not found then
    raise exception 'roulette draft was not found' using errcode='P0002';
  end if;
  return public.activate_native_roulette_draft_v3(
    p_workspace_id,p_authorized_user_id,p_draft_id,p_snapshot,v_draft_version,
    p_sound_volume_percent,p_tts_volume_percent);
end
$function$;

revoke all on function public.activate_native_roulette_service_v2(
  uuid,uuid,uuid,jsonb,integer,integer) from public,anon,authenticated,service_role;
grant execute on function public.activate_native_roulette_service_v2(
  uuid,uuid,uuid,jsonb,integer,integer) to service_role;

create or replace function public.deactivate_native_roulette_draft_v3(
  p_workspace_id uuid,p_authorized_user_id uuid,p_draft_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_remaining public.byeollog_native_roulette_activations%rowtype;
  v_removed integer;
  v_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('native-roulette-active-set:'||p_workspace_id::text,8273));
  delete from public.byeollog_native_roulette_activations
  where workspace_id=p_workspace_id and draft_id=p_draft_id;
  get diagnostics v_removed=row_count;
  if v_removed=0 then raise exception 'active roulette was not found' using errcode='P0002'; end if;

  select * into v_remaining from public.byeollog_native_roulette_activations
  where workspace_id=p_workspace_id order by updated_at desc,draft_id limit 1;
  if found then
    update public.byeollog_native_roulette_services set
      active_draft_id=v_remaining.draft_id,
      active_draft_version=v_remaining.draft_version,
      activation_snapshot=v_remaining.activation_snapshot,
      state='active',service_revision=service_revision+1,
      updated_at=clock_timestamp()
    where workspace_id=p_workspace_id;
  else
    update public.byeollog_native_roulette_services set
      state='paused',service_revision=service_revision+1,
      paused_at=clock_timestamp(),updated_at=clock_timestamp()
    where workspace_id=p_workspace_id;
    update public.byeollog_soop_runtime_controls set
      gateway_enabled=false,native_roulette_enabled=false,
      updated_by_user_id=p_authorized_user_id,updated_at=clock_timestamp()
    where workspace_id=p_workspace_id;
  end if;
  select count(*)::integer into v_count from public.byeollog_native_roulette_activations
  where workspace_id=p_workspace_id;
  return jsonb_build_object('active',v_count>0,'removed',true,
    'draftId',p_draft_id,'activeRouletteCount',v_count);
end
$function$;

revoke all on function public.deactivate_native_roulette_draft_v3(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.deactivate_native_roulette_draft_v3(uuid,uuid,uuid)
  to service_role;

create or replace function byeollog_automation.active_native_roulette_snapshot_v1(
  p_workspace_id uuid,p_amount bigint)
returns jsonb
language sql
stable
set search_path=''
as $function$
  select activation.activation_snapshot
  from public.byeollog_native_roulette_activations activation
  where activation.workspace_id=p_workspace_id
    and activation.trigger_amounts@>array[p_amount]
  limit 1
$function$;

revoke all on function byeollog_automation.active_native_roulette_snapshot_v1(uuid,bigint)
  from public,anon,authenticated,service_role;

-- Keep the established hot path and sampler, changing only the indexed
-- snapshot lookup from one service snapshot to the matching active row.
create or replace function public.ingest_native_roulette_soop_donation_v2(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_service public.byeollog_native_roulette_services%rowtype;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_existing byeollog_automation.native_roulette_events_v2%rowtype;
  v_snapshot jsonb;v_trigger_kind text;v_spin_count integer:=0;v_spin_index integer;
  v_sample integer;v_item jsonb;v_spin_id uuid;v_direct boolean;v_regular_count integer:=0;
  v_message text;v_window integer;v_buffer byeollog_automation.native_roulette_chat_buffer_v2%rowtype;
  v_image jsonb;v_asset_key text;v_command jsonb;v_item_names jsonb;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 200
     or p_event_id~'[[:cntrl:]]' or char_length(btrim(p_actor_id)) not between 1 and 180
     or p_actor_id~'[[:cntrl:]]' or char_length(btrim(p_actor_name)) not between 1 and 120
     or p_actor_name~'[[:cntrl:]]' or p_amount not between 1 and 1000000000000
     or p_occurred_at is null or p_occurred_at>clock_timestamp()+interval '2 minutes'
     or (p_message is not null and (char_length(p_message)>1000 or p_message~'[[:cntrl:]]'))
  then raise exception 'native roulette SOOP donation is invalid' using errcode='22023'; end if;

  select * into v_service from public.byeollog_native_roulette_services
    where workspace_id=p_workspace_id and state='active';
  if not found then raise exception 'native roulette is not active' using errcode='55000'; end if;

  v_snapshot:=byeollog_automation.active_native_roulette_snapshot_v1(p_workspace_id,p_amount);
  if v_snapshot is not null then
    if p_amount=(v_snapshot->>'balloonsPerSpin')::bigint then
      v_trigger_kind:='single';v_spin_count:=1;
      v_image:=coalesce(v_snapshot->'customSingleImage','null'::jsonb);
    elsif coalesce((v_snapshot->>'seriesEnabled')::boolean,false)
      and p_amount=(v_snapshot->>'seriesBalloons')::bigint then
      v_trigger_kind:='series';v_spin_count:=(v_snapshot->>'seriesSpinCount')::integer;
      v_image:=coalesce(v_snapshot->'customSeriesImage',v_snapshot->'customSingleImage','null'::jsonb);
    end if;
  end if;

  insert into byeollog_automation.native_roulette_events_v2(
    workspace_id,service_revision,provider_event_id,actor_id,actor_name,amount,message,
    occurred_at,trigger_kind,spin_count,status)
  values(p_workspace_id,v_service.service_revision,btrim(p_event_id),lower(btrim(p_actor_id)),
    btrim(p_actor_name),p_amount,nullif(btrim(p_message),''),p_occurred_at,
    v_trigger_kind,v_spin_count,case when v_spin_count=0 then 'ignored' else 'queued' end)
  on conflict(workspace_id,provider_event_id) do nothing returning * into v_event;
  if not found then
    select * into strict v_existing from byeollog_automation.native_roulette_events_v2
      where workspace_id=p_workspace_id and provider_event_id=btrim(p_event_id);
    if v_existing.actor_id<>lower(btrim(p_actor_id)) or v_existing.amount<>p_amount
       or v_existing.occurred_at<>p_occurred_at
    then raise exception 'native roulette SOOP event identity changed' using errcode='40001'; end if;
    return jsonb_build_object('duplicate',true,'eventId',v_existing.id,
      'spinCount',v_existing.spin_count,'status',v_existing.status,
      'dataIsolation','pre_approval','upboWrites',0);
  end if;
  if v_spin_count=0 then
    return jsonb_build_object('duplicate',false,'eventId',v_event.id,'spinCount',0,
      'status','ignored','dataIsolation','pre_approval','upboWrites',0);
  end if;

  v_asset_key:=v_snapshot->>'overlayAssetKey';
  select jsonb_agg(item->>'resultText' order by ordinality) into v_item_names
  from jsonb_array_elements(v_snapshot->'items') with ordinality valueset(item,ordinality);
  for v_spin_index in 0..v_spin_count-1 loop
    v_sample:=byeollog_automation.native_roulette_sample_ppm_v1();
    select item into strict v_item from (
      select item,sum((item->>'probabilityPpm')::integer) over(order by ordinality) upper_bound
      from jsonb_array_elements(v_snapshot->'items') with ordinality valueset(item,ordinality)
    ) chosen where v_sample<chosen.upper_bound order by chosen.upper_bound limit 1;
    v_direct:=(v_item->>'directUpbo')::boolean;
    insert into byeollog_automation.native_roulette_spins_v2(
      event_id,workspace_id,spin_index,sample_ppm,result_text,direct_upbo,item_snapshot)
    values(v_event.id,p_workspace_id,v_spin_index,v_sample,v_item->>'resultText',v_direct,v_item)
    returning id into v_spin_id;

    v_regular_count:=v_regular_count+1;
    v_command:=jsonb_build_object(
      'schemaVersion',6,'kind','roulette_spin','commandId',v_spin_id,
      'rouletteName',v_snapshot->>'name','triggerKind',v_trigger_kind,
      'spinIndex',v_spin_index,'spinCount',v_spin_count,
      'actor',jsonb_build_object('name',btrim(p_actor_name)),
      'amount',p_amount,'resultText',v_item->>'resultText','rouletteItems',v_item_names,
      'ttsText',coalesce(nullif(v_item->>'ttsText',''),(v_item->>'resultText')||', 당첨!'),
      'ttsVolumePercent',v_service.tts_volume_percent,
      'soundVolumePercent',v_service.sound_volume_percent,
      'overlayAssetKey',v_asset_key,'customImage',v_image,
      'dataIsolation','pre_approval','upboRequested',v_direct,'upboSuppressed',v_direct);
    insert into byeollog_automation.native_roulette_overlay_outbox_v2(
      workspace_id,event_id,spin_id,command_kind,payload)
    values(p_workspace_id,v_event.id,v_spin_id,'roulette_spin',v_command);
  end loop;

  v_message:=nullif(left(btrim(p_message),300),'');
  v_window:=greatest(0,least(120,coalesce(
    (v_snapshot->>'followupChatTtsWindowSeconds')::integer,30)));
  if v_message is not null then
    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
  elsif v_window>0 then
    select * into v_buffer from byeollog_automation.native_roulette_chat_buffer_v2
    where workspace_id=p_workspace_id and actor_id=lower(btrim(p_actor_id))
      and consumed_event_id is null and occurred_at between p_occurred_at
        and p_occurred_at+pg_catalog.make_interval(secs=>v_window)
    order by occurred_at,received_at limit 1 for update;
    if found then
      update byeollog_automation.native_roulette_chat_buffer_v2
        set consumed_event_id=v_event.id
        where workspace_id=p_workspace_id and provider_chat_id=v_buffer.provider_chat_id;
      perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
        v_event,v_buffer.message,v_buffer.provider_chat_id,
        round(extract(epoch from(v_buffer.occurred_at-p_occurred_at)))::integer,
        'followup_chat',v_service.tts_volume_percent);
    else
      insert into byeollog_automation.native_roulette_chat_waits_v2(
        event_id,workspace_id,actor_id,actor_name,opens_at,expires_at)
      values(v_event.id,p_workspace_id,lower(btrim(p_actor_id)),btrim(p_actor_name),p_occurred_at,
        p_occurred_at+pg_catalog.make_interval(secs=>v_window));
    end if;
  end if;

  update byeollog_automation.native_roulette_events_v2 set status='queued' where id=v_event.id;
  return jsonb_build_object('duplicate',false,'eventId',v_event.id,
    'spinCount',v_spin_count,'presentationCount',v_regular_count,'status','queued',
    'dataIsolation','pre_approval','upboWrites',0);
end
$function$;

revoke all on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;

-- Dashboard donation tests use the same active-set resolver and stay isolated.
create or replace function public.enqueue_native_overlay_donation_test_v1(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_service public.byeollog_native_roulette_services%rowtype;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_existing byeollog_automation.native_roulette_events_v2%rowtype;
  v_snapshot jsonb;v_trigger_kind text;v_spin_count integer:=0;v_spin_index integer;
  v_sample integer;v_item jsonb;v_spin_id uuid;v_direct boolean;v_command jsonb;
  v_image jsonb;v_asset_key text;v_signature jsonb;v_ceremony jsonb;v_item_names jsonb;
  v_message text;v_recent_count integer:=0;v_presentation_count integer:=0;
begin
  if p_workspace_id is null
     or p_event_id!~'^overlay-test:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_actor_id<>'byeollog-overlay-test' or p_actor_name<>'후원 테스트'
     or p_amount not between 1 and 1000000 or p_occurred_at is null
     or p_occurred_at not between clock_timestamp()-interval '1 minute' and clock_timestamp()+interval '10 seconds'
     or (p_message is not null and (char_length(p_message)>120 or p_message~'[[:cntrl:]]'))
  then raise exception 'overlay donation test input is invalid' using errcode='22023'; end if;

  select count(*) into v_recent_count from byeollog_automation.native_roulette_events_v2 event
  where event.workspace_id=p_workspace_id and event.is_test
    and event.received_at>clock_timestamp()-interval '1 minute';
  if v_recent_count>=12 then raise exception 'overlay donation test rate limit exceeded' using errcode='P0001'; end if;

  select * into v_service from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id and service.state='active';
  if not found then raise exception 'native roulette is not active' using errcode='55000'; end if;

  v_snapshot:=byeollog_automation.active_native_roulette_snapshot_v1(p_workspace_id,p_amount);
  if v_snapshot is not null then
    if p_amount=(v_snapshot->>'balloonsPerSpin')::bigint then
      v_trigger_kind:='single';v_spin_count:=1;
      v_image:=coalesce(v_snapshot->'customSingleImage','null'::jsonb);
    elsif coalesce((v_snapshot->>'seriesEnabled')::boolean,false)
      and p_amount=(v_snapshot->>'seriesBalloons')::bigint then
      v_trigger_kind:='series';v_spin_count:=(v_snapshot->>'seriesSpinCount')::integer;
      v_image:=coalesce(v_snapshot->'customSeriesImage',v_snapshot->'customSingleImage','null'::jsonb);
    end if;
  end if;

  insert into byeollog_automation.native_roulette_events_v2(
    workspace_id,service_revision,provider_event_id,actor_id,actor_name,amount,message,
    occurred_at,trigger_kind,spin_count,status,is_test)
  values(p_workspace_id,v_service.service_revision,btrim(p_event_id),p_actor_id,p_actor_name,
    p_amount,nullif(btrim(p_message),''),p_occurred_at,v_trigger_kind,v_spin_count,
    case when v_spin_count=0 then 'ignored' else 'queued' end,true)
  on conflict(workspace_id,provider_event_id) do nothing returning * into v_event;
  if not found then
    select * into strict v_existing from byeollog_automation.native_roulette_events_v2 event
    where event.workspace_id=p_workspace_id and event.provider_event_id=btrim(p_event_id);
    return jsonb_build_object('duplicate',true,'eventId',v_existing.id,
      'spinCount',v_existing.spin_count,'status',v_existing.status,
      'dataIsolation','manual_overlay_test','upboWrites',0);
  end if;

  if p_amount between 1 and 30000 then
    select balloon.pc_image into v_signature from public.byeollog_signature_balloons balloon
    where balloon.workspace_id=p_workspace_id and balloon.balloon_count=p_amount::integer;
  end if;
  v_ceremony:=case when v_signature is not null then jsonb_build_object(
    'source','signature','asset',v_signature,'providerUrl',null)
    else jsonb_build_object('source','none') end;

  if v_snapshot is not null then
    v_asset_key:=v_snapshot->>'overlayAssetKey';
    select jsonb_agg(item->>'resultText' order by ordinality) into v_item_names
    from jsonb_array_elements(v_snapshot->'items') with ordinality valueset(item,ordinality);
  end if;
  if v_spin_count>0 then
    for v_spin_index in 0..v_spin_count-1 loop
      v_sample:=byeollog_automation.native_roulette_sample_ppm_v1();
      select item into strict v_item from (
        select item,sum((item->>'probabilityPpm')::integer) over(order by ordinality) upper_bound
        from jsonb_array_elements(v_snapshot->'items') with ordinality valueset(item,ordinality)
      ) chosen where v_sample<chosen.upper_bound order by chosen.upper_bound limit 1;
      v_direct:=(v_item->>'directUpbo')::boolean;
      insert into byeollog_automation.native_roulette_spins_v2(
        event_id,workspace_id,spin_index,sample_ppm,result_text,direct_upbo,item_snapshot,is_test)
      values(v_event.id,p_workspace_id,v_spin_index,v_sample,v_item->>'resultText',v_direct,v_item,true)
      returning id into v_spin_id;
      v_command:=jsonb_build_object(
        'schemaVersion',6,'kind','roulette_spin','commandId',v_spin_id,
        'rouletteName',v_snapshot->>'name','triggerKind',v_trigger_kind,
        'spinIndex',v_spin_index,'spinCount',v_spin_count,
        'actor',jsonb_build_object('name',p_actor_name),'amount',p_amount,
        'resultText',v_item->>'resultText','rouletteItems',v_item_names,
        'ttsText',coalesce(nullif(v_item->>'ttsText',''),(v_item->>'resultText')||', 당첨!'),
        'ttsVolumePercent',v_service.tts_volume_percent,
        'soundVolumePercent',v_service.sound_volume_percent,
        'overlayAssetKey',v_asset_key,'customImage',v_image,'ceremony',v_ceremony,
        'testMode',true,'dataIsolation','manual_overlay_test',
        'upboRequested',v_direct,'upboSuppressed',v_direct);
      insert into byeollog_automation.native_roulette_overlay_outbox_v2(
        workspace_id,event_id,spin_id,command_kind,payload,expires_at,is_test)
      values(p_workspace_id,v_event.id,v_spin_id,'roulette_spin',v_command,
        clock_timestamp()+interval '2 minutes',true);
      v_presentation_count:=v_presentation_count+1;
    end loop;
  elsif v_signature is not null then
    insert into byeollog_automation.native_roulette_overlay_outbox_v2(
      workspace_id,event_id,command_kind,payload,expires_at,is_test)
    values(p_workspace_id,v_event.id,'donation_ceremony',jsonb_build_object(
      'schemaVersion',6,'kind','donation_ceremony','donationEventId',btrim(p_event_id),
      'actor',jsonb_build_object('name',p_actor_name),'amount',p_amount,
      'ceremony',v_ceremony,'testMode',true,'dataIsolation','manual_overlay_test'),
      clock_timestamp()+interval '2 minutes',true);
    v_presentation_count:=1;
  end if;

  v_message:=nullif(btrim(p_message),'');
  if v_spin_count>0 and v_message is not null then
    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      set is_test=true,payload=outbox.payload||jsonb_build_object(
        'testMode',true,'dataIsolation','manual_overlay_test')
    where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event.id
      and outbox.command_kind='donation_chat_tts';
  end if;
  update byeollog_automation.native_roulette_events_v2 event
    set status=case when v_spin_count>0 then 'queued' else 'ignored' end
  where event.id=v_event.id;
  return jsonb_build_object('duplicate',false,'eventId',v_event.id,'spinCount',v_spin_count,
    'presentationCount',v_presentation_count,
    'status',case when v_presentation_count>0 then 'queued' else 'ignored' end,
    'dataIsolation','manual_overlay_test','upboWrites',0,'statisticsWrites',0);
end
$function$;

revoke all on function public.enqueue_native_overlay_donation_test_v1(
  uuid,text,text,text,bigint,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.enqueue_native_overlay_donation_test_v1(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;
