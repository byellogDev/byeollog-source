-- Fail-closed SOOP tenant ownership. A signed gateway lease binds one server
-- workspace to one canonical SOOP broadcaster. Provider events may be
-- committed only once globally and every wallpaper asset selection rechecks
-- that ownership inside the database.

-- Existing approved accounts predate canonical identity persistence. Their
-- workspace slugs were created from the submitted SOOP ID; prefer the original
-- approved application value where it is still available.
update public.byeollog_workspaces workspace set
  soop_id=lower(coalesce(
    (select nullif(btrim(application.soop_id),'')
     from public.byeollog_signup_applications application
     where application.workspace_id=workspace.id
     order by application.created_at desc limit 1),
    workspace.slug)),
  updated_at=clock_timestamp()
where workspace.soop_id is null
  and exists(select 1 from public.byeollog_soop_runtime_controls control
    where control.workspace_id=workspace.id and control.gateway_enabled and control.core_collection_enabled)
  and workspace.slug~'^[a-z0-9_.-]+$';

create unique index if not exists byeollog_workspaces_unique_soop_id_idx
  on public.byeollog_workspaces(lower(soop_id)) where soop_id is not null;

create or replace function public.sync_approved_signup_soop_identity_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  if new.status='approved' and new.workspace_id is not null and nullif(btrim(new.soop_id),'') is not null then
    update public.byeollog_workspaces workspace set
      soop_id=lower(btrim(new.soop_id)),updated_at=clock_timestamp()
    where workspace.id=new.workspace_id
      and (workspace.soop_id is null or lower(workspace.soop_id)=lower(btrim(new.soop_id)));
    if not found then raise exception 'approved SOOP identity conflicts with workspace' using errcode='23505'; end if;
  end if;
  return new;
end
$function$;
revoke all on function public.sync_approved_signup_soop_identity_v1()
  from public,anon,authenticated,service_role;
drop trigger if exists sync_approved_signup_soop_identity_v1 on public.byeollog_signup_applications;
create trigger sync_approved_signup_soop_identity_v1
after insert or update of status,workspace_id,soop_id on public.byeollog_signup_applications
for each row execute function public.sync_approved_signup_soop_identity_v1();

alter table public.byeollog_soop_gateway_sessions
  add column if not exists bj_id text;
alter table public.byeollog_soop_gateway_sessions
  drop constraint if exists byeollog_soop_gateway_sessions_bj_id_check;
alter table public.byeollog_soop_gateway_sessions
  add constraint byeollog_soop_gateway_sessions_bj_id_check
  check (bj_id is null or (char_length(bj_id) between 1 and 180 and bj_id~'^[a-z0-9_.-]+$'));

create unique index if not exists byeollog_soop_gateway_one_live_bj_idx
  on public.byeollog_soop_gateway_sessions(lower(bj_id))
  where state='connected' and bj_id is not null;
create unique index if not exists byeollog_soop_gateway_one_live_room_idx
  on public.byeollog_soop_gateway_sessions(chat_number)
  where state='connected' and chat_number is not null;

create table if not exists public.byeollog_soop_event_ownership (
  event_fingerprint text primary key check(event_fingerprint~'^[0-9a-f]{64}$'),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  provider_bj_id text not null check(char_length(provider_bj_id) between 1 and 180 and provider_bj_id~'^[a-z0-9_.-]+$'),
  chat_number bigint not null check(chat_number>0),
  claimed_at timestamptz not null default clock_timestamp(),
  last_seen_at timestamptz not null default clock_timestamp()
);

create table if not exists private.soop_workspace_conflicts (
  id bigint generated always as identity primary key,
  event_fingerprint text not null check(event_fingerprint~'^[0-9a-f]{64}$'),
  owner_workspace_id uuid not null,
  rejected_workspace_id uuid not null,
  owner_bj_id text not null,
  rejected_bj_id text not null,
  detected_at timestamptz not null default clock_timestamp(),
  check(owner_workspace_id<>rejected_workspace_id)
);
create index if not exists soop_workspace_conflicts_time_idx
  on private.soop_workspace_conflicts(detected_at desc);

alter table public.byeollog_soop_event_ownership enable row level security;
revoke all on table public.byeollog_soop_event_ownership from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_soop_event_ownership to service_role;
revoke all on table private.soop_workspace_conflicts from public,anon,authenticated,service_role;
grant select,insert on table private.soop_workspace_conflicts to service_role;
grant usage,select on sequence private.soop_workspace_conflicts_id_seq to service_role;

create or replace function public.claim_soop_event_ownership_v1(
  p_workspace_id uuid,p_event_fingerprint text,p_provider_bj_id text,p_chat_number bigint)
returns text
language plpgsql
security definer
set search_path=''
set statement_timeout='3s'
as $function$
declare v_owner public.byeollog_soop_event_ownership%rowtype;v_expected text;
begin
  if p_workspace_id is null or p_event_fingerprint!~'^[0-9a-f]{64}$'
    or char_length(btrim(p_provider_bj_id)) not between 1 and 180
    or lower(btrim(p_provider_bj_id))!~'^[a-z0-9_.-]+$' or p_chat_number<=0
  then raise exception 'SOOP event ownership claim is invalid' using errcode='22023'; end if;
  select lower(workspace.soop_id) into v_expected from public.byeollog_workspaces workspace
  where workspace.id=p_workspace_id and workspace.status='active';
  if v_expected is null or v_expected<>lower(btrim(p_provider_bj_id)) then
    raise exception 'SOOP room owner does not match workspace' using errcode='23514',constraint='soop_room_owner_mismatch';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('soop-event-owner:'||p_event_fingerprint,9173));
  select owner.* into v_owner from public.byeollog_soop_event_ownership owner
  where owner.event_fingerprint=p_event_fingerprint;
  if v_owner.event_fingerprint is null then
    insert into public.byeollog_soop_event_ownership(event_fingerprint,workspace_id,provider_bj_id,chat_number)
    values(p_event_fingerprint,p_workspace_id,lower(btrim(p_provider_bj_id)),p_chat_number);
    return 'claimed';
  end if;
  if v_owner.workspace_id=p_workspace_id and v_owner.provider_bj_id=lower(btrim(p_provider_bj_id)) then
    update public.byeollog_soop_event_ownership set last_seen_at=clock_timestamp()
    where event_fingerprint=p_event_fingerprint;
    return 'owned';
  end if;
  insert into private.soop_workspace_conflicts(
    event_fingerprint,owner_workspace_id,rejected_workspace_id,owner_bj_id,rejected_bj_id)
  values(p_event_fingerprint,v_owner.workspace_id,p_workspace_id,v_owner.provider_bj_id,lower(btrim(p_provider_bj_id)));
  return 'conflict';
end
$function$;
revoke all on function public.claim_soop_event_ownership_v1(uuid,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_soop_event_ownership_v1(uuid,text,text,bigint) to service_role;

alter table public.byeollog_soop_core_donations
  add column if not exists source_bj_id text,
  add column if not exists source_chat_number bigint,
  add column if not exists source_event_fingerprint text;
alter table public.byeollog_soop_core_donations
  drop constraint if exists byeollog_soop_core_donations_source_identity_check;
alter table public.byeollog_soop_core_donations
  add constraint byeollog_soop_core_donations_source_identity_check check(
    (source_bj_id is null and source_chat_number is null and source_event_fingerprint is null)
    or (source_bj_id~'^[a-z0-9_.-]+$' and source_chat_number>0 and source_event_fingerprint~'^[0-9a-f]{64}$'));
create unique index if not exists byeollog_soop_core_donations_workspace_id_id_idx
  on public.byeollog_soop_core_donations(workspace_id,id);

alter table public.byeollog_soop_core_roulette_results
  add column if not exists source_bj_id text,
  add column if not exists source_chat_number bigint,
  add column if not exists source_event_fingerprint text;
alter table public.byeollog_soop_core_roulette_results
  drop constraint if exists byeollog_soop_core_results_source_identity_check;
alter table public.byeollog_soop_core_roulette_results
  add constraint byeollog_soop_core_results_source_identity_check check(
    (source_bj_id is null and source_chat_number is null and source_event_fingerprint is null)
    or (source_bj_id~'^[a-z0-9_.-]+$' and source_chat_number>0 and source_event_fingerprint~'^[0-9a-f]{64}$'));
alter table public.byeollog_soop_core_roulette_results
  drop constraint if exists byeollog_soop_core_results_workspace_donation_fk;
alter table public.byeollog_soop_core_roulette_results
  add constraint byeollog_soop_core_results_workspace_donation_fk
  foreign key(workspace_id,donation_id)
  references public.byeollog_soop_core_donations(workspace_id,id)
  on delete cascade not valid;
alter table public.byeollog_wallpaper_tiles
  drop constraint if exists byeollog_wallpaper_tiles_workspace_donation_fk;
alter table public.byeollog_wallpaper_tiles
  add constraint byeollog_wallpaper_tiles_workspace_donation_fk
  foreign key(workspace_id,donation_event_id)
  references public.byeollog_soop_core_donations(workspace_id,id)
  on delete cascade not valid;

create or replace function byeollog_automation.record_wallpaper_donation_v5(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz,p_broadcast_key text,p_release_key text,
  p_provider_bj_id text,p_source_chat_number bigint,p_event_fingerprint text)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_session_id uuid;v_asset jsonb;v_source text;v_inserted integer;
  v_provider_image_allowed boolean:=false;
begin
  if not exists(
    select 1 from public.byeollog_soop_core_donations donation
    join public.byeollog_workspaces workspace on workspace.id=donation.workspace_id
    join public.byeollog_soop_event_ownership owner
      on owner.event_fingerprint=donation.source_event_fingerprint
     and owner.workspace_id=donation.workspace_id
     and owner.provider_bj_id=donation.source_bj_id
    where donation.id=p_event_id and donation.workspace_id=p_workspace_id
      and donation.source_bj_id=lower(btrim(p_provider_bj_id))
      and donation.source_chat_number=p_source_chat_number
      and donation.source_event_fingerprint=p_event_fingerprint
      and lower(workspace.soop_id)=donation.source_bj_id
  ) then raise exception 'wallpaper source ownership is invalid' using errcode='23514',constraint='wallpaper_source_owner_mismatch'; end if;

  if p_amount between 1 and 30000 then
    select signature.wallpaper_image into v_asset
    from public.byeollog_signature_balloons signature
    where signature.workspace_id=p_workspace_id and signature.balloon_count=p_amount::integer;
    if v_asset is not null then v_source:='signature'; end if;
  end if;
  if v_asset is null and p_ceremony_image_url is not null then
    -- Provider image URLs are permitted only for events arriving near their
    -- live occurrence. Delayed/historical replays retain the donation but use
    -- a registered/default asset, matching the current-session-only policy.
    v_provider_image_allowed:=p_occurred_at between
      clock_timestamp()-interval '2 minutes' and clock_timestamp()+interval '30 seconds';
  end if;
  if v_asset is null and p_ceremony_image_url is not null and v_provider_image_allowed then
    v_source:='soop';v_asset:=jsonb_build_object(
      'url',p_ceremony_image_url,'roomChatNumber',p_source_chat_number,
      'providerBjId',lower(btrim(p_provider_bj_id)),'workspaceId',p_workspace_id);
  end if;
  if v_asset is null then
    v_source:='soop_default';v_asset:=jsonb_build_object('url','https://res.sooplive.com/new_player/items/'||case
      when p_amount<=50 then 'ba_step2.png' when p_amount<=100 then 'ba_step3.png'
      when p_amount<=500 then 'ba_step4.png' when p_amount<=1000 then 'ba_step5.png' else 'ba_step6.png' end);
  end if;
  v_session_id:=public.ensure_wallpaper_broadcast_session_v2(p_workspace_id,p_broadcast_key,p_occurred_at,p_release_key);
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
revoke all on function byeollog_automation.record_wallpaper_donation_v5(
  uuid,uuid,text,bigint,text,timestamptz,text,text,text,bigint,text)
  from public,anon,authenticated,service_role;

create or replace function public.ingest_soop_core_donation_v2(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_donation_type_label text,p_ceremony_image_url text,
  p_occurred_at timestamptz,p_broadcast_key text,p_release_key text,
  p_provider_bj_id text,p_source_chat_number bigint,p_event_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare
  v_id uuid;v_inserted integer;v_wallpaper boolean:=false;v_source_key text;
  v_fixed_rewards jsonb:='[]'::jsonb;v_source_uid text;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 180
    or char_length(btrim(p_actor_id)) not between 1 and 180
    or char_length(btrim(p_actor_name)) not between 1 and 120
    or p_amount not between 1 and 1000000000 or p_occurred_at is null
    or p_event_fingerprint!~'^[0-9a-f]{64}$' or p_source_chat_number<=0
    or not exists(select 1 from public.byeollog_soop_event_ownership owner
      where owner.event_fingerprint=p_event_fingerprint and owner.workspace_id=p_workspace_id
        and owner.provider_bj_id=lower(btrim(p_provider_bj_id)) and owner.chat_number=p_source_chat_number)
  then raise exception 'core SOOP donation ownership is invalid' using errcode='23514',constraint='core_donation_owner_mismatch'; end if;

  v_source_key:='soop_sdk:'||btrim(p_event_id);
  select coalesce(jsonb_agg(jsonb_build_object(
    'event_name',rule.event_name,'upbo_type',rule.upbo_type,'quantity',rule.quantity)
    order by rule.event_name,rule.upbo_type),'[]'::jsonb)
  into v_fixed_rewards from public.byeollog_fixed_upbo_rules rule
  where rule.workspace_id=p_workspace_id and rule.balloons=p_amount;

  insert into public.byeollog_soop_core_donations(
    workspace_id,provider_event_id,actor_id,actor_name,amount,donation_type_label,
    occurred_at,broadcast_key,source_bj_id,source_chat_number,source_event_fingerprint)
  values(p_workspace_id,btrim(p_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,
    coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),p_occurred_at,btrim(p_broadcast_key),
    lower(btrim(p_provider_bj_id)),p_source_chat_number,p_event_fingerprint)
  on conflict(workspace_id,provider_event_id) do nothing returning id into v_id;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then
    select donation.id into v_id from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.provider_event_id=btrim(p_event_id)
      and donation.source_bj_id=lower(btrim(p_provider_bj_id))
      and donation.source_chat_number=p_source_chat_number
      and donation.source_event_fingerprint=p_event_fingerprint;
    if v_id is null then raise exception 'duplicate donation ownership mismatch' using errcode='23514',constraint='core_donation_duplicate_owner_mismatch'; end if;
    if jsonb_array_length(v_fixed_rewards)>0 then v_source_uid:=v_source_key; end if;
    return jsonb_build_object('duplicate',true,'status','duplicate','donationId',v_id,
      'wallpaperRecorded',false,'sourceUid',v_source_uid,'fixedRuleCount',jsonb_array_length(v_fixed_rewards));
  end if;

  v_wallpaper:=byeollog_automation.record_wallpaper_donation_v5(
    p_workspace_id,v_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at,
    p_broadcast_key,p_release_key,p_provider_bj_id,p_source_chat_number,p_event_fingerprint);
  insert into public.bangsel_donations(
    workspace_id,source_event_key,source,donation_type,donated_date,donated_time,donated_at,
    soop_id,nickname,balloons,message,had_roulette,roulette_count,roulette_results,event_name,raw_payload)
  values(p_workspace_id,v_source_key,'soop_chat_sdk',coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),
    (p_occurred_at at time zone 'Asia/Seoul')::date,(p_occurred_at at time zone 'Asia/Seoul')::time,
    p_occurred_at,lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,null,false,0,'[]'::jsonb,null,
    jsonb_build_object('source_provider','soop_chat_sdk','provider_event_id',btrim(p_event_id),
      'provider_bj_id',lower(btrim(p_provider_bj_id)),'source_chat_number',p_source_chat_number,
      'event_fingerprint',p_event_fingerprint))
  on conflict(workspace_id,source_event_key) do nothing;
  if jsonb_array_length(v_fixed_rewards)>0 then
    v_source_uid:=v_source_key;
    insert into public.bangsel_collector_staging(
      workspace_id,source_uid,session_id,donated_time_text,nickname,soop_id,balloons,roulette,
      collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,
      roulette_results,fixed_rewards,process_status,source_scope,uploaded_at)
    values(p_workspace_id,v_source_uid,btrim(p_broadcast_key),
      to_char(p_occurred_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
      btrim(p_actor_name),lower(btrim(p_actor_id)),p_amount,'','soop-chat-sdk-core-v2',
      jsonb_build_object('type','SENDBALLOON','source_provider','soop_chat_sdk',
        'provider_event_id',btrim(p_event_id),'provider_bj_id',lower(btrim(p_provider_bj_id)),
        'source_chat_number',p_source_chat_number,'event_fingerprint',p_event_fingerprint,
        'fixed_classification','server'),null,null,0,'unmapped','[]'::jsonb,
      v_fixed_rewards,'pending','soop',clock_timestamp())
    on conflict(workspace_id,source_uid) do update set
      fixed_rewards=excluded.fixed_rewards,process_status=case
        when bangsel_collector_staging.process_status in ('failed','needs_review') then 'pending'
        else bangsel_collector_staging.process_status end,
      process_error=null,uploaded_at=excluded.uploaded_at;
  end if;
  return jsonb_build_object('duplicate',false,'status','recorded','donationId',v_id,
    'wallpaperRecorded',v_wallpaper,'sourceUid',v_source_uid,
    'fixedRuleCount',jsonb_array_length(v_fixed_rewards));
end
$function$;

revoke all on function public.ingest_soop_core_donation_v2(
  uuid,text,text,text,bigint,text,text,timestamptz,text,text,text,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_core_donation_v2(
  uuid,text,text,text,bigint,text,text,timestamptz,text,text,text,bigint,text) to service_role;

create or replace function public.ingest_soop_external_roulette_result_v3(
  p_workspace_id uuid,p_chat_event_id text,p_chat_actor_id text,p_chat_actor_name text,
  p_donor_name_hint text,p_roulette_name text,p_result_text text,p_raw_message text,
  p_occurred_at timestamptz,p_broadcast_key text,p_provider_bj_id text,
  p_source_chat_number bigint,p_event_fingerprint text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare v_result jsonb;v_updated integer;
begin
  if p_workspace_id is null or char_length(btrim(p_provider_bj_id)) not between 1 and 180
    or lower(btrim(p_provider_bj_id))!~'^[a-z0-9_.-]+$' or p_source_chat_number<=0
    or p_event_fingerprint!~'^[0-9a-f]{64}$'
  then raise exception 'SOOP roulette ownership is invalid' using errcode='22023'; end if;
  if not exists(
    select 1 from public.byeollog_workspaces workspace
    join public.byeollog_soop_event_ownership owner
      on owner.workspace_id=workspace.id
     and owner.event_fingerprint=p_event_fingerprint
     and owner.provider_bj_id=lower(btrim(p_provider_bj_id))
     and owner.chat_number=p_source_chat_number
    where workspace.id=p_workspace_id and workspace.status='active'
      and lower(workspace.soop_id)=lower(btrim(p_provider_bj_id)))
  then raise exception 'SOOP roulette ownership is invalid' using errcode='23514',constraint='roulette_owner_mismatch'; end if;

  v_result:=public.ingest_soop_external_roulette_result_v2(
    p_workspace_id,p_chat_event_id,p_chat_actor_id,p_chat_actor_name,p_donor_name_hint,
    p_roulette_name,p_result_text,p_raw_message,p_occurred_at,p_broadcast_key);
  update public.byeollog_soop_core_roulette_results result set
    source_bj_id=lower(btrim(p_provider_bj_id)),source_chat_number=p_source_chat_number,
    source_event_fingerprint=p_event_fingerprint
  where result.workspace_id=p_workspace_id and result.provider_chat_id=btrim(p_chat_event_id)
    and ((result.source_bj_id is null and result.source_chat_number is null and result.source_event_fingerprint is null)
      or (result.source_bj_id=lower(btrim(p_provider_bj_id))
        and result.source_chat_number=p_source_chat_number
        and result.source_event_fingerprint=p_event_fingerprint));
  get diagnostics v_updated=row_count;
  if v_updated<>1 then
    raise exception 'SOOP roulette result provenance conflicts with stored row'
      using errcode='23514',constraint='roulette_result_owner_mismatch';
  end if;
  return v_result;
end
$function$;

revoke all on function public.ingest_soop_external_roulette_result_v3(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_external_roulette_result_v3(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text) to service_role;

comment on table public.byeollog_soop_event_ownership is
  'Global provider-event ownership fence. One SOOP event fingerprint can belong to exactly one workspace.';
comment on function public.ingest_soop_core_donation_v2(
  uuid,text,text,text,bigint,text,text,timestamptz,text,text,text,bigint,text) is
  'Stores a donation only after canonical broadcaster, room and global event ownership are proven.';
comment on function public.ingest_soop_external_roulette_result_v3(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text) is
  'Correlates a roulette result only after canonical broadcaster, room and global event ownership are proven again inside the database.';


