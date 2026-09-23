-- Live donation wallpaper ledger and isolated OBS output state.
-- Manual overlay tests never call the v6 production ingest and therefore do
-- not write this ledger.

create table public.byeollog_wallpaper_sessions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  state text not null default 'active' check (state in ('active','closed')),
  canvas_width integer not null default 1920 check (canvas_width=1920),
  canvas_height integer not null default 1080 check (canvas_height=1080),
  revision bigint not null default 0 check (revision>=0),
  tile_count integer not null default 0 check (tile_count>=0),
  started_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  updated_at timestamptz not null default clock_timestamp(),
  check ((state='active' and closed_at is null) or (state='closed' and closed_at is not null))
);

create unique index byeollog_wallpaper_sessions_one_active_idx
  on public.byeollog_wallpaper_sessions(workspace_id) where state='active';
create index byeollog_wallpaper_sessions_retention_idx
  on public.byeollog_wallpaper_sessions(workspace_id,closed_at) where state='closed';

create table public.byeollog_wallpaper_tiles (
  id uuid primary key default gen_random_uuid(),
  sequence_no bigint generated always as identity,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  session_id uuid not null references public.byeollog_wallpaper_sessions(id) on delete cascade,
  donation_event_id uuid not null,
  actor_name text not null check (char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]'),
  amount bigint not null check (amount between 1 and 1000000000),
  asset_source text not null check (asset_source in ('roulette','signature','soop','soop_default')),
  asset jsonb not null check (jsonb_typeof(asset)='object'),
  received_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,donation_event_id),
  unique(session_id,sequence_no)
);

create index byeollog_wallpaper_tiles_session_sequence_idx
  on public.byeollog_wallpaper_tiles(session_id,sequence_no);

alter table public.byeollog_wallpaper_sessions enable row level security;
alter table public.byeollog_wallpaper_tiles enable row level security;
create policy byeollog_wallpaper_sessions_deny_browser
  on public.byeollog_wallpaper_sessions for all to anon,authenticated using (false) with check (false);
create policy byeollog_wallpaper_tiles_deny_browser
  on public.byeollog_wallpaper_tiles for all to anon,authenticated using (false) with check (false);

revoke all on table public.byeollog_wallpaper_sessions from public,anon,authenticated;
revoke all on table public.byeollog_wallpaper_tiles from public,anon,authenticated;
grant select,insert,update,delete on table public.byeollog_wallpaper_sessions to service_role;
grant select,insert,update,delete on table public.byeollog_wallpaper_tiles to service_role;
grant usage,select on sequence public.byeollog_wallpaper_tiles_sequence_no_seq to service_role;

create or replace function public.ensure_wallpaper_session_v1(p_workspace_id uuid)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;
begin
  if p_workspace_id is null or not exists(
    select 1 from public.byeollog_workspaces workspace
    where workspace.id=p_workspace_id and workspace.status='active'
  ) then raise exception 'wallpaper workspace is unavailable' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=clock_timestamp(),updated_at=clock_timestamp()
  where session.workspace_id=p_workspace_id and session.state='active'
    and session.started_at<clock_timestamp()-interval '12 hours';
  select session.id into v_session_id from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='active' limit 1;
  if v_session_id is null then
    insert into public.byeollog_wallpaper_sessions(workspace_id)
    values(p_workspace_id) returning id into v_session_id;
  end if;
  delete from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='closed'
    and session.closed_at<clock_timestamp()-interval '30 days';
  return v_session_id;
end
$function$;

revoke all on function public.ensure_wallpaper_session_v1(uuid) from public,anon,authenticated;
grant execute on function public.ensure_wallpaper_session_v1(uuid) to service_role;

create or replace function public.rotate_wallpaper_session_v1(
  p_workspace_id uuid,p_authorized_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=clock_timestamp(),updated_at=clock_timestamp()
  where session.workspace_id=p_workspace_id and session.state='active';
  insert into public.byeollog_wallpaper_sessions(workspace_id)
  values(p_workspace_id) returning id into v_session_id;
  return v_session_id;
end
$function$;

revoke all on function public.rotate_wallpaper_session_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.rotate_wallpaper_session_v1(uuid,uuid) to service_role;

create or replace function byeollog_automation.record_wallpaper_donation_v1(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_session_id uuid;v_snapshot jsonb;v_asset jsonb;v_source text;v_inserted integer;
begin
  if p_workspace_id is null or p_event_id is null or p_amount not between 1 and 1000000000
    or char_length(btrim(p_actor_name)) not between 1 and 120 or p_actor_name~'[[:cntrl:]]'
    or p_occurred_at is null
  then raise exception 'wallpaper donation is invalid' using errcode='22023'; end if;
  select service.activation_snapshot into v_snapshot
  from public.byeollog_native_roulette_services service
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
    select signature.wallpaper_image into v_asset
    from public.byeollog_signature_balloons signature
    where signature.workspace_id=p_workspace_id and signature.balloon_count=p_amount::integer;
    if v_asset is not null then v_source:='signature'; end if;
  end if;
  if v_asset is null and p_ceremony_image_url is not null then
    v_source:='soop';v_asset:=jsonb_build_object('url',p_ceremony_image_url);
  end if;
  if v_asset is null then
    v_source:='soop_default';v_asset:=jsonb_build_object('url',
      'https://res.sooplive.com/new_player/items/'||case
        when p_amount<=50 then 'ba_step2.png' when p_amount<=100 then 'ba_step3.png'
        when p_amount<=500 then 'ba_step4.png' when p_amount<=1000 then 'ba_step5.png'
        else 'ba_step6.png' end);
  end if;
  v_session_id:=public.ensure_wallpaper_session_v1(p_workspace_id);
  insert into public.byeollog_wallpaper_tiles(
    workspace_id,session_id,donation_event_id,actor_name,amount,asset_source,asset,received_at)
  values(p_workspace_id,v_session_id,p_event_id,btrim(p_actor_name),p_amount,v_source,v_asset,p_occurred_at)
  on conflict(workspace_id,donation_event_id) do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=1 then
    update public.byeollog_wallpaper_sessions session set
      revision=session.revision+1,tile_count=session.tile_count+1,updated_at=clock_timestamp()
    where session.id=v_session_id;
  end if;
  return v_inserted=1;
end
$function$;

revoke all on function byeollog_automation.record_wallpaper_donation_v1(uuid,uuid,text,bigint,text,timestamptz)
  from public,anon,authenticated,service_role;

create or replace function public.ingest_native_overlay_soop_donation_v6(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_ceremony_image_url text,p_occurred_at timestamptz,
  p_donation_type_label text)
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
      v_recorded:=byeollog_automation.record_wallpaper_donation_v1(
        p_workspace_id,v_event_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at);
    end if;
  end if;
  return v_result||jsonb_build_object('wallpaperRecorded',v_recorded);
end
$function$;

revoke all on function public.ingest_native_overlay_soop_donation_v6(
  uuid,text,text,text,bigint,text,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_overlay_soop_donation_v6(
  uuid,text,text,text,bigint,text,text,timestamptz,text) to service_role;

comment on function public.ingest_native_overlay_soop_donation_v6(
  uuid,text,text,text,bigint,text,text,timestamptz,text) is
  'Production donation ingest plus idempotent wallpaper ledger. Asset priority is active roulette custom image, signature wallpaper image, SOOP event image, then official SOOP default.';


