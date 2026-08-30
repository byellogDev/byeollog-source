-- Promote the approved SOOP roulette path from the bounded overlay experiment
-- to an exactly-once, restart-safe production service.  All objects remain
-- server-only; browsers receive commands through the authenticated application
-- endpoint and never access these tables directly.

create table public.byeollog_native_roulette_services (
  workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,
  active_draft_id uuid,
  active_draft_version integer,
  activation_snapshot jsonb,
  state text not null default 'paused' check (state in ('paused','active')),
  service_revision bigint not null default 0 check (service_revision>=0),
  overlay_token_version uuid not null default extensions.gen_random_uuid(),
  sound_volume_percent integer not null default 80 check (sound_volume_percent between 0 and 100),
  tts_volume_percent integer not null default 80 check (tts_volume_percent between 0 and 100),
  activated_by_user_id uuid,
  activated_at timestamptz,
  paused_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  foreign key(workspace_id,active_draft_id)
    references public.byeollog_roulette_drafts(workspace_id,id) on delete restrict,
  check (
    (state='paused')
    or (active_draft_id is not null and active_draft_version is not null
        and activation_snapshot is not null and activated_at is not null)
  ),
  check (activation_snapshot is null or jsonb_typeof(activation_snapshot)='object')
);

comment on table public.byeollog_native_roulette_services is
  'Server-only production activation state. The immutable JSON snapshot prevents later draft edits from changing a live broadcast.';

create table byeollog_automation.native_roulette_events_v2 (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  service_revision bigint not null,
  provider_event_id text not null,
  actor_id text not null,
  actor_name text not null,
  amount bigint not null check (amount between 1 and 1000000000000),
  message text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  trigger_kind text check (trigger_kind in ('single','series')),
  spin_count integer not null default 0 check (spin_count between 0 and 1000),
  status text not null check (status in ('ignored','queued','direct_only','completed','failed')),
  unique(workspace_id,provider_event_id),
  unique(id,workspace_id),
  check (char_length(provider_event_id) between 1 and 200 and provider_event_id!~'[[:cntrl:]]'),
  check (char_length(actor_id) between 1 and 180 and actor_id!~'[[:cntrl:]]'),
  check (char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]'),
  check (message is null or (char_length(message)<=1000 and message!~'[[:cntrl:]]'))
);

create index native_roulette_events_v2_workspace_received_idx
  on byeollog_automation.native_roulette_events_v2(workspace_id,received_at desc);

create table byeollog_automation.native_roulette_spins_v2 (
  id uuid primary key default extensions.gen_random_uuid(),
  event_id uuid not null,
  workspace_id uuid not null,
  spin_index integer not null check (spin_index between 0 and 999),
  sample_ppm integer not null check (sample_ppm between 0 and 999999),
  result_text text not null,
  direct_upbo boolean not null,
  item_snapshot jsonb not null check (jsonb_typeof(item_snapshot)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique(event_id,spin_index),
  unique(id,workspace_id),
  foreign key(event_id,workspace_id)
    references byeollog_automation.native_roulette_events_v2(id,workspace_id) on delete cascade,
  check (char_length(result_text) between 1 and 200 and result_text!~'[[:cntrl:]]')
);

create index native_roulette_spins_v2_workspace_created_idx
  on byeollog_automation.native_roulette_spins_v2(workspace_id,created_at desc);

create table byeollog_automation.native_roulette_overlay_outbox_v2 (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  event_id uuid not null,
  spin_id uuid,
  command_kind text not null check (command_kind in ('roulette_spin','donation_chat_tts')),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  client_id text,
  lease_expires_at timestamptz,
  available_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null default (clock_timestamp()+interval '15 minutes'),
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  foreign key(event_id,workspace_id)
    references byeollog_automation.native_roulette_events_v2(id,workspace_id) on delete cascade,
  foreign key(spin_id,workspace_id)
    references byeollog_automation.native_roulette_spins_v2(id,workspace_id) on delete cascade,
  unique(spin_id),
  check ((command_kind='roulette_spin')=(spin_id is not null)),
  check (client_id is null or (char_length(client_id) between 1 and 180 and client_id!~'[[:cntrl:]]')),
  check (last_error is null or char_length(last_error)<=1000)
);

create index native_roulette_overlay_outbox_v2_claim_idx
  on byeollog_automation.native_roulette_overlay_outbox_v2(workspace_id,status,available_at,created_at)
  where status in ('pending','processing');

create table byeollog_automation.native_roulette_chat_buffer_v2 (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  provider_chat_id text not null,
  actor_id text not null,
  actor_name text not null,
  message text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  consumed_event_id uuid,
  primary key(workspace_id,provider_chat_id),
  foreign key(consumed_event_id,workspace_id)
    references byeollog_automation.native_roulette_events_v2(id,workspace_id) on delete cascade,
  check (char_length(provider_chat_id) between 1 and 200 and provider_chat_id!~'[[:cntrl:]]'),
  check (char_length(actor_id) between 1 and 180 and actor_id!~'[[:cntrl:]]'),
  check (char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]'),
  check (char_length(message) between 1 and 300 and message!~'[[:cntrl:]]')
);

create index native_roulette_chat_buffer_v2_match_idx
  on byeollog_automation.native_roulette_chat_buffer_v2(workspace_id,actor_id,occurred_at)
  where consumed_event_id is null;

create table byeollog_automation.native_roulette_chat_waits_v2 (
  event_id uuid primary key,
  workspace_id uuid not null,
  actor_id text not null,
  opens_at timestamptz not null,
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','captured','expired','superseded')),
  captured_chat_id text,
  captured_at timestamptz,
  foreign key(event_id,workspace_id)
    references byeollog_automation.native_roulette_events_v2(id,workspace_id) on delete cascade,
  check (expires_at>=opens_at),
  check (char_length(actor_id) between 1 and 180 and actor_id!~'[[:cntrl:]]')
);

create index native_roulette_chat_waits_v2_match_idx
  on byeollog_automation.native_roulette_chat_waits_v2(workspace_id,actor_id,opens_at desc)
  where status='pending';

do $block$
declare table_name text;
begin
  foreach table_name in array array[
    'native_roulette_events_v2','native_roulette_spins_v2',
    'native_roulette_overlay_outbox_v2','native_roulette_chat_buffer_v2',
    'native_roulette_chat_waits_v2'
  ] loop
    execute format('alter table byeollog_automation.%I enable row level security',table_name);
    execute format('revoke all on table byeollog_automation.%I from public,anon,authenticated,service_role',table_name);
    execute format('grant select,insert,update,delete on table byeollog_automation.%I to service_role',table_name);
  end loop;
end
$block$;

alter table public.byeollog_native_roulette_services enable row level security;
create policy explicitly_deny_direct_client_access
  on public.byeollog_native_roulette_services for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_native_roulette_services from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_native_roulette_services to service_role;

create or replace function byeollog_automation.assert_native_roulette_snapshot_v2(p_snapshot jsonb)
returns void
language plpgsql
set search_path=''
set statement_timeout='5s'
as $function$
declare v_items jsonb;v_total bigint;v_count integer;v_unique integer;
begin
  if p_snapshot is null or jsonb_typeof(p_snapshot)<>'object'
     or jsonb_typeof(p_snapshot->'name')<>'string'
     or char_length(btrim(p_snapshot->>'name')) not between 1 and 120
     or (p_snapshot->>'balloonsPerSpin')!~'^[1-9][0-9]{0,6}$'
     or (p_snapshot->>'balloonsPerSpin')::bigint>1000000
     or jsonb_typeof(p_snapshot->'seriesEnabled')<>'boolean'
     or (p_snapshot->>'followupChatTtsWindowSeconds')!~'^[0-9]{1,2}$'
     or (p_snapshot->>'followupChatTtsWindowSeconds')::integer not between 0 and 60
     or jsonb_typeof(p_snapshot->'items')<>'array'
  then raise exception 'native roulette activation snapshot is invalid' using errcode='22023'; end if;
  if (p_snapshot->>'seriesEnabled')::boolean then
    if (p_snapshot->>'seriesBalloons')!~'^[1-9][0-9]{0,6}$'
       or (p_snapshot->>'seriesBalloons')::bigint>1000000
       or (p_snapshot->>'seriesSpinCount')!~'^[1-9][0-9]{0,3}$'
       or (p_snapshot->>'seriesSpinCount')::integer>1000
       or (p_snapshot->>'seriesBalloons')::bigint=(p_snapshot->>'balloonsPerSpin')::bigint
    then raise exception 'native roulette series trigger is invalid' using errcode='22023'; end if;
  end if;
  v_items:=p_snapshot->'items';v_count:=jsonb_array_length(v_items);
  if v_count not between 2 and 200 then
    raise exception 'native roulette item count is invalid' using errcode='22023';
  end if;
  select sum((item->>'probabilityPpm')::bigint),count(distinct lower(btrim(item->>'resultText')))
  into v_total,v_unique from jsonb_array_elements(v_items) item
  where jsonb_typeof(item)='object'
    and jsonb_typeof(item->'resultText')='string'
    and char_length(btrim(item->>'resultText')) between 1 and 200
    and (item->>'probabilityPpm')~'^[1-9][0-9]{0,5}$'
    and (item->>'probabilityPpm')::integer between 1 and 999999
    and jsonb_typeof(item->'directUpbo')='boolean';
  if v_total<>1000000 or v_unique<>v_count then
    raise exception 'native roulette items are invalid' using errcode='22023';
  end if;
end
$function$;
revoke all on function byeollog_automation.assert_native_roulette_snapshot_v2(jsonb)
  from public,anon,authenticated,service_role;

create or replace function public.activate_native_roulette_service_v2(
  p_workspace_id uuid,p_authorized_user_id uuid,p_draft_id uuid,p_snapshot jsonb,
  p_sound_volume_percent integer default 80,p_tts_volume_percent integer default 80)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare v_draft public.byeollog_roulette_drafts%rowtype;v_service public.byeollog_native_roulette_services%rowtype;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  perform byeollog_automation.assert_native_roulette_snapshot_v2(p_snapshot);
  if p_draft_id is null or p_sound_volume_percent not between 0 and 100
     or p_tts_volume_percent not between 0 and 100
  then raise exception 'native roulette activation request is invalid' using errcode='22023'; end if;
  select * into v_draft from public.byeollog_roulette_drafts
  where workspace_id=p_workspace_id and id=p_draft_id for update;
  if not found then raise exception 'roulette draft was not found' using errcode='P0002'; end if;
  if v_draft.draft<>p_snapshot or v_draft.roulette_name<>p_snapshot->>'name' then
    raise exception 'roulette draft changed before activation' using errcode='40001';
  end if;
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
  update public.byeollog_soop_runtime_controls set
    gateway_enabled=true,native_roulette_enabled=true,
    synthetic_test_enabled=false,live_diagnostics_enabled=true,
    overlay_experiment_enabled=false,overlay_experiment_draft_id=null,
    overlay_experiment_expires_at=null,updated_by_user_id=p_authorized_user_id,
    updated_at=clock_timestamp()
  where workspace_id=p_workspace_id;
  if not found then
    insert into public.byeollog_soop_runtime_controls(
      workspace_id,gateway_enabled,native_roulette_enabled,synthetic_test_enabled,
      live_diagnostics_enabled,overlay_experiment_enabled,updated_by_user_id)
    values(p_workspace_id,true,true,false,true,false,p_authorized_user_id);
  end if;
  return jsonb_build_object('active',true,'draftId',v_service.active_draft_id,
    'draftVersion',v_service.active_draft_version,'serviceRevision',v_service.service_revision,
    'overlayTokenVersion',v_service.overlay_token_version,'activatedAt',v_service.activated_at);
end
$function$;
revoke all on function public.activate_native_roulette_service_v2(uuid,uuid,uuid,jsonb,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.activate_native_roulette_service_v2(uuid,uuid,uuid,jsonb,integer,integer)
  to service_role;

create or replace function public.pause_native_roulette_service_v2(
  p_workspace_id uuid,p_authorized_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_updated integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  update public.byeollog_native_roulette_services set state='paused',paused_at=clock_timestamp(),
    updated_at=clock_timestamp() where workspace_id=p_workspace_id;
  get diagnostics v_updated=row_count;
  update public.byeollog_soop_runtime_controls set gateway_enabled=false,
    native_roulette_enabled=false,overlay_experiment_enabled=false,
    overlay_experiment_draft_id=null,overlay_experiment_expires_at=null,
    updated_by_user_id=p_authorized_user_id,updated_at=clock_timestamp()
  where workspace_id=p_workspace_id;
  return jsonb_build_object('active',false,'updated',v_updated>0);
end
$function$;
revoke all on function public.pause_native_roulette_service_v2(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.pause_native_roulette_service_v2(uuid,uuid) to service_role;

create or replace function public.rotate_native_roulette_overlay_token_v2(
  p_workspace_id uuid,p_authorized_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_version uuid:=extensions.gen_random_uuid();
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  update public.byeollog_native_roulette_services set overlay_token_version=v_version,
    updated_at=clock_timestamp() where workspace_id=p_workspace_id;
  if not found then raise exception 'native roulette service was not found' using errcode='P0002'; end if;
  return v_version;
end
$function$;
revoke all on function public.rotate_native_roulette_overlay_token_v2(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.rotate_native_roulette_overlay_token_v2(uuid,uuid) to service_role;

create or replace function byeollog_automation.enqueue_native_roulette_chat_tts_v2(
  p_event byeollog_automation.native_roulette_events_v2,
  p_message text,p_chat_id text,p_elapsed_seconds integer,p_source_kind text,
  p_tts_volume integer)
returns uuid
language plpgsql
set search_path=''
as $function$
declare v_id uuid;
begin
  insert into byeollog_automation.native_roulette_overlay_outbox_v2(
    workspace_id,event_id,command_kind,payload,expires_at)
  values(p_event.workspace_id,p_event.id,'donation_chat_tts',jsonb_build_object(
    'schemaVersion',2,'kind','donation_chat_tts',
    'donationEventId',p_event.provider_event_id,'chatEventId',p_chat_id,
    'sourceKind',p_source_kind,'actor',jsonb_build_object('name',p_event.actor_name),
    'amount',p_event.amount,'message',p_message,
    'displayText',case when p_source_kind='followup_chat'
      then '['||p_elapsed_seconds::text||'초전] '||p_event.actor_name||' : '||p_message else p_message end,
    'ttsText',p_message,'elapsedSeconds',p_elapsed_seconds,
    'ttsVolumePercent',p_tts_volume,'playAfterDonationResults',true),
    clock_timestamp()+interval '2 minutes') returning id into v_id;
  return v_id;
end
$function$;
revoke all on function byeollog_automation.enqueue_native_roulette_chat_tts_v2(
  byeollog_automation.native_roulette_events_v2,text,text,integer,text,integer)
  from public,anon,authenticated,service_role;

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
  v_snapshot jsonb;v_trigger_kind text;v_spin_count integer:=0;v_spin integer;
  v_sample integer;v_item jsonb;v_spin_id uuid;v_direct boolean;v_outputs jsonb;v_output text;
  v_output_index integer;v_regular_count integer:=0;v_message text;v_window integer;
  v_buffer byeollog_automation.native_roulette_chat_buffer_v2%rowtype;
  v_image jsonb;v_asset_key text;v_command jsonb;
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
  v_snapshot:=v_service.activation_snapshot;
  if p_amount=(v_snapshot->>'balloonsPerSpin')::bigint then
    v_trigger_kind:='single';v_spin_count:=1;
    v_image:=coalesce(v_snapshot->'customSingleImage','null'::jsonb);
  elsif (v_snapshot->>'seriesEnabled')::boolean
    and p_amount=(v_snapshot->>'seriesBalloons')::bigint then
    v_trigger_kind:='series';v_spin_count:=(v_snapshot->>'seriesSpinCount')::integer;
    v_image:=coalesce(v_snapshot->'customSeriesImage',v_snapshot->'customSingleImage','null'::jsonb);
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
      'spinCount',v_existing.spin_count,'status',v_existing.status);
  end if;
  if v_spin_count=0 then
    return jsonb_build_object('duplicate',false,'eventId',v_event.id,'spinCount',0,'status','ignored');
  end if;
  v_asset_key:=v_snapshot->>'overlayAssetKey';
  for v_spin in 0..v_spin_count-1 loop
    v_sample:=byeollog_automation.native_roulette_sample_ppm_v1();
    select item into strict v_item from (
      select item,sum((item->>'probabilityPpm')::integer) over(order by ordinality) upper_bound
      from jsonb_array_elements(v_snapshot->'items') with ordinality valueset(item,ordinality)
    ) chosen where v_sample<chosen.upper_bound order by chosen.upper_bound limit 1;
    v_direct:=(v_item->>'directUpbo')::boolean;
    insert into byeollog_automation.native_roulette_spins_v2(
      event_id,workspace_id,spin_index,sample_ppm,result_text,direct_upbo,item_snapshot)
    values(v_event.id,p_workspace_id,v_spin,v_sample,v_item->>'resultText',v_direct,v_item)
    returning id into v_spin_id;
    if v_direct then
      insert into public.bangsel_fans(workspace_id,soop_id,alias,current_nickname)
      values(p_workspace_id,lower(btrim(p_actor_id)),btrim(p_actor_name),btrim(p_actor_name))
      on conflict(workspace_id,soop_id) do update set current_nickname=excluded.current_nickname,
        updated_at=clock_timestamp();
      v_outputs:=coalesce(v_item->'outputTypes',jsonb_build_array(v_item->>'resultText'));
      v_output_index:=0;
      for v_output in select jsonb_array_elements_text(v_outputs) loop
        if not exists(select 1 from public.bangsel_tasks task where task.workspace_id=p_workspace_id
          and task.source_event_key='soop-native:'||btrim(p_event_id)||':'||v_spin::text||':'||v_output_index::text)
        then
          insert into public.bangsel_tasks(
            workspace_id,fan,fan_soop_id,event,type,total_qty,done_qty,source,source_event_key,added_date)
          values(p_workspace_id,btrim(p_actor_name),lower(btrim(p_actor_id)),
            coalesce(nullif(v_item->>'upboEventName',''),v_snapshot->>'name'),v_output,1,0,
            'byeollog_native_roulette','soop-native:'||btrim(p_event_id)||':'||v_spin::text||':'||v_output_index::text,
            (p_occurred_at at time zone 'Asia/Seoul')::date);
        end if;
        v_output_index:=v_output_index+1;
      end loop;
    else
      v_regular_count:=v_regular_count+1;
      v_command:=jsonb_build_object(
        'schemaVersion',2,'kind','roulette_spin','commandId',v_spin_id,
        'rouletteName',v_snapshot->>'name','triggerKind',v_trigger_kind,
        'spinIndex',v_spin,'spinCount',v_spin_count,
        'actor',jsonb_build_object('name',btrim(p_actor_name)),
        'amount',p_amount,'resultText',v_item->>'resultText',
        'ttsText',coalesce(nullif(v_item->>'ttsText',''),(v_item->>'resultText')||', 당첨!'),
        'ttsVolumePercent',v_service.tts_volume_percent,
        'soundVolumePercent',v_service.sound_volume_percent,
        'overlayAssetKey',v_asset_key,'customImage',v_image,
        'actionEvent',jsonb_build_object(
          'externalEventId','soop-native:'||btrim(p_event_id)||':'||v_spin::text,
          'eventType','roulette','result',v_item->>'resultText','rouletteName',v_snapshot->>'name'));
      insert into byeollog_automation.native_roulette_overlay_outbox_v2(
        workspace_id,event_id,spin_id,command_kind,payload)
      values(p_workspace_id,v_event.id,v_spin_id,'roulette_spin',v_command);
    end if;
  end loop;
  v_message:=nullif(left(btrim(p_message),300),'');
  v_window:=(v_snapshot->>'followupChatTtsWindowSeconds')::integer;
  if v_regular_count>0 and v_message is not null then
    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
  elsif v_regular_count>0 and v_window>0 then
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
        event_id,workspace_id,actor_id,opens_at,expires_at)
      values(v_event.id,p_workspace_id,lower(btrim(p_actor_id)),p_occurred_at,
        p_occurred_at+pg_catalog.make_interval(secs=>v_window));
    end if;
  end if;
  update byeollog_automation.native_roulette_events_v2 set
    status=case when v_regular_count=0 then 'direct_only' else 'queued' end
    where id=v_event.id;
  return jsonb_build_object('duplicate',false,'eventId',v_event.id,
    'spinCount',v_spin_count,'presentationCount',v_regular_count,
    'status',case when v_regular_count=0 then 'direct_only' else 'queued' end);
end
$function$;
revoke all on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_donation_v2(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;

create or replace function public.ingest_native_roulette_soop_chat_v2(
  p_workspace_id uuid,p_chat_event_id text,p_actor_id text,p_actor_name text,
  p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_wait byeollog_automation.native_roulette_chat_waits_v2%rowtype;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_service public.byeollog_native_roulette_services%rowtype;v_elapsed integer;v_dispatch uuid;
begin
  if p_workspace_id is null or char_length(btrim(p_chat_event_id)) not between 1 and 200
     or p_chat_event_id~'[[:cntrl:]]' or char_length(btrim(p_actor_id)) not between 1 and 180
     or p_actor_id~'[[:cntrl:]]' or char_length(btrim(p_actor_name)) not between 1 and 120
     or p_actor_name~'[[:cntrl:]]' or char_length(btrim(p_message)) not between 1 and 300
     or p_message~'[[:cntrl:]]' or p_occurred_at is null
     or p_occurred_at>clock_timestamp()+interval '2 minutes'
     or p_occurred_at<clock_timestamp()-interval '2 minutes'
  then raise exception 'native roulette SOOP chat is invalid' using errcode='22023'; end if;
  insert into byeollog_automation.native_roulette_chat_buffer_v2(
    workspace_id,provider_chat_id,actor_id,actor_name,message,occurred_at)
  values(p_workspace_id,btrim(p_chat_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),
    btrim(p_message),p_occurred_at) on conflict(workspace_id,provider_chat_id) do nothing;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'native-roulette-v2-chat:'||p_workspace_id::text||':'||lower(btrim(p_actor_id)),8272));
  update byeollog_automation.native_roulette_chat_waits_v2 set status='expired'
    where workspace_id=p_workspace_id and actor_id=lower(btrim(p_actor_id))
      and status='pending' and expires_at<p_occurred_at;
  select * into v_wait from byeollog_automation.native_roulette_chat_waits_v2
    where workspace_id=p_workspace_id and actor_id=lower(btrim(p_actor_id))
      and status='pending' and p_occurred_at between opens_at and expires_at
    order by opens_at desc limit 1 for update;
  if not found then return jsonb_build_object('duplicate',false,'matched',false); end if;
  select * into strict v_event from byeollog_automation.native_roulette_events_v2
    where id=v_wait.event_id and workspace_id=p_workspace_id;
  select * into strict v_service from public.byeollog_native_roulette_services
    where workspace_id=p_workspace_id;
  v_elapsed:=round(extract(epoch from(p_occurred_at-v_event.occurred_at)))::integer;
  update byeollog_automation.native_roulette_chat_waits_v2 set status='superseded'
    where workspace_id=p_workspace_id and actor_id=lower(btrim(p_actor_id))
      and status='pending' and event_id<>v_wait.event_id and opens_at<=v_wait.opens_at;
  update byeollog_automation.native_roulette_chat_waits_v2 set status='captured',
    captured_chat_id=btrim(p_chat_event_id),captured_at=clock_timestamp()
    where event_id=v_wait.event_id;
  update byeollog_automation.native_roulette_chat_buffer_v2 set consumed_event_id=v_event.id
    where workspace_id=p_workspace_id and provider_chat_id=btrim(p_chat_event_id);
  v_dispatch:=byeollog_automation.enqueue_native_roulette_chat_tts_v2(
    v_event,btrim(p_message),btrim(p_chat_event_id),v_elapsed,'followup_chat',v_service.tts_volume_percent);
  return jsonb_build_object('duplicate',false,'matched',true,'eventId',v_event.id,
    'dispatchId',v_dispatch,'elapsedSeconds',v_elapsed);
end
$function$;
revoke all on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz) to service_role;

create or replace function public.claim_native_roulette_overlay_v2(
  p_workspace_id uuid,p_client_id text,p_limit integer default 1,p_lease_seconds integer default 90)
returns table(command_id uuid,command_kind text,payload jsonb,attempt_count integer,lease_expires_at timestamptz)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
begin
  if p_workspace_id is null or char_length(btrim(p_client_id)) not between 1 and 180
     or p_client_id~'[[:cntrl:]]' or p_limit not between 1 and 10
     or p_lease_seconds not between 15 and 600
  then raise exception 'native roulette overlay claim is invalid' using errcode='22023'; end if;
  if not exists(select 1 from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id and service.state='active')
  then raise exception 'native roulette is not active' using errcode='55000'; end if;
  update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
    status='failed',client_id=null,lease_expires_at=null,processed_at=clock_timestamp(),
    last_error='overlay command expired before delivery'
  where outbox.workspace_id=p_workspace_id and outbox.status in ('pending','processing')
    and outbox.expires_at<=clock_timestamp();
  return query with candidates as (
    select outbox.id from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.workspace_id=p_workspace_id and outbox.attempt_count<20
      and outbox.available_at<=clock_timestamp() and outbox.expires_at>clock_timestamp()
      and (outbox.status='pending' or (outbox.status='processing' and outbox.lease_expires_at<=clock_timestamp()))
    order by outbox.created_at,outbox.id for update skip locked limit p_limit
  ),claimed as (
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
      status='processing',attempt_count=outbox.attempt_count+1,client_id=btrim(p_client_id),
      lease_expires_at=clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds),last_error=null
    from candidates where outbox.id=candidates.id returning outbox.*
  ) select claimed.id,claimed.command_kind,claimed.payload,claimed.attempt_count,
      claimed.lease_expires_at from claimed order by claimed.created_at,claimed.id;
end
$function$;
revoke all on function public.claim_native_roulette_overlay_v2(uuid,text,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_overlay_v2(uuid,text,integer,integer)
  to service_role;

create or replace function public.finish_native_roulette_overlay_v2(
  p_workspace_id uuid,p_command_id uuid,p_client_id text,p_succeeded boolean,p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_command byeollog_automation.native_roulette_overlay_outbox_v2%rowtype;
begin
  if p_workspace_id is null or p_command_id is null
     or char_length(btrim(p_client_id)) not between 1 and 180 or p_client_id~'[[:cntrl:]]'
     or p_succeeded is null or (p_succeeded and p_error is not null)
     or (not p_succeeded and (p_error is null or char_length(p_error) not between 1 and 1000))
  then raise exception 'native roulette overlay acknowledgement is invalid' using errcode='22023'; end if;
  select * into v_command from byeollog_automation.native_roulette_overlay_outbox_v2
    where id=p_command_id and workspace_id=p_workspace_id for update;
  if not found or v_command.status<>'processing' or v_command.client_id<>btrim(p_client_id)
     or v_command.lease_expires_at<=clock_timestamp()
  then raise exception 'native roulette overlay lease is unavailable' using errcode='55000'; end if;
  update byeollog_automation.native_roulette_overlay_outbox_v2 set
    status=case when p_succeeded then 'succeeded'
      when attempt_count<20 then 'pending' else 'failed' end,
    client_id=null,lease_expires_at=null,last_error=p_error,
    processed_at=case when p_succeeded or attempt_count>=20 then clock_timestamp() else null end
    where id=p_command_id returning * into v_command;
  if p_succeeded and not exists(select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 pending
    where pending.event_id=v_command.event_id and pending.status in ('pending','processing'))
  then update byeollog_automation.native_roulette_events_v2 set status='completed'
    where id=v_command.event_id and status='queued'; end if;
  return jsonb_build_object('commandId',v_command.id,'status',v_command.status,
    'attemptCount',v_command.attempt_count);
end
$function$;
revoke all on function public.finish_native_roulette_overlay_v2(uuid,uuid,text,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_native_roulette_overlay_v2(uuid,uuid,text,boolean,text)
  to service_role;

-- Retire every test-only production switch.  Existing rows remain auditable,
-- but no workspace is left in an expiring experiment after this migration.
update public.byeollog_soop_runtime_controls set
  synthetic_test_enabled=false,overlay_experiment_enabled=false,
  overlay_experiment_draft_id=null,overlay_experiment_expires_at=null,
  updated_at=clock_timestamp();

;
