-- Broadcast-round wallpaper selection and historical 2026-08-30 Hurogi backfill.
-- The Agent contract is unchanged: the server derives the broadcast round from
-- the already-normalized relay connection id.

alter table public.byeollog_wallpaper_sessions
  add column source_key text,
  add column label text;

update public.byeollog_wallpaper_sessions session set
  source_key='legacy:'||session.id::text,
  label=to_char(session.started_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송'
where session.source_key is null or session.label is null;

alter table public.byeollog_wallpaper_sessions
  alter column source_key set not null,
  alter column label set not null,
  add constraint byeollog_wallpaper_sessions_source_key_check
    check (char_length(source_key) between 1 and 200 and source_key!~'[[:cntrl:]]'),
  add constraint byeollog_wallpaper_sessions_label_check
    check (char_length(label) between 1 and 100 and label!~'[[:cntrl:]]'),
  add constraint byeollog_wallpaper_sessions_id_workspace_unique unique(id,workspace_id);

create unique index byeollog_wallpaper_sessions_workspace_source_idx
  on public.byeollog_wallpaper_sessions(workspace_id,source_key);

create table public.byeollog_wallpaper_overlay_states (
  workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,
  revision bigint not null default 0 check (revision>=0),
  updated_at timestamptz not null default clock_timestamp()
);

create table public.byeollog_wallpaper_overlay_sessions (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  session_id uuid not null,
  position integer not null default 0 check (position between 0 and 9999),
  selected_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,session_id),
  foreign key(session_id,workspace_id)
    references public.byeollog_wallpaper_sessions(id,workspace_id) on delete cascade
);

create index byeollog_wallpaper_overlay_sessions_order_idx
  on public.byeollog_wallpaper_overlay_sessions(workspace_id,position,selected_at,session_id);

alter table public.byeollog_wallpaper_overlay_states enable row level security;
alter table public.byeollog_wallpaper_overlay_sessions enable row level security;
create policy byeollog_wallpaper_overlay_states_deny_browser
  on public.byeollog_wallpaper_overlay_states for all to anon,authenticated using(false) with check(false);
create policy byeollog_wallpaper_overlay_sessions_deny_browser
  on public.byeollog_wallpaper_overlay_sessions for all to anon,authenticated using(false) with check(false);
revoke all on table public.byeollog_wallpaper_overlay_states from public,anon,authenticated;
revoke all on table public.byeollog_wallpaper_overlay_sessions from public,anon,authenticated;
grant select,insert,update,delete on table public.byeollog_wallpaper_overlay_states to service_role;
grant select,insert,update,delete on table public.byeollog_wallpaper_overlay_sessions to service_role;

insert into public.byeollog_wallpaper_overlay_states(workspace_id)
select distinct session.workspace_id from public.byeollog_wallpaper_sessions session
on conflict(workspace_id) do nothing;

insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
select session.workspace_id,session.id,0
from public.byeollog_wallpaper_sessions session where session.state='active'
on conflict(workspace_id,session_id) do nothing;

create or replace function public.ensure_wallpaper_broadcast_session_v1(
  p_workspace_id uuid,p_source_key text,p_occurred_at timestamptz)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;v_label text;
begin
  if p_workspace_id is null or p_occurred_at is null
    or char_length(btrim(p_source_key)) not between 1 and 200 or p_source_key~'[[:cntrl:]]'
    or not exists(select 1 from public.byeollog_workspaces workspace where workspace.id=p_workspace_id and workspace.status='active')
  then raise exception 'wallpaper broadcast session is invalid' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  select session.id into v_session_id
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.source_key=btrim(p_source_key)
  limit 1;
  if v_session_id is not null then return v_session_id; end if;
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=greatest(session.started_at,p_occurred_at),updated_at=clock_timestamp()
  where session.workspace_id=p_workspace_id and session.state='active';
  v_label:=to_char(p_occurred_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송';
  insert into public.byeollog_wallpaper_sessions(workspace_id,source_key,label,started_at)
  values(p_workspace_id,btrim(p_source_key),v_label,p_occurred_at)
  returning id into v_session_id;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  values(p_workspace_id,v_session_id,coalesce((select max(selected.position)+1 from public.byeollog_wallpaper_overlay_sessions selected where selected.workspace_id=p_workspace_id),0))
  on conflict(workspace_id,session_id) do nothing;
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id;
  delete from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='closed'
    and session.closed_at<clock_timestamp()-interval '30 days';
  return v_session_id;
end
$function$;

revoke all on function public.ensure_wallpaper_broadcast_session_v1(uuid,text,timestamptz)
  from public,anon,authenticated;
grant execute on function public.ensure_wallpaper_broadcast_session_v1(uuid,text,timestamptz)
  to service_role;

-- Compatibility for the currently deployed v6 reader/ingest while the web
-- release is promoted after this migration.
create or replace function public.ensure_wallpaper_session_v1(p_workspace_id uuid)
returns uuid
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;v_now timestamptz:=clock_timestamp();
begin
  if p_workspace_id is null or not exists(
    select 1 from public.byeollog_workspaces workspace where workspace.id=p_workspace_id and workspace.status='active'
  ) then raise exception 'wallpaper workspace is unavailable' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=v_now,updated_at=v_now
  where session.workspace_id=p_workspace_id and session.state='active'
    and session.started_at<v_now-interval '12 hours';
  select session.id into v_session_id from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='active' limit 1;
  if v_session_id is null then
    insert into public.byeollog_wallpaper_sessions(workspace_id,source_key,label,started_at)
    values(p_workspace_id,'legacy-v6:'||gen_random_uuid()::text,
      to_char(v_now at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송',v_now)
    returning id into v_session_id;
    insert into public.byeollog_wallpaper_overlay_states(workspace_id)
    values(p_workspace_id) on conflict(workspace_id) do nothing;
    insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
    values(p_workspace_id,v_session_id,0) on conflict(workspace_id,session_id) do nothing;
    update public.byeollog_wallpaper_overlay_states overlay set
      revision=overlay.revision+1,updated_at=v_now where overlay.workspace_id=p_workspace_id;
  end if;
  delete from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.state='closed'
    and session.closed_at<v_now-interval '30 days';
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
declare v_session_id uuid;v_now timestamptz:=clock_timestamp();
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-session:'||p_workspace_id::text,8311));
  update public.byeollog_wallpaper_sessions session set
    state='closed',closed_at=v_now,updated_at=v_now
  where session.workspace_id=p_workspace_id and session.state='active';
  insert into public.byeollog_wallpaper_sessions(workspace_id,source_key,label,started_at)
  values(p_workspace_id,'manual:'||gen_random_uuid()::text,to_char(v_now at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 새 풍벽지',v_now)
  returning id into v_session_id;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  delete from public.byeollog_wallpaper_overlay_sessions selected where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  values(p_workspace_id,v_session_id,0);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=v_now where overlay.workspace_id=p_workspace_id;
  return v_session_id;
end
$function$;

revoke all on function public.rotate_wallpaper_session_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.rotate_wallpaper_session_v1(uuid,uuid) to service_role;

create or replace function public.select_wallpaper_sessions_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_session_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_requested integer;v_matched integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_session_ids is null or cardinality(p_session_ids)>20
  then raise exception 'wallpaper session selection is invalid' using errcode='22023'; end if;
  select count(*),count(distinct value) into v_requested,v_matched from unnest(p_session_ids) value;
  if v_requested<>v_matched then raise exception 'wallpaper session selection contains duplicates' using errcode='22023'; end if;
  select count(*) into v_matched
  from public.byeollog_wallpaper_sessions session where session.workspace_id=p_workspace_id and session.id=any(p_session_ids);
  if v_matched<>v_requested then raise exception 'wallpaper session selection was not found' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-selection:'||p_workspace_id::text,8311));
  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  delete from public.byeollog_wallpaper_overlay_sessions selected where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  select p_workspace_id,value,ordinality::integer-1 from unnest(p_session_ids) with ordinality item(value,ordinality);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.select_wallpaper_sessions_v1(uuid,uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.select_wallpaper_sessions_v1(uuid,uuid,uuid[]) to service_role;

create or replace function byeollog_automation.record_wallpaper_donation_v2(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz,p_broadcast_key text)
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
  v_session_id:=public.ensure_wallpaper_broadcast_session_v1(p_workspace_id,p_broadcast_key,p_occurred_at);
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

revoke all on function byeollog_automation.record_wallpaper_donation_v2(uuid,uuid,text,bigint,text,timestamptz,text)
  from public,anon,authenticated,service_role;

create or replace function public.ingest_native_overlay_soop_donation_v7(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_ceremony_image_url text,p_occurred_at timestamptz,
  p_donation_type_label text,p_broadcast_key text)
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
      v_recorded:=byeollog_automation.record_wallpaper_donation_v2(
        p_workspace_id,v_event_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at,p_broadcast_key);
    end if;
  end if;
  return v_result||jsonb_build_object('wallpaperRecorded',v_recorded);
end
$function$;

revoke all on function public.ingest_native_overlay_soop_donation_v7(uuid,text,text,text,bigint,text,text,timestamptz,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_overlay_soop_donation_v7(uuid,text,text,text,bigint,text,text,timestamptz,text,text)
  to service_role;

create or replace function public.save_wallpaper_overlay_layout_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_tiles jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_tile_count integer;v_matched_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_tiles is null
    or jsonb_typeof(p_tiles)<>'array' or jsonb_array_length(p_tiles)>216
  then raise exception 'wallpaper layout request is invalid' using errcode='22023'; end if;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='40001'; end if;
  select count(*) into v_tile_count from jsonb_array_elements(p_tiles);
  if exists(select 1 from jsonb_array_elements(p_tiles) item where jsonb_typeof(item)<>'object'
    or jsonb_typeof(item->'id')<>'string' or (item->>'x')!~'^[0-9]+$' or (item->>'y')!~'^[0-9]+$'
    or (item->>'width')!~'^[0-9]+$' or (item->>'height')!~'^[0-9]+$')
  then raise exception 'wallpaper tile layout is invalid' using errcode='22023'; end if;
  if exists(select 1 from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
    where tile.x<0 or tile.y<0 or tile.width<80 or tile.height<60 or tile.x+tile.width>1920 or tile.y+tile.height>1080)
  then raise exception 'wallpaper tile layout is out of bounds' using errcode='22023'; end if;
  if (select count(distinct tile.id) from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer))<>v_tile_count
  then raise exception 'wallpaper tile layout contains duplicates' using errcode='22023'; end if;
  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer) on tile.id=stored.id
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=stored.workspace_id and selected.session_id=stored.session_id
  where stored.workspace_id=p_workspace_id;
  if v_matched_count<>v_tile_count then raise exception 'wallpaper tile is not selected' using errcode='22023'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,layout_y=tile.y,layout_width=tile.width,layout_height=tile.height,layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles) tile(id uuid,x integer,y integer,width integer,height integer)
  where stored.id=tile.id and stored.workspace_id=p_workspace_id;
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_overlay_layout_v1(uuid,uuid,bigint,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_overlay_layout_v1(uuid,uuid,bigint,jsonb) to service_role;

create or replace function public.clear_wallpaper_overlay_layout_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='40001'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=null,layout_y=null,layout_width=null,layout_height=null,layout_updated_at=null
  where stored.workspace_id=p_workspace_id and stored.layout_x is not null and exists(
    select 1 from public.byeollog_wallpaper_overlay_sessions selected
    where selected.workspace_id=p_workspace_id and selected.session_id=stored.session_id);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.clear_wallpaper_overlay_layout_v1(uuid,uuid,bigint) from public,anon,authenticated,service_role;
grant execute on function public.clear_wallpaper_overlay_layout_v1(uuid,uuid,bigint) to service_role;

-- Rebuild the real donations from the Hurogi broadcast started at
-- 2026-08-30 12:00 KST. Test events are explicitly excluded. Each SDK
-- connection becomes a selectable broadcast round.
with target as (
  select workspace.id as workspace_id from public.byeollog_workspaces workspace where workspace.slug='observer_a' limit 1
), events as (
  select event.*,regexp_replace(event.provider_event_id, ':[^:]+$', '') connection_key
  from byeollog_automation.native_roulette_events_v2 event,target
  where event.workspace_id=target.workspace_id and event.is_test=false
    and event.occurred_at>='2026-08-30 03:00+00'::timestamptz
    and event.occurred_at<'2026-08-31 03:00+00'::timestamptz
), groups as (
  select workspace_id,connection_key,min(occurred_at) first_at,max(occurred_at) last_at,
    row_number() over(order by min(occurred_at),connection_key) round_no
  from events group by workspace_id,connection_key
), inserted as (
  insert into public.byeollog_wallpaper_sessions(
    workspace_id,source_key,label,state,started_at,closed_at,updated_at)
  select workspace_id,'backfill:2026-08-30:'||md5(connection_key),
    case when round_no=1 then '08월 30일 12:00 방송 · 연결 1'
      else to_char(first_at at time zone 'Asia/Seoul','MM월 DD일 HH24:MI')||' 방송 · 연결 '||round_no end,
    'closed',case when round_no=1 then '2026-08-30 03:00+00'::timestamptz else first_at end,
    last_at+interval '1 second',clock_timestamp()
  from groups
  on conflict(workspace_id,source_key) do update set
    label=excluded.label,started_at=excluded.started_at,closed_at=excluded.closed_at,updated_at=clock_timestamp()
  returning id,workspace_id,source_key
)
select count(*) from inserted;

with target as (
  select workspace.id as workspace_id from public.byeollog_workspaces workspace where workspace.slug='observer_a' limit 1
), events as (
  select event.*,regexp_replace(event.provider_event_id, ':[^:]+$', '') connection_key
  from byeollog_automation.native_roulette_events_v2 event,target
  where event.workspace_id=target.workspace_id and event.is_test=false
    and event.occurred_at>='2026-08-30 03:00+00'::timestamptz
    and event.occurred_at<'2026-08-31 03:00+00'::timestamptz
), prepared as (
  select event.*,session.id session_id,service.activation_snapshot snapshot,signature.wallpaper_image signature_asset
  from events event
  join public.byeollog_wallpaper_sessions session
    on session.workspace_id=event.workspace_id and session.source_key='backfill:2026-08-30:'||md5(event.connection_key)
  left join public.byeollog_native_roulette_services service
    on service.workspace_id=event.workspace_id and service.state='active'
  left join public.byeollog_signature_balloons signature
    on signature.workspace_id=event.workspace_id and signature.balloon_count=event.amount
)
insert into public.byeollog_wallpaper_tiles(
  workspace_id,session_id,donation_event_id,actor_name,amount,asset_source,asset,received_at)
select workspace_id,session_id,id,btrim(actor_name),amount,
  case
    when snapshot is not null and amount=(snapshot->>'balloonsPerSpin')::bigint and jsonb_typeof(snapshot->'customSingleImage')='object' then 'roulette'
    when snapshot is not null and coalesce((snapshot->>'seriesEnabled')::boolean,false)
      and amount=(snapshot->>'seriesBalloons')::bigint
      and jsonb_typeof(coalesce(nullif(snapshot->'customSeriesImage','null'::jsonb),snapshot->'customSingleImage'))='object' then 'roulette'
    when signature_asset is not null then 'signature' else 'soop_default' end,
  case
    when snapshot is not null and amount=(snapshot->>'balloonsPerSpin')::bigint and jsonb_typeof(snapshot->'customSingleImage')='object' then snapshot->'customSingleImage'
    when snapshot is not null and coalesce((snapshot->>'seriesEnabled')::boolean,false)
      and amount=(snapshot->>'seriesBalloons')::bigint
      and jsonb_typeof(coalesce(nullif(snapshot->'customSeriesImage','null'::jsonb),snapshot->'customSingleImage'))='object'
      then coalesce(nullif(snapshot->'customSeriesImage','null'::jsonb),snapshot->'customSingleImage')
    when signature_asset is not null then signature_asset
    else jsonb_build_object('url','https://res.sooplive.com/new_player/items/'||case
      when amount<=50 then 'ba_step2.png' when amount<=100 then 'ba_step3.png'
      when amount<=500 then 'ba_step4.png' when amount<=1000 then 'ba_step5.png' else 'ba_step6.png' end) end,
  occurred_at
from prepared
on conflict(workspace_id,donation_event_id) do nothing;

with target as (
  select workspace.id as workspace_id from public.byeollog_workspaces workspace where workspace.slug='observer_a' limit 1
), counts as (
  select session.id,count(tile.id)::integer tile_count
  from public.byeollog_wallpaper_sessions session
  join target on target.workspace_id=session.workspace_id
  left join public.byeollog_wallpaper_tiles tile on tile.session_id=session.id
  where session.source_key like 'backfill:2026-08-30:%'
  group by session.id
)
update public.byeollog_wallpaper_sessions session set
  tile_count=counts.tile_count,revision=counts.tile_count,updated_at=clock_timestamp()
from counts where session.id=counts.id;

with target as (
  select workspace.id as workspace_id from public.byeollog_workspaces workspace where workspace.slug='observer_a' limit 1
), cleared as (
  delete from public.byeollog_wallpaper_overlay_sessions selected using target
  where selected.workspace_id=target.workspace_id returning selected.workspace_id
), chosen as (
  select session.workspace_id,session.id,
    row_number() over(order by session.started_at,session.id)::integer-1 position
  from public.byeollog_wallpaper_sessions session,target
  where session.workspace_id=target.workspace_id and session.source_key like 'backfill:2026-08-30:%'
)
insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
select workspace_id,id,position from chosen
on conflict(workspace_id,session_id) do update set position=excluded.position,selected_at=clock_timestamp();

insert into public.byeollog_wallpaper_overlay_states(workspace_id,revision,updated_at)
select workspace.id,1,clock_timestamp() from public.byeollog_workspaces workspace where workspace.slug='observer_a'
on conflict(workspace_id) do update set revision=public.byeollog_wallpaper_overlay_states.revision+1,updated_at=clock_timestamp();

comment on function public.ingest_native_overlay_soop_donation_v7(uuid,text,text,text,bigint,text,text,timestamptz,text,text) is
  'Production donation ingest plus broadcast-round wallpaper ledger. The normalized relay connection id partitions reconnects into independently selectable rounds.';
