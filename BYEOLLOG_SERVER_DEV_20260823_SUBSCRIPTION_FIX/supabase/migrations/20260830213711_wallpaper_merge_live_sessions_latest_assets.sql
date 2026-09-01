-- User-scoped wallpaper merge presets, accurate live-session identity, and
-- release observations used to explain reconnects without splitting one SOOP
-- broadcast into multiple user-visible rounds.

alter table public.byeollog_wallpaper_tiles
  drop constraint byeollog_wallpaper_tiles_layout_capacity_bounds_check,
  add constraint byeollog_wallpaper_tiles_layout_capacity_bounds_check check (
    layout_columns is null or (
      layout_columns between 1 and 217
      and layout_rows between 1 and 216
    )
  );

create or replace function byeollog_automation.is_valid_wallpaper_merge_ranges_v1(p_ranges jsonb)
returns boolean
language plpgsql
immutable
set search_path=''
as $function$
declare v_item jsonb;v_min bigint;v_max bigint;v_previous_max bigint:=null;
begin
  if p_ranges is null or jsonb_typeof(p_ranges)<>'array' or jsonb_array_length(p_ranges)>20 then return false; end if;
  for v_item in select item.value from jsonb_array_elements(p_ranges) item(value) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or jsonb_typeof(v_item->'min') is distinct from 'number'
      or jsonb_typeof(v_item->'max') is distinct from 'number'
      or (v_item->>'min') is null or (v_item->>'min')!~'^[0-9]+$'
      or (v_item->>'max') is null or (v_item->>'max')!~'^[0-9]+$'
    then return false; end if;
    v_min:=(v_item->>'min')::bigint;v_max:=(v_item->>'max')::bigint;
    if v_min not between 1 and 1000000 or v_max not between 1 and 1000000 or v_min>v_max then return false; end if;
  end loop;
  for v_item in
    select item.value from jsonb_array_elements(p_ranges) item(value)
    order by (item.value->>'min')::bigint,(item.value->>'max')::bigint
  loop
    v_min:=(v_item->>'min')::bigint;v_max:=(v_item->>'max')::bigint;
    if v_previous_max is not null and v_min<=v_previous_max then return false; end if;
    v_previous_max:=v_max;
  end loop;
  return true;
end
$function$;

revoke all on function byeollog_automation.is_valid_wallpaper_merge_ranges_v1(jsonb)
  from public,anon,authenticated;
grant execute on function byeollog_automation.is_valid_wallpaper_merge_ranges_v1(jsonb)
  to service_role;

alter table public.byeollog_wallpaper_overlay_states
  add column merge_ranges jsonb not null default '[]'::jsonb
    check (byeollog_automation.is_valid_wallpaper_merge_ranges_v1(merge_ranges)),
  add column active_settings_user_id uuid;

create table public.byeollog_wallpaper_user_settings (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  user_id uuid not null,
  merge_ranges jsonb not null default '[]'::jsonb
    check (byeollog_automation.is_valid_wallpaper_merge_ranges_v1(merge_ranges)),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,user_id)
);

alter table public.byeollog_wallpaper_user_settings enable row level security;
create policy byeollog_wallpaper_user_settings_deny_browser
  on public.byeollog_wallpaper_user_settings for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_wallpaper_user_settings
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_wallpaper_user_settings
  to service_role;

create table public.byeollog_wallpaper_release_observations (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  release_key text not null,
  first_seen_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,release_key),
  check (char_length(release_key) between 1 and 160 and release_key!~'[[:cntrl:]]')
);

alter table public.byeollog_wallpaper_release_observations enable row level security;
create policy byeollog_wallpaper_release_observations_deny_browser
  on public.byeollog_wallpaper_release_observations for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_wallpaper_release_observations
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_wallpaper_release_observations
  to service_role;

create or replace function public.save_wallpaper_merge_rules_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_merge_ranges jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_ranges jsonb;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0
    or not byeollog_automation.is_valid_wallpaper_merge_ranges_v1(p_merge_ranges)
  then raise exception 'wallpaper merge rules are invalid' using errcode='22023'; end if;
  select coalesce(jsonb_agg(item.value order by (item.value->>'min')::integer,(item.value->>'max')::integer),'[]'::jsonb)
  into v_ranges from jsonb_array_elements(p_merge_ranges) item(value);
  select overlay.revision into v_revision
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper merge revision conflict' using errcode='40001'; end if;
  insert into public.byeollog_wallpaper_user_settings(workspace_id,user_id,merge_ranges,updated_at)
  values(p_workspace_id,p_authorized_user_id,v_ranges,clock_timestamp())
  on conflict(workspace_id,user_id) do update set
    merge_ranges=excluded.merge_ranges,updated_at=excluded.updated_at;
  update public.byeollog_wallpaper_overlay_states overlay set
    merge_ranges=v_ranges,active_settings_user_id=p_authorized_user_id,
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_merge_rules_v1(uuid,uuid,bigint,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_merge_rules_v1(uuid,uuid,bigint,jsonb)
  to service_role;

create or replace function public.ensure_wallpaper_broadcast_session_v2(
  p_workspace_id uuid,p_source_key text,p_occurred_at timestamptz,p_release_key text)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;v_label text;v_effective_key text;v_chat_number bigint;
begin
  if p_workspace_id is null or p_occurred_at is null
    or char_length(btrim(p_source_key)) not between 1 and 200 or p_source_key~'[[:cntrl:]]'
    or char_length(btrim(p_release_key)) not between 1 and 160 or p_release_key~'[[:cntrl:]]'
    or not exists(select 1 from public.byeollog_workspaces workspace where workspace.id=p_workspace_id and workspace.status='active')
  then raise exception 'wallpaper broadcast session is invalid' using errcode='22023'; end if;
  insert into public.byeollog_wallpaper_release_observations(workspace_id,release_key,first_seen_at,last_seen_at)
  values(p_workspace_id,btrim(p_release_key),p_occurred_at,p_occurred_at)
  on conflict(workspace_id,release_key) do update set
    last_seen_at=greatest(public.byeollog_wallpaper_release_observations.last_seen_at,excluded.last_seen_at);
  select gateway.chat_number into v_chat_number
  from public.byeollog_soop_gateway_sessions gateway
  where gateway.workspace_id=p_workspace_id and gateway.state='connected'
    and gateway.heartbeat_at>=clock_timestamp()-interval '45 seconds';
  v_effective_key:=case when v_chat_number is not null then 'soop-chat:'||v_chat_number::text else btrim(p_source_key) end;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  select session.id into v_session_id
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.source_key=v_effective_key
  limit 1;
  if v_session_id is null then
    select session.id into v_session_id
    from public.byeollog_wallpaper_sessions session
    where session.workspace_id=p_workspace_id
      and session.started_at<=p_occurred_at+interval '2 minutes'
      and coalesce(session.closed_at,session.updated_at)>=p_occurred_at-interval '20 minutes'
    order by coalesce(session.closed_at,session.updated_at) desc,session.started_at desc
    limit 1;
    if v_session_id is not null and not exists(
      select 1 from public.byeollog_wallpaper_sessions existing
      where existing.workspace_id=p_workspace_id and existing.source_key=v_effective_key
    ) then
      update public.byeollog_wallpaper_sessions session set source_key=v_effective_key
      where session.id=v_session_id;
    end if;
  end if;
  if v_session_id is not null then
    update public.byeollog_wallpaper_sessions session set
      state='closed',closed_at=greatest(session.started_at,p_occurred_at),updated_at=clock_timestamp()
    where session.workspace_id=p_workspace_id and session.state='active' and session.id<>v_session_id;
    update public.byeollog_wallpaper_sessions session set
      state='active',closed_at=null,updated_at=clock_timestamp()
    where session.id=v_session_id and session.state<>'active';
    return v_session_id;
  end if;
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=greatest(session.started_at,p_occurred_at),updated_at=clock_timestamp()
  where session.workspace_id=p_workspace_id and session.state='active';
  v_label:=to_char(p_occurred_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송';
  insert into public.byeollog_wallpaper_sessions(workspace_id,source_key,label,started_at)
  values(p_workspace_id,v_effective_key,v_label,p_occurred_at)
  returning id into v_session_id;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  delete from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  values(p_workspace_id,v_session_id,0);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id;
  delete from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='closed'
    and session.closed_at<clock_timestamp()-interval '30 days';
  return v_session_id;
end
$function$;

revoke all on function public.ensure_wallpaper_broadcast_session_v2(uuid,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ensure_wallpaper_broadcast_session_v2(uuid,text,timestamptz,text)
  to service_role;

create or replace function byeollog_automation.record_wallpaper_donation_v3(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz,p_broadcast_key text,p_release_key text)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;v_snapshot jsonb;v_asset jsonb;v_source text;v_inserted integer;
begin
  if p_workspace_id is null or p_event_id is null or p_amount not between 1 and 1000000000
    or char_length(btrim(p_actor_name)) not between 1 and 120 or p_actor_name~'[[:cntrl:]]'
    or p_occurred_at is null or char_length(btrim(p_broadcast_key)) not between 1 and 200
  then raise exception 'wallpaper donation is invalid' using errcode='22023'; end if;
  select service.activation_snapshot into v_snapshot from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id and service.state='active';
  if v_snapshot is not null and p_amount=(v_snapshot->>'balloonsPerSpin')::bigint
    and jsonb_typeof(v_snapshot->'customSingleImage')='object' then
    v_source:='roulette';v_asset:=v_snapshot->'customSingleImage';
  elsif v_snapshot is not null and coalesce((v_snapshot->>'seriesEnabled')::boolean,false)
    and p_amount=(v_snapshot->>'seriesBalloons')::bigint
    and jsonb_typeof(coalesce(nullif(v_snapshot->'customSeriesImage','null'::jsonb),v_snapshot->'customSingleImage'))='object' then
    v_source:='roulette';v_asset:=coalesce(nullif(v_snapshot->'customSeriesImage','null'::jsonb),v_snapshot->'customSingleImage');
  end if;
  if v_asset is null and p_amount between 1 and 30000 then
    select signature.wallpaper_image into v_asset from public.byeollog_signature_balloons signature
    where signature.workspace_id=p_workspace_id and signature.balloon_count=p_amount::integer;
    if v_asset is not null then v_source:='signature'; end if;
  end if;
  if v_asset is null and p_ceremony_image_url is not null then
    v_source:='soop';v_asset:=jsonb_build_object('url',p_ceremony_image_url);
  end if;
  if v_asset is null then
    v_source:='soop_default';v_asset:=jsonb_build_object('url','https://res.sooplive.com/new_player/items/'||case
      when p_amount<=50 then 'ba_step2.png' when p_amount<=100 then 'ba_step3.png'
      when p_amount<=500 then 'ba_step4.png' when p_amount<=1000 then 'ba_step5.png' else 'ba_step6.png' end);
  end if;
  v_session_id:=public.ensure_wallpaper_broadcast_session_v2(
    p_workspace_id,p_broadcast_key,p_occurred_at,p_release_key);
  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,asset_source,asset,received_at)
  values(p_workspace_id,v_session_id,p_event_id,btrim(p_actor_name),p_amount,v_source,v_asset,p_occurred_at)
  on conflict(workspace_id,donation_event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
    update public.byeollog_wallpaper_sessions session set
      revision=session.revision+1,tile_count=session.tile_count+1,updated_at=clock_timestamp()
    where session.id=v_session_id;
    update public.byeollog_wallpaper_overlay_states overlay set
      revision=overlay.revision+1,updated_at=clock_timestamp()
    where overlay.workspace_id=p_workspace_id and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=p_workspace_id and selected.session_id=v_session_id);
  end if;
  return v_inserted=1;
end
$function$;

revoke all on function byeollog_automation.record_wallpaper_donation_v3(uuid,uuid,text,bigint,text,timestamptz,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.ingest_native_overlay_soop_donation_v8(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_ceremony_image_url text,p_occurred_at timestamptz,
  p_donation_type_label text,p_broadcast_key text,p_release_key text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare v_result jsonb;v_recorded boolean:=false;v_event_id uuid;
begin
  v_result:=public.ingest_native_overlay_soop_donation_v5(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,
    p_ceremony_image_url,p_occurred_at,p_donation_type_label);
  if not coalesce((v_result->>'duplicate')::boolean,false) then
    v_event_id:=nullif(v_result->>'eventId','')::uuid;
    if v_event_id is not null then
      v_recorded:=byeollog_automation.record_wallpaper_donation_v3(
        p_workspace_id,v_event_id,p_actor_name,p_amount,p_ceremony_image_url,
        p_occurred_at,p_broadcast_key,p_release_key);
    end if;
  end if;
  return v_result||jsonb_build_object('wallpaperRecorded',v_recorded);
end
$function$;

revoke all on function public.ingest_native_overlay_soop_donation_v8(uuid,text,text,text,bigint,text,text,timestamptz,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_overlay_soop_donation_v8(uuid,text,text,text,bigint,text,text,timestamptz,text,text,text)
  to service_role;

-- Older dashboard reads could create an empty active round even while SOOP was
-- offline. A real wallpaper round now begins only when its first donation is
-- recorded, so remove those empty containers before applying live detection.
delete from public.byeollog_wallpaper_sessions session
where session.tile_count=0 and not exists(
  select 1 from public.byeollog_wallpaper_tiles tile where tile.session_id=session.id
);

-- The four reconnect fragments from Hurogi's 2026-08-30 noon broadcast are
-- one real broadcast. Move every tile to the oldest canonical row, then remove
-- only the redundant session containers.
do $function$
declare v_workspace_id uuid;v_canonical_id uuid;v_closed_at timestamptz;
begin
  select workspace.id into v_workspace_id
  from public.byeollog_workspaces workspace where workspace.slug='observer_a' limit 1;
  if v_workspace_id is null then return; end if;
  select session.id into v_canonical_id
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=v_workspace_id and session.source_key like 'backfill:2026-08-30:%'
  order by session.started_at,session.id limit 1;
  if v_canonical_id is null then return; end if;
  select max(coalesce(session.closed_at,session.updated_at)) into v_closed_at
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=v_workspace_id and session.source_key like 'backfill:2026-08-30:%';
  update public.byeollog_wallpaper_tiles tile set session_id=v_canonical_id
  where tile.workspace_id=v_workspace_id and tile.session_id in(
    select session.id from public.byeollog_wallpaper_sessions session
    where session.workspace_id=v_workspace_id and session.source_key like 'backfill:2026-08-30:%'
      and session.id<>v_canonical_id
  );
  delete from public.byeollog_wallpaper_sessions session
  where session.workspace_id=v_workspace_id and session.source_key like 'backfill:2026-08-30:%'
    and session.id<>v_canonical_id;
  update public.byeollog_wallpaper_sessions session set
    source_key='broadcast:observer_a:2026-08-30-1200',label='08월 30일 12:00 방송',
    state='closed',started_at='2026-08-30 03:00+00'::timestamptz,
    closed_at=greatest('2026-08-30 03:00+00'::timestamptz,v_closed_at),
    tile_count=(select count(*)::integer from public.byeollog_wallpaper_tiles tile where tile.session_id=v_canonical_id),
    revision=(select count(*)::bigint from public.byeollog_wallpaper_tiles tile where tile.session_id=v_canonical_id),
    updated_at=clock_timestamp()
  where session.id=v_canonical_id;
  delete from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id=v_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  values(v_workspace_id,v_canonical_id,0);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=v_workspace_id;
end
$function$;

comment on table public.byeollog_wallpaper_user_settings is
  'Service-only per-user wallpaper merge presets. Saving a preset also makes it the active OBS preset for the workspace.';
comment on table public.byeollog_wallpaper_release_observations is
  'First and last donation timestamps observed for each web deployment, used to audit update-related reconnects.';
comment on function public.ensure_wallpaper_broadcast_session_v2(uuid,text,timestamptz,text) is
  'Wallpaper-only session identity: a fresh SOOP chat number or reconnect within 20 minutes keeps one user-visible broadcast despite gateway reconnects and web updates.';
comment on function public.ingest_native_overlay_soop_donation_v8(uuid,text,text,text,bigint,text,text,timestamptz,text,text,text) is
  'Production donation ingest with release observation and logical SOOP broadcast wallpaper grouping.';
