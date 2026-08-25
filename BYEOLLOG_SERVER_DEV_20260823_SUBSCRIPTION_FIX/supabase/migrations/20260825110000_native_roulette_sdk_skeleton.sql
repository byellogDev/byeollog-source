-- Native Byeollog roulette skeleton.
--
-- This migration is intentionally dormant. It creates immutable draft,
-- cache-preparation, SOOP donation receipt, deterministic spin, and dispatch
-- contracts, but it DOES NOT expose an activation RPC. A later migration may
-- add activation only after SOOP Chat SDK approval, immutable WebP publication,
-- and a released Agent that can prove the selected WebP and every result TTS
-- are cached. Existing Weflab collection and released Agents are untouched.

create table byeollog_automation.native_roulette_assets (
  asset_key text primary key,
  display_name text not null,
  file_name text not null unique,
  mime_type text not null check (mime_type='image/webp'),
  content_sha256 text not null unique check (content_sha256~'^[0-9a-f]{64}$'),
  byte_size bigint not null check (byte_size between 1 and 33554432),
  width_px integer not null check (width_px=1920),
  height_px integer not null check (height_px=1080),
  frame_count integer not null check (frame_count=91),
  duration_ms integer not null check (duration_ms=4800),
  delivery_status text not null check (delivery_status in ('staged','published','retired')),
  published_path text,
  check (asset_key~'^[a-z0-9][a-z0-9_]{1,63}$'),
  check (char_length(display_name) between 1 and 120),
  check (char_length(file_name) between 1 and 180),
  check ((delivery_status='published')=(published_path is not null)),
  check (published_path is null or published_path~'^assets/native-roulette/[0-9a-f]{64}\.webp$')
);

insert into byeollog_automation.native_roulette_assets(
  asset_key,display_name,file_name,mime_type,content_sha256,byte_size,
  width_px,height_px,frame_count,duration_ms,delivery_status)
values
  ('roulette_navy_gold_v1','네이비 · 골드','roulette-01-navy-gold-clean-edge.webp','image/webp','8856a770937a71a7ee6bac5e54f15ff14ed1bac1cad4d67e6f7c20ca9694ac38',25698598,1920,1080,91,4800,'staged'),
  ('roulette_royal_purple_rose_gold_v1','로열 퍼플 · 로즈 골드','roulette-02-royal-purple-rose-gold-clean-edge.webp','image/webp','7cfe7dfdebfc2b907afdd891e8114c5aac916b473cbda7e6c6c83c5ac5da7f1b',22339256,1920,1080,91,4800,'staged'),
  ('roulette_emerald_champagne_v1','에메랄드 · 샴페인','roulette-03-emerald-champagne-clean-edge.webp','image/webp','69f349120d54482ee04d3bb26e4ab095b2ad01a39546b00aaaac07040aec42ed',22276620,1920,1080,91,4800,'staged'),
  ('roulette_burgundy_pale_gold_v1','버건디 · 페일 골드','roulette-04-burgundy-pale-gold-clean-edge.webp','image/webp','ce174766817dfbef374719fd6d284adf9ef428ff9d4330012fc3244bfa18533f',21504782,1920,1080,91,4800,'staged'),
  ('roulette_graphite_cyan_v1','그래파이트 · 시안','roulette-05-graphite-cyan-clean-edge.webp','image/webp','68c06367a4fa404642b718acbee7e9e35580162e483e53f5df62451236f5bb77',21478638,1920,1080,91,4800,'staged'),
  ('roulette_pastel_powder_blue_peach_v1','파우더 블루 · 피치','roulette-06-pastel-powder-blue-peach-clean-edge.webp','image/webp','466bdae0d95afc937e536c3eb12bd7790c3d854df03e3f695f7c0731321ee1b7',22176726,1920,1080,91,4800,'staged'),
  ('roulette_pastel_lavender_butter_v1','더스티 라벤더 · 버터','roulette-07-pastel-dusty-lavender-butter-clean-edge.webp','image/webp','844bbf142e2269c371a7c0bad202edf683b90e8393e6d23638558de1d85d7af5',21756766,1920,1080,91,4800,'staged');

create table byeollog_automation.native_roulette_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null unique references public.byeollog_workspaces(id) on delete cascade,
  latest_revision_id uuid,
  active_revision_id uuid,
  created_by_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(id,workspace_id)
);

create table byeollog_automation.native_roulette_revisions (
  id uuid primary key default extensions.gen_random_uuid(),
  profile_id uuid not null,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  version_number integer not null check (version_number between 1 and 2147483647),
  status text not null check (status in ('cache_pending','ready','active','superseded','retired')),
  name text not null check (char_length(name) between 1 and 120 and name!~'[[:cntrl:]]'),
  balloons_per_spin integer not null check (balloons_per_spin between 1 and 1000000),
  allow_multiple_spins boolean not null,
  selected_agent_device_id uuid not null,
  overlay_asset_key text not null references byeollog_automation.native_roulette_assets(asset_key),
  overlay_asset_sha256 text not null check (overlay_asset_sha256~'^[0-9a-f]{64}$'),
  overlay_asset_bytes bigint not null check (overlay_asset_bytes between 1 and 33554432),
  sound_key text not null check (sound_key='roulette_spin_v1'),
  sound_volume_percent integer not null check (sound_volume_percent between 0 and 100),
  tts_volume_percent integer not null check (tts_volume_percent between 0 and 100),
  created_by_user_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  ready_at timestamptz,
  activated_at timestamptz,
  retired_at timestamptz,
  unique(profile_id,version_number),
  unique(id,workspace_id),
  foreign key(profile_id,workspace_id)
    references byeollog_automation.native_roulette_profiles(id,workspace_id) on delete cascade,
  check (status not in ('ready','active') or ready_at is not null),
  check (status<>'active' or activated_at is not null)
);

alter table byeollog_automation.native_roulette_profiles
  add constraint native_roulette_profiles_latest_revision_fk
  foreign key(latest_revision_id,workspace_id)
  references byeollog_automation.native_roulette_revisions(id,workspace_id)
  deferrable initially deferred;
alter table byeollog_automation.native_roulette_profiles
  add constraint native_roulette_profiles_active_revision_fk
  foreign key(active_revision_id,workspace_id)
  references byeollog_automation.native_roulette_revisions(id,workspace_id)
  deferrable initially deferred;

create unique index native_roulette_one_active_revision_idx
  on byeollog_automation.native_roulette_revisions(profile_id)
  where status='active';
create index native_roulette_revision_workspace_created_idx
  on byeollog_automation.native_roulette_revisions(workspace_id,created_at desc);
create index native_roulette_revision_profile_workspace_idx
  on byeollog_automation.native_roulette_revisions(profile_id,workspace_id);
create index native_roulette_profile_latest_revision_idx
  on byeollog_automation.native_roulette_profiles(latest_revision_id,workspace_id)
  where latest_revision_id is not null;
create index native_roulette_profile_active_revision_idx
  on byeollog_automation.native_roulette_profiles(active_revision_id,workspace_id)
  where active_revision_id is not null;

create table byeollog_automation.native_roulette_items (
  id uuid primary key default extensions.gen_random_uuid(),
  revision_id uuid not null,
  workspace_id uuid not null,
  position integer not null check (position between 0 and 99),
  result_text text not null check (char_length(result_text) between 1 and 200 and result_text!~'[[:cntrl:]]'),
  probability_ppm integer not null check (probability_ppm between 1 and 999999),
  direct_upbo boolean not null,
  upbo_event_name text,
  output_types text[] not null default '{}',
  tts_text text,
  tts_voice_key text,
  unique(revision_id,position),
  unique(revision_id,result_text),
  unique(id,revision_id),
  foreign key(revision_id,workspace_id)
    references byeollog_automation.native_roulette_revisions(id,workspace_id) on delete cascade,
  check (
    (direct_upbo and upbo_event_name is not null and cardinality(output_types) between 1 and 20
      and tts_text is null and tts_voice_key is null)
    or
    (not direct_upbo and upbo_event_name is null and cardinality(output_types)=0
      and char_length(tts_text) between 1 and 160 and tts_text!~'[[:cntrl:]]'
      and tts_voice_key~'^[0-9a-f]{64}$')
  ),
  check (upbo_event_name is null or (char_length(upbo_event_name) between 1 and 120 and upbo_event_name!~'[[:cntrl:]]')),
  check (array_to_string(output_types,'|')!~'[[:cntrl:]]')
);

create index native_roulette_item_revision_workspace_idx
  on byeollog_automation.native_roulette_items(revision_id,workspace_id);

create table byeollog_automation.native_roulette_cache_requirements (
  id uuid primary key default extensions.gen_random_uuid(),
  revision_id uuid not null,
  workspace_id uuid not null,
  agent_device_id uuid not null,
  resource_kind text not null check (resource_kind in ('overlay_webp','result_tts')),
  resource_key text not null,
  item_id uuid,
  tts_text text,
  expected_content_sha256 text,
  expected_byte_size bigint,
  actual_content_sha256 text,
  actual_byte_size bigint,
  voice_version text,
  ready_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique(revision_id,agent_device_id,resource_kind,resource_key),
  foreign key(revision_id,workspace_id)
    references byeollog_automation.native_roulette_revisions(id,workspace_id) on delete cascade,
  foreign key(item_id,revision_id)
    references byeollog_automation.native_roulette_items(id,revision_id) on delete cascade,
  check (char_length(resource_key) between 1 and 180 and resource_key!~'[[:cntrl:]]'),
  check (expected_content_sha256 is null or expected_content_sha256~'^[0-9a-f]{64}$'),
  check (actual_content_sha256 is null or actual_content_sha256~'^[0-9a-f]{64}$'),
  check (expected_byte_size is null or expected_byte_size between 1 and 33554432),
  check (actual_byte_size is null or actual_byte_size between 1 and 33554432),
  check (
    (resource_kind='overlay_webp' and item_id is null and tts_text is null
      and expected_content_sha256 is not null and expected_byte_size is not null)
    or
    (resource_kind='result_tts' and item_id is not null
      and char_length(tts_text) between 1 and 160
      and expected_content_sha256 is null and expected_byte_size is null)
  ),
  check ((ready_at is null and actual_content_sha256 is null and actual_byte_size is null and voice_version is null)
    or (ready_at is not null and actual_content_sha256 is not null and actual_byte_size is not null))
);

create index native_roulette_cache_device_pending_idx
  on byeollog_automation.native_roulette_cache_requirements(agent_device_id,created_at)
  where ready_at is null;
create index native_roulette_cache_revision_workspace_idx
  on byeollog_automation.native_roulette_cache_requirements(revision_id,workspace_id);
create index native_roulette_cache_item_revision_idx
  on byeollog_automation.native_roulette_cache_requirements(item_id,revision_id)
  where item_id is not null;

create table byeollog_automation.native_roulette_donations (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  revision_id uuid not null,
  soop_event_id text not null,
  actor_id text not null,
  actor_name text not null,
  amount bigint not null check (amount between 1 and 1000000000000),
  message text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default clock_timestamp(),
  spin_count integer not null check (spin_count between 0 and 100),
  status text not null check (status in ('ignored','dispatch_pending','dispatched','failed')),
  unique(workspace_id,soop_event_id),
  unique(id,workspace_id),
  foreign key(revision_id,workspace_id)
    references byeollog_automation.native_roulette_revisions(id,workspace_id) on delete cascade,
  check (char_length(soop_event_id) between 1 and 200 and soop_event_id!~'[[:cntrl:]]'),
  check (char_length(actor_id) between 1 and 180 and actor_id!~'[[:cntrl:]]'),
  check (char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]'),
  check (message is null or (char_length(message)<=1000 and message!~'[[:cntrl:]]'))
);

create index native_roulette_donation_revision_workspace_idx
  on byeollog_automation.native_roulette_donations(revision_id,workspace_id);

create table byeollog_automation.native_roulette_spins (
  id uuid primary key default extensions.gen_random_uuid(),
  donation_id uuid not null,
  workspace_id uuid not null,
  revision_id uuid not null,
  item_id uuid not null,
  spin_index integer not null check (spin_index between 0 and 99),
  sample_ppm integer not null check (sample_ppm between 0 and 999999),
  source_event_key text not null,
  result_text text not null,
  direct_upbo boolean not null,
  dispatch_payload jsonb not null check (jsonb_typeof(dispatch_payload)='object'),
  created_at timestamptz not null default clock_timestamp(),
  unique(donation_id,spin_index),
  unique(workspace_id,source_event_key),
  foreign key(donation_id,workspace_id)
    references byeollog_automation.native_roulette_donations(id,workspace_id) on delete cascade,
  foreign key(item_id,revision_id)
    references byeollog_automation.native_roulette_items(id,revision_id) on delete cascade,
  check (char_length(source_event_key) between 1 and 240),
  check (char_length(result_text) between 1 and 200)
);

create index native_roulette_spin_item_revision_idx
  on byeollog_automation.native_roulette_spins(item_id,revision_id);

create table byeollog_automation.native_roulette_dispatch_outbox (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  spin_id uuid not null unique references byeollog_automation.native_roulette_spins(id) on delete cascade,
  dispatch_kind text not null check (dispatch_kind in ('direct_upbo','automation_event')),
  payload jsonb not null check (jsonb_typeof(payload)='object'),
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed')),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  worker_id text,
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz not null default clock_timestamp(),
  processed_at timestamptz,
  check ((status='processing')=(worker_id is not null and lease_expires_at is not null)),
  check (last_error is null or char_length(last_error)<=2000)
);

create index native_roulette_dispatch_pending_idx
  on byeollog_automation.native_roulette_dispatch_outbox(workspace_id,created_at,id)
  where status in ('pending','processing');

do $policy$
declare table_name text;
begin
  foreach table_name in array array[
    'native_roulette_assets','native_roulette_profiles','native_roulette_revisions',
    'native_roulette_items','native_roulette_cache_requirements','native_roulette_donations',
    'native_roulette_spins','native_roulette_dispatch_outbox'
  ] loop
    execute format('alter table byeollog_automation.%I enable row level security',table_name);
    execute format('create policy explicitly_deny_direct_client_access on byeollog_automation.%I for all to anon,authenticated using(false) with check(false)',table_name);
    execute format('revoke all on table byeollog_automation.%I from public,anon,authenticated,service_role',table_name);
  end loop;
end
$policy$;

create or replace function byeollog_automation.assert_native_roulette_member_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_write boolean)
returns text
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_role text;
begin
  if p_workspace_id is null or p_authorized_user_id is null or p_write is null then
    raise exception 'native roulette authorization is invalid' using errcode='28000';
  end if;
  select lower(btrim(member.role::text)) into v_role
  from public.byeollog_workspace_members member
  join public.byeollog_workspaces workspace on workspace.id=member.workspace_id
  where member.workspace_id=p_workspace_id
    and member.user_id=p_authorized_user_id
    and workspace.status='active';
  if v_role is null or (p_write and v_role not in ('owner','editor','manager')) then
    raise exception 'native roulette authorization failed' using errcode='42501';
  end if;
  return v_role;
end
$function$;

revoke all on function byeollog_automation.assert_native_roulette_member_v1(uuid,uuid,boolean)
  from public,anon,authenticated,service_role;

create or replace function byeollog_automation.native_roulette_tts_key_v1(p_text text)
returns text
language sql
immutable
strict
set search_path=''
as $function$
  select encode(extensions.digest(pg_catalog.convert_to(
    'native-roulette-result-v1|'||p_text,'UTF8'),'sha256'),'hex')
$function$;

revoke all on function byeollog_automation.native_roulette_tts_key_v1(text)
  from public,anon,authenticated,service_role;

create or replace function public.save_native_roulette_draft_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_draft jsonb)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_profile_id uuid;
  v_revision_id uuid:=extensions.gen_random_uuid();
  v_version integer;
  v_asset byeollog_automation.native_roulette_assets%rowtype;
  v_item jsonb;
  v_item_id uuid;
  v_position integer:=0;
  v_probability_total bigint:=0;
  v_output_types text[];
  v_tts_text text;
  v_tts_key text;
  v_device_id uuid;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  if p_draft is null or jsonb_typeof(p_draft)<>'object'
     or jsonb_typeof(p_draft->'items')<>'array'
     or jsonb_array_length(p_draft->'items') not between 2 and 100
     or char_length(btrim(p_draft->>'name')) not between 1 and 120
     or (p_draft->>'name')~'[[:cntrl:]]'
     or (p_draft->>'balloonsPerSpin')!~'^[0-9]+$'
     or (p_draft->>'balloonsPerSpin')::bigint not between 1 and 1000000
     or jsonb_typeof(p_draft->'allowMultipleSpins')<>'boolean'
     or (p_draft->>'agentDeviceId')!~'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     or p_draft->>'soundKey'<>'roulette_spin_v1'
     or (p_draft->>'soundVolumePercent')!~'^[0-9]+$'
     or (p_draft->>'soundVolumePercent')::integer not between 0 and 100
     or (p_draft->>'ttsVolumePercent')!~'^[0-9]+$'
     or (p_draft->>'ttsVolumePercent')::integer not between 0 and 100
  then
    raise exception 'native roulette draft is invalid' using errcode='22023';
  end if;
  v_device_id:=(p_draft->>'agentDeviceId')::uuid;
  if not exists(select 1 from byeollog_automation.agent_devices device
    where device.workspace_id=p_workspace_id and device.device_id=v_device_id
      and device.revoked_at is null)
  then raise exception 'native roulette Agent device is unavailable' using errcode='PT409'; end if;

  select asset.* into v_asset
  from byeollog_automation.native_roulette_assets asset
  where asset.asset_key=p_draft->>'overlayAssetKey';
  if not found
     or v_asset.content_sha256<>p_draft->>'overlayAssetSha256'
     or v_asset.byte_size<>(p_draft->>'overlayAssetBytes')::bigint
  then raise exception 'native roulette WebP identity is invalid' using errcode='22023'; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('native-roulette-config:'||p_workspace_id::text,7301));
  insert into byeollog_automation.native_roulette_profiles(
    workspace_id,created_by_user_id)
  values(p_workspace_id,p_authorized_user_id)
  on conflict(workspace_id) do nothing;
  select profile.id into v_profile_id
  from byeollog_automation.native_roulette_profiles profile
  where profile.workspace_id=p_workspace_id for update;
  select coalesce(max(revision.version_number),0)+1 into v_version
  from byeollog_automation.native_roulette_revisions revision
  where revision.profile_id=v_profile_id;

  update byeollog_automation.native_roulette_revisions revision
  set status='superseded',retired_at=clock_timestamp()
  where revision.profile_id=v_profile_id and revision.status in ('cache_pending','ready');
  insert into byeollog_automation.native_roulette_revisions(
    id,profile_id,workspace_id,version_number,status,name,balloons_per_spin,
    allow_multiple_spins,selected_agent_device_id,overlay_asset_key,
    overlay_asset_sha256,overlay_asset_bytes,sound_key,sound_volume_percent,
    tts_volume_percent,created_by_user_id)
  values(
    v_revision_id,v_profile_id,p_workspace_id,v_version,'cache_pending',btrim(p_draft->>'name'),
    (p_draft->>'balloonsPerSpin')::integer,(p_draft->>'allowMultipleSpins')::boolean,
    v_device_id,v_asset.asset_key,v_asset.content_sha256,v_asset.byte_size,
    p_draft->>'soundKey',(p_draft->>'soundVolumePercent')::integer,
    (p_draft->>'ttsVolumePercent')::integer,p_authorized_user_id);

  for v_item in select value from jsonb_array_elements(p_draft->'items') loop
    if jsonb_typeof(v_item)<>'object'
       or char_length(btrim(v_item->>'resultText')) not between 1 and 200
       or (v_item->>'resultText')~'[[:cntrl:]]'
       or (v_item->>'probabilityPpm')!~'^[0-9]+$'
       or (v_item->>'probabilityPpm')::integer not between 1 and 999999
       or jsonb_typeof(v_item->'directUpbo')<>'boolean'
    then raise exception 'native roulette item is invalid' using errcode='22023'; end if;
    if (v_item->>'directUpbo')::boolean then
      if jsonb_typeof(v_item->'outputTypes')<>'array'
         or jsonb_array_length(v_item->'outputTypes') not between 1 and 20
         or char_length(btrim(v_item->>'upboEventName')) not between 1 and 120
         or v_item->'ttsText'<>'null'::jsonb or v_item->'ttsVoiceKey'<>'null'::jsonb
      then raise exception 'native roulette direct upbo item is invalid' using errcode='22023'; end if;
      select array_agg(btrim(value) order by ordinality) into v_output_types
      from jsonb_array_elements_text(v_item->'outputTypes') with ordinality;
      if exists(select 1 from unnest(v_output_types) output_type
        where char_length(output_type) not between 1 and 120 or output_type~'[[:cntrl:]]')
      then raise exception 'native roulette upbo output is invalid' using errcode='22023'; end if;
      v_tts_text:=null;v_tts_key:=null;
    else
      v_output_types:='{}';
      v_tts_text:=btrim(v_item->>'ttsText');
      v_tts_key:=v_item->>'ttsVoiceKey';
      if char_length(v_tts_text) not between 1 and 160
         or v_tts_text~'[[:cntrl:]]'
         or v_tts_key<>byeollog_automation.native_roulette_tts_key_v1(v_tts_text)
      then raise exception 'native roulette TTS identity is invalid' using errcode='22023'; end if;
    end if;
    v_item_id:=extensions.gen_random_uuid();
    insert into byeollog_automation.native_roulette_items(
      id,revision_id,workspace_id,position,result_text,probability_ppm,direct_upbo,
      upbo_event_name,output_types,tts_text,tts_voice_key)
    values(
      v_item_id,v_revision_id,p_workspace_id,v_position,btrim(v_item->>'resultText'),
      (v_item->>'probabilityPpm')::integer,(v_item->>'directUpbo')::boolean,
      case when (v_item->>'directUpbo')::boolean then btrim(v_item->>'upboEventName') end,
      v_output_types,v_tts_text,v_tts_key);
    if not (v_item->>'directUpbo')::boolean then
      insert into byeollog_automation.native_roulette_cache_requirements(
        revision_id,workspace_id,agent_device_id,resource_kind,resource_key,item_id,tts_text)
      values(v_revision_id,p_workspace_id,v_device_id,'result_tts',v_tts_key,v_item_id,v_tts_text);
    end if;
    v_probability_total:=v_probability_total+(v_item->>'probabilityPpm')::integer;
    v_position:=v_position+1;
  end loop;
  if v_probability_total<>1000000 then
    raise exception 'native roulette probability total must equal 100 percent' using errcode='22023';
  end if;
  insert into byeollog_automation.native_roulette_cache_requirements(
    revision_id,workspace_id,agent_device_id,resource_kind,resource_key,
    expected_content_sha256,expected_byte_size)
  values(v_revision_id,p_workspace_id,v_device_id,'overlay_webp',v_asset.asset_key,
    v_asset.content_sha256,v_asset.byte_size);
  update byeollog_automation.native_roulette_profiles profile
  set latest_revision_id=v_revision_id,updated_at=clock_timestamp()
  where profile.id=v_profile_id;
  return jsonb_build_object(
    'ok',true,'profileId',v_profile_id,'revisionId',v_revision_id,
    'versionNumber',v_version,'status','cache_pending','activationAvailable',false);
exception
  when unique_violation then
    raise exception 'native roulette item names must be unique' using errcode='22023';
end
$function$;

revoke all on function public.save_native_roulette_draft_v1(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.save_native_roulette_draft_v1(uuid,uuid,jsonb) to service_role;

create or replace function public.get_native_roulette_settings_v1(
  p_workspace_id uuid,
  p_authorized_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_profile byeollog_automation.native_roulette_profiles%rowtype;
declare v_revision byeollog_automation.native_roulette_revisions%rowtype;
declare v_assets jsonb;declare v_devices jsonb;declare v_items jsonb;
declare v_total integer:=0;declare v_ready integer:=0;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,false);
  select coalesce(jsonb_agg(jsonb_build_object(
    'key',asset.asset_key,'displayName',asset.display_name,'mimeType',asset.mime_type,
    'contentSha256',asset.content_sha256,'byteSize',asset.byte_size,
    'widthPx',asset.width_px,'heightPx',asset.height_px,'frameCount',asset.frame_count,
    'durationMs',asset.duration_ms,'deliveryStatus',asset.delivery_status,
    'publishedPath',asset.published_path) order by asset.asset_key),'[]'::jsonb)
  into v_assets from byeollog_automation.native_roulette_assets asset
  where asset.delivery_status<>'retired';
  select coalesce(jsonb_agg(jsonb_build_object(
    'deviceId',device.device_id,'displayName',device.device_name,
    'registeredAt',device.registered_at) order by device.registered_at desc),'[]'::jsonb)
  into v_devices from byeollog_automation.agent_devices device
  where device.workspace_id=p_workspace_id and device.revoked_at is null;
  select profile.* into v_profile
  from byeollog_automation.native_roulette_profiles profile
  where profile.workspace_id=p_workspace_id;
  if not found or v_profile.latest_revision_id is null then
    return jsonb_build_object(
      'profile',null,'assets',v_assets,'agentDevices',v_devices,
      'activationAvailable',false,
      'activationBlockers',jsonb_build_array('soop_chat_sdk_not_approved','agent_runtime_not_released','webp_assets_not_published'));
  end if;
  select revision.* into strict v_revision
  from byeollog_automation.native_roulette_revisions revision
  where revision.id=v_profile.latest_revision_id and revision.workspace_id=p_workspace_id;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item.id,'position',item.position,'resultText',item.result_text,
    'probabilityPpm',item.probability_ppm,'directUpbo',item.direct_upbo,
    'upboEventName',item.upbo_event_name,'outputTypes',item.output_types,
    'ttsText',item.tts_text,'ttsVoiceKey',item.tts_voice_key) order by item.position),'[]'::jsonb)
  into v_items from byeollog_automation.native_roulette_items item
  where item.revision_id=v_revision.id;
  select count(*)::integer,count(*) filter(where requirement.ready_at is not null)::integer
  into v_total,v_ready
  from byeollog_automation.native_roulette_cache_requirements requirement
  where requirement.revision_id=v_revision.id;
  return jsonb_build_object(
    'profile',jsonb_build_object(
      'id',v_profile.id,'revisionId',v_revision.id,'versionNumber',v_revision.version_number,
      'status',v_revision.status,'name',v_revision.name,
      'balloonsPerSpin',v_revision.balloons_per_spin,
      'allowMultipleSpins',v_revision.allow_multiple_spins,
      'agentDeviceId',v_revision.selected_agent_device_id,
      'overlayAssetKey',v_revision.overlay_asset_key,
      'overlayAssetSha256',v_revision.overlay_asset_sha256,
      'overlayAssetBytes',v_revision.overlay_asset_bytes,
      'soundKey',v_revision.sound_key,'soundVolumePercent',v_revision.sound_volume_percent,
      'ttsVolumePercent',v_revision.tts_volume_percent,'items',v_items,
      'cache',jsonb_build_object('total',v_total,'ready',v_ready,'pending',v_total-v_ready,
        'readyForActivation',v_total>0 and v_total=v_ready)),
    'assets',v_assets,'agentDevices',v_devices,'activationAvailable',false,
    'activationBlockers',jsonb_build_array(
      'soop_chat_sdk_not_approved','agent_runtime_not_released','activation_rpc_intentionally_absent'));
end
$function$;

revoke all on function public.get_native_roulette_settings_v1(uuid,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.get_native_roulette_settings_v1(uuid,uuid) to service_role;

create or replace function public.g3a_list_native_roulette_cache_v1(
  p_workspace_id uuid,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text)
returns table(
  requirement_id uuid,revision_id uuid,version_number integer,
  resource_kind text,resource_key text,tts_text text,
  expected_content_sha256 text,expected_byte_size bigint,resource_path text,
  ready boolean,total_count bigint)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component<>'agent_runtime' then
    raise exception 'native roulette cache runtime is invalid' using errcode='22023';
  end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_agent_device_id,p_agent_secret_hash);
  return query
  select requirement.id,revision.id,revision.version_number,
    requirement.resource_kind,requirement.resource_key,requirement.tts_text,
    requirement.expected_content_sha256,requirement.expected_byte_size,asset.published_path,
    requirement.ready_at is not null,count(*) over()
  from byeollog_automation.native_roulette_profiles profile
  join byeollog_automation.native_roulette_revisions revision
    on revision.id=profile.latest_revision_id
  join byeollog_automation.native_roulette_cache_requirements requirement
    on requirement.revision_id=revision.id
  left join byeollog_automation.native_roulette_assets asset
    on requirement.resource_kind='overlay_webp' and asset.asset_key=requirement.resource_key
  where profile.workspace_id=p_workspace_id
    and revision.status in ('cache_pending','ready')
    and revision.selected_agent_device_id=p_agent_device_id
    and requirement.agent_device_id=p_agent_device_id
  order by requirement.resource_kind,requirement.resource_key;
end
$function$;

revoke all on function public.g3a_list_native_roulette_cache_v1(
  uuid,uuid,text,uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.g3a_list_native_roulette_cache_v1(
  uuid,uuid,text,uuid,uuid,text,text,text) to service_role;

create or replace function public.g3a_prepare_native_roulette_tts_v1(
  p_workspace_id uuid,
  p_requirement_id uuid,
  p_expected_voice_key text,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text)
returns table(tts_text text,voice_key text)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component<>'agent_runtime' or p_requirement_id is null
     or p_expected_voice_key!~'^[0-9a-f]{64}$'
  then raise exception 'native roulette TTS request is invalid' using errcode='22023'; end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_agent_device_id,p_agent_secret_hash);
  return query
  select requirement.tts_text,requirement.resource_key
  from byeollog_automation.native_roulette_cache_requirements requirement
  join byeollog_automation.native_roulette_revisions revision on revision.id=requirement.revision_id
  join byeollog_automation.native_roulette_profiles profile on profile.latest_revision_id=revision.id
  where requirement.id=p_requirement_id and requirement.workspace_id=p_workspace_id
    and requirement.agent_device_id=p_agent_device_id
    and requirement.resource_kind='result_tts'
    and requirement.resource_key=p_expected_voice_key
    and revision.status in ('cache_pending','ready')
    and profile.workspace_id=p_workspace_id;
  if not found then raise exception 'native roulette TTS requirement was not found' using errcode='P0002'; end if;
end
$function$;

revoke all on function public.g3a_prepare_native_roulette_tts_v1(
  uuid,uuid,text,uuid,text,uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.g3a_prepare_native_roulette_tts_v1(
  uuid,uuid,text,uuid,text,uuid,uuid,text,text,text) to service_role;

create or replace function public.g3a_ack_native_roulette_cache_v1(
  p_workspace_id uuid,
  p_requirement_id uuid,
  p_actual_content_sha256 text,
  p_actual_byte_size bigint,
  p_voice_version text,
  p_agent_device_id uuid,
  p_agent_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_requirement byeollog_automation.native_roulette_cache_requirements%rowtype;
declare v_total integer;declare v_ready integer;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,p_authorized_user_id,p_session_id,p_runtime_component,
    p_runtime_revision,p_db_revision);
  if p_runtime_component<>'agent_runtime' or p_requirement_id is null
     or p_actual_content_sha256!~'^[0-9a-f]{64}$'
     or p_actual_byte_size not between 1 and 33554432
     or (p_voice_version is not null and p_voice_version!~'^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$')
  then raise exception 'native roulette cache receipt is invalid' using errcode='22023'; end if;
  perform byeollog_automation.assert_agent_device_locked_v1(
    p_workspace_id,p_agent_device_id,p_agent_secret_hash);
  select requirement.* into v_requirement
  from byeollog_automation.native_roulette_cache_requirements requirement
  where requirement.id=p_requirement_id and requirement.workspace_id=p_workspace_id
    and requirement.agent_device_id=p_agent_device_id for update;
  if not found then raise exception 'native roulette cache requirement was not found' using errcode='P0002'; end if;
  if v_requirement.resource_kind='overlay_webp'
     and (v_requirement.expected_content_sha256<>p_actual_content_sha256
       or v_requirement.expected_byte_size<>p_actual_byte_size or p_voice_version is not null)
  then raise exception 'native roulette WebP cache identity changed' using errcode='40001'; end if;
  if v_requirement.resource_kind='result_tts' and p_voice_version is null
  then raise exception 'native roulette TTS voice version is required' using errcode='22023'; end if;
  if v_requirement.resource_kind='result_tts' and p_actual_byte_size>2097152
  then raise exception 'native roulette TTS cache receipt is too large' using errcode='22023'; end if;
  if v_requirement.ready_at is not null and (
    v_requirement.actual_content_sha256<>p_actual_content_sha256
    or v_requirement.actual_byte_size<>p_actual_byte_size
    or v_requirement.voice_version is distinct from p_voice_version)
  then raise exception 'native roulette cache receipt changed' using errcode='40001'; end if;
  update byeollog_automation.native_roulette_cache_requirements requirement
  set actual_content_sha256=p_actual_content_sha256,actual_byte_size=p_actual_byte_size,
    voice_version=p_voice_version,ready_at=coalesce(requirement.ready_at,clock_timestamp())
  where requirement.id=p_requirement_id;
  select count(*)::integer,count(*) filter(where requirement.ready_at is not null)::integer
  into v_total,v_ready
  from byeollog_automation.native_roulette_cache_requirements requirement
  where requirement.revision_id=v_requirement.revision_id;
  if v_total>0 and v_total=v_ready then
    update byeollog_automation.native_roulette_revisions revision
    set status='ready',ready_at=coalesce(revision.ready_at,clock_timestamp())
    where revision.id=v_requirement.revision_id and revision.status='cache_pending';
  end if;
  return jsonb_build_object('requirementId',p_requirement_id,'total',v_total,
    'ready',v_ready,'pending',v_total-v_ready,'readyForActivation',v_total>0 and v_total=v_ready,
    'activationAvailable',false);
end
$function$;

revoke all on function public.g3a_ack_native_roulette_cache_v1(
  uuid,uuid,text,bigint,text,uuid,text,uuid,uuid,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.g3a_ack_native_roulette_cache_v1(
  uuid,uuid,text,bigint,text,uuid,text,uuid,uuid,text,text,text) to service_role;

create or replace function byeollog_automation.native_roulette_sample_ppm_v1()
returns integer
language plpgsql
volatile
security definer
set search_path=''
as $function$
declare v_value numeric;declare v_limit numeric:=4294000000;
begin
  loop
    v_value:=get_byte(extensions.gen_random_bytes(4),0)::numeric*16777216
      +get_byte(extensions.gen_random_bytes(4),1)::numeric*65536
      +get_byte(extensions.gen_random_bytes(4),2)::numeric*256
      +get_byte(extensions.gen_random_bytes(4),3)::numeric;
    if v_value<v_limit then return mod(v_value,1000000)::integer; end if;
  end loop;
end
$function$;

revoke all on function byeollog_automation.native_roulette_sample_ppm_v1()
  from public,anon,authenticated,service_role;

create or replace function public.ingest_native_roulette_soop_donation_v1(
  p_workspace_id uuid,
  p_event_id text,
  p_actor_id text,
  p_actor_name text,
  p_amount bigint,
  p_message text,
  p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_revision byeollog_automation.native_roulette_revisions%rowtype;
  v_donation_id uuid:=extensions.gen_random_uuid();
  v_existing byeollog_automation.native_roulette_donations%rowtype;
  v_item byeollog_automation.native_roulette_items%rowtype;
  v_spin_count integer;v_spin integer;v_sample integer;v_key text;v_payload jsonb;v_spin_id uuid;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 200
     or p_event_id~'[[:cntrl:]]' or char_length(btrim(p_actor_id)) not between 1 and 180
     or p_actor_id~'[[:cntrl:]]' or char_length(btrim(p_actor_name)) not between 1 and 120
     or p_actor_name~'[[:cntrl:]]' or p_amount not between 1 and 1000000000000
     or p_occurred_at is null or p_occurred_at>clock_timestamp()+interval '2 minutes'
     or (p_message is not null and (char_length(p_message)>1000 or p_message~'[[:cntrl:]]'))
  then raise exception 'native roulette SOOP donation is invalid' using errcode='22023'; end if;

  select revision.* into v_revision
  from byeollog_automation.native_roulette_profiles profile
  join byeollog_automation.native_roulette_revisions revision
    on revision.id=profile.active_revision_id
  where profile.workspace_id=p_workspace_id and revision.status='active';
  if not found then
    -- No activation RPC exists in this migration, so SDK traffic is fail-closed.
    raise exception 'native roulette is not active' using errcode='55000';
  end if;
  v_spin_count:=case when v_revision.allow_multiple_spins
    then least(100,(p_amount/v_revision.balloons_per_spin)::integer)
    when p_amount=v_revision.balloons_per_spin then 1 else 0 end;
  insert into byeollog_automation.native_roulette_donations(
    id,workspace_id,revision_id,soop_event_id,actor_id,actor_name,amount,message,
    occurred_at,spin_count,status)
  values(v_donation_id,p_workspace_id,v_revision.id,btrim(p_event_id),lower(btrim(p_actor_id)),
    btrim(p_actor_name),p_amount,nullif(btrim(p_message),''),p_occurred_at,v_spin_count,
    case when v_spin_count=0 then 'ignored' else 'dispatch_pending' end)
  on conflict(workspace_id,soop_event_id) do nothing;
  if not found then
    select donation.* into strict v_existing
    from byeollog_automation.native_roulette_donations donation
    where donation.workspace_id=p_workspace_id and donation.soop_event_id=btrim(p_event_id);
    if v_existing.actor_id<>lower(btrim(p_actor_id)) or v_existing.amount<>p_amount
       or v_existing.occurred_at<>p_occurred_at
    then raise exception 'native roulette SOOP event identity changed' using errcode='40001'; end if;
    return jsonb_build_object('duplicate',true,'donationId',v_existing.id,
      'spinCount',v_existing.spin_count,'status',v_existing.status,
      'spins',coalesce((select jsonb_agg(spin.dispatch_payload order by spin.spin_index)
        from byeollog_automation.native_roulette_spins spin where spin.donation_id=v_existing.id),'[]'::jsonb));
  end if;
  if v_spin_count=0 then
    return jsonb_build_object('duplicate',false,'donationId',v_donation_id,
      'spinCount',0,'status','ignored','spins','[]'::jsonb);
  end if;
  for v_spin in 0..v_spin_count-1 loop
    v_sample:=byeollog_automation.native_roulette_sample_ppm_v1();
    select selected.* into strict v_item
    from (
      select item.*,sum(item.probability_ppm) over(order by item.position) upper_bound
      from byeollog_automation.native_roulette_items item
      where item.revision_id=v_revision.id
    ) selected where v_sample<selected.upper_bound order by selected.position limit 1;
    v_key:='soop-native-roulette:'||btrim(p_event_id)||':'||v_spin::text;
    if v_item.direct_upbo then
      v_payload:=jsonb_build_object(
        'schemaVersion','1.0','kind','direct_upbo','skipAutomation',true,
        'skipPresentation',true,'sourceEventKey',v_key,'result',v_item.result_text,
        'eventName',v_item.upbo_event_name,'outputTypes',to_jsonb(v_item.output_types),
        'quantity',1,'actor',jsonb_build_object('id',lower(btrim(p_actor_id)),'name',btrim(p_actor_name)));
    else
      v_payload:=jsonb_build_object(
        'schemaVersion','1.0','kind','automation_event','skipAutomation',false,
        'skipPresentation',false,
        'event',jsonb_build_object(
          'schemaVersion','1.0','externalEventId',v_key,'source','byeollog','platform','soop',
          'eventType','roulette','subtype','native',
          'actor',jsonb_build_object('id',lower(btrim(p_actor_id)),'name',btrim(p_actor_name)),
          'amount',p_amount,'currency','balloon','occurredAt',p_occurred_at,
          'payload',jsonb_build_object('result',v_item.result_text,'spinIndex',v_spin,
            'rouletteProfileId',v_revision.profile_id,'rouletteRevisionId',v_revision.id,
            'rouletteItemId',v_item.id,'donationEventId',btrim(p_event_id))),
        'presentation',jsonb_build_object(
          'schemaVersion','1.0','kind','native_roulette_result',
          'overlayAssetKey',v_revision.overlay_asset_key,
          'overlayAssetSha256',v_revision.overlay_asset_sha256,
          'soundKey',v_revision.sound_key,'soundVolumePercent',v_revision.sound_volume_percent,
          'ttsText',v_item.tts_text,'ttsVoiceKey',v_item.tts_voice_key,
          'ttsVolumePercent',v_revision.tts_volume_percent));
    end if;
    v_spin_id:=extensions.gen_random_uuid();
    insert into byeollog_automation.native_roulette_spins(
      id,donation_id,workspace_id,revision_id,item_id,spin_index,sample_ppm,
      source_event_key,result_text,direct_upbo,dispatch_payload)
    values(v_spin_id,v_donation_id,p_workspace_id,v_revision.id,v_item.id,v_spin,v_sample,
      v_key,v_item.result_text,v_item.direct_upbo,v_payload);
    insert into byeollog_automation.native_roulette_dispatch_outbox(
      workspace_id,spin_id,dispatch_kind,payload)
    values(p_workspace_id,v_spin_id,
      case when v_item.direct_upbo then 'direct_upbo' else 'automation_event' end,v_payload);
  end loop;
  update byeollog_automation.native_roulette_donations
  set status='dispatched' where id=v_donation_id;
  return jsonb_build_object('duplicate',false,'donationId',v_donation_id,
    'spinCount',v_spin_count,'status','dispatched',
    'spins',(select jsonb_agg(spin.dispatch_payload order by spin.spin_index)
      from byeollog_automation.native_roulette_spins spin where spin.donation_id=v_donation_id));
end
$function$;

revoke all on function public.ingest_native_roulette_soop_donation_v1(
  uuid,text,text,text,bigint,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_donation_v1(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;

create or replace function public.claim_native_roulette_dispatch_v1(
  p_workspace_id uuid,
  p_worker_id text,
  p_limit integer default 10,
  p_lease_seconds integer default 45)
returns table(
  dispatch_id uuid,spin_id uuid,dispatch_kind text,payload jsonb,
  attempt_count integer,lease_expires_at timestamptz)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
begin
  if p_workspace_id is null or char_length(btrim(p_worker_id)) not between 1 and 180
     or p_worker_id~'[[:cntrl:]]' or p_limit not between 1 and 50
     or p_lease_seconds not between 5 and 600
  then raise exception 'native roulette dispatch claim is invalid' using errcode='22023'; end if;
  update byeollog_automation.native_roulette_dispatch_outbox outbox
  set status='failed',worker_id=null,lease_expires_at=null,
    last_error='dispatch lease expired after final attempt',processed_at=clock_timestamp()
  where outbox.workspace_id=p_workspace_id and outbox.status='processing'
    and outbox.attempt_count>=10 and outbox.lease_expires_at<=clock_timestamp();
  return query
  with candidates as (
    select outbox.id
    from byeollog_automation.native_roulette_dispatch_outbox outbox
    where outbox.workspace_id=p_workspace_id
      and outbox.attempt_count<10
      and (outbox.status='pending'
        or (outbox.status='processing' and outbox.lease_expires_at<=clock_timestamp()))
    order by outbox.created_at,outbox.id
    for update skip locked
    limit p_limit
  ), claimed as (
    update byeollog_automation.native_roulette_dispatch_outbox outbox
    set status='processing',attempt_count=outbox.attempt_count+1,
      worker_id=btrim(p_worker_id),
      lease_expires_at=clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds),
      last_error=null
    from candidates where outbox.id=candidates.id
    returning outbox.*
  )
  select claimed.id,claimed.spin_id,claimed.dispatch_kind,claimed.payload,
    claimed.attempt_count,claimed.lease_expires_at
  from claimed order by claimed.created_at,claimed.id;
end
$function$;

revoke all on function public.claim_native_roulette_dispatch_v1(uuid,text,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_dispatch_v1(uuid,text,integer,integer)
  to service_role;

create or replace function public.finish_native_roulette_dispatch_v1(
  p_workspace_id uuid,
  p_dispatch_id uuid,
  p_worker_id text,
  p_succeeded boolean,
  p_retryable boolean,
  p_error text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_outbox byeollog_automation.native_roulette_dispatch_outbox%rowtype;
begin
  if p_workspace_id is null or p_dispatch_id is null
     or char_length(btrim(p_worker_id)) not between 1 and 180
     or p_worker_id~'[[:cntrl:]]' or p_succeeded is null or p_retryable is null
     or (p_succeeded and (p_retryable or p_error is not null))
     or (not p_succeeded and (p_error is null or char_length(p_error) not between 1 and 2000))
  then raise exception 'native roulette dispatch acknowledgement is invalid' using errcode='22023'; end if;
  select outbox.* into v_outbox
  from byeollog_automation.native_roulette_dispatch_outbox outbox
  where outbox.id=p_dispatch_id and outbox.workspace_id=p_workspace_id for update;
  if not found or v_outbox.status<>'processing' or v_outbox.worker_id<>btrim(p_worker_id)
     or v_outbox.lease_expires_at<=clock_timestamp()
  then raise exception 'native roulette dispatch lease is unavailable' using errcode='55000'; end if;
  update byeollog_automation.native_roulette_dispatch_outbox outbox
  set status=case
      when p_succeeded then 'succeeded'
      when p_retryable and outbox.attempt_count<10 then 'pending'
      else 'failed' end,
    worker_id=null,lease_expires_at=null,last_error=p_error,
    processed_at=case when p_succeeded or not p_retryable or outbox.attempt_count>=10
      then clock_timestamp() else null end
  where outbox.id=p_dispatch_id
  returning outbox.* into v_outbox;
  return jsonb_build_object('dispatchId',v_outbox.id,'status',v_outbox.status,
    'attemptCount',v_outbox.attempt_count,'terminal',v_outbox.status in ('succeeded','failed'));
end
$function$;

revoke all on function public.finish_native_roulette_dispatch_v1(
  uuid,uuid,text,boolean,boolean,text) from public,anon,authenticated,service_role;
grant execute on function public.finish_native_roulette_dispatch_v1(
  uuid,uuid,text,boolean,boolean,text) to service_role;

-- Deliberately absent: activate_native_roulette_*.
-- A later approval/release migration must atomically require all of:
--   1. SOOP Chat SDK gate enabled,
--   2. selected asset delivery_status='published',
--   3. selected Agent advertises native_roulette.overlay,
--   4. every cache requirement has a matching ready receipt.
