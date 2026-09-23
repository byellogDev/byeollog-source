-- Core product pivot: SOOP Chat SDK is the authoritative live source for
-- wallpaper donations and external roulette results used by Upbo.  Native
-- roulette/action execution data is preserved but no longer gates collection.

alter table public.byeollog_soop_runtime_controls
  add column if not exists core_collection_enabled boolean not null default false;

update public.byeollog_soop_runtime_controls control set
  core_collection_enabled=true,
  gateway_enabled=true,
  native_roulette_enabled=false,
  overlay_experiment_enabled=false,
  overlay_experiment_draft_id=null,
  overlay_experiment_expires_at=null,
  updated_at=clock_timestamp()
where exists(
  select 1 from public.byeollog_soop_connections connection
  where connection.workspace_id=control.workspace_id and connection.status='connected'
);

-- Preserve all action history while preventing any previously configured rule
-- or already queued local action from firing after the product cutover.
update byeollog_automation.rules
set enabled=false,updated_at=clock_timestamp()
where enabled=true;

update byeollog_automation.executions
set status='cancelled',lease_owner=null,lease_expires_at=null,
  finished_at=clock_timestamp(),last_error='feature_retired_core_product_pivot'
where status in ('queued','running','retry_scheduled');

update byeollog_automation.native_roulette_overlay_outbox_v2
set status='failed',client_id=null,lease_expires_at=null,processed_at=clock_timestamp(),
  last_error='feature_retired_core_product_pivot'
where status in ('pending','processing');

alter table public.byeollog_soop_runtime_controls
  drop constraint if exists byeollog_soop_runtime_controls_core_collection_check;
alter table public.byeollog_soop_runtime_controls
  add constraint byeollog_soop_runtime_controls_core_collection_check
  check (not core_collection_enabled or gateway_enabled);

create table if not exists public.byeollog_soop_core_donations (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  provider_event_id text not null,
  actor_id text not null,
  actor_name text not null,
  amount bigint not null check(amount between 1 and 1000000000),
  donation_type_label text not null default '별풍선',
  occurred_at timestamptz not null,
  broadcast_key text not null,
  result_count integer not null default 0 check(result_count between 0 and 10000),
  last_result_at timestamptz,
  status text not null default 'pending' check(status in ('pending','collecting','expired')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,provider_event_id),
  check(char_length(provider_event_id) between 1 and 180 and provider_event_id!~'[[:cntrl:]]'),
  check(char_length(actor_id) between 1 and 180 and actor_id!~'[[:cntrl:]]'),
  check(char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]'),
  check(char_length(broadcast_key) between 1 and 200 and broadcast_key!~'[[:cntrl:]]')
);

create index if not exists byeollog_soop_core_donations_match_idx
  on public.byeollog_soop_core_donations(workspace_id,broadcast_key,occurred_at desc)
  where status in ('pending','collecting');
create index if not exists byeollog_soop_core_donations_actor_match_idx
  on public.byeollog_soop_core_donations(workspace_id,broadcast_key,lower(actor_name),occurred_at desc)
  where status in ('pending','collecting');

create table if not exists public.byeollog_soop_core_roulette_results (
  id uuid primary key default extensions.gen_random_uuid(),
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  provider_chat_id text not null,
  chat_actor_id text not null,
  chat_actor_name text not null,
  donor_name_hint text,
  roulette_name text,
  result_text text not null,
  raw_message text not null,
  occurred_at timestamptz not null,
  broadcast_key text not null,
  donation_id uuid references public.byeollog_soop_core_donations(id) on delete set null,
  match_state text not null default 'unmatched' check(match_state in ('matched','unmatched','ambiguous')),
  match_method text,
  created_at timestamptz not null default clock_timestamp(),
  unique(workspace_id,provider_chat_id),
  check(char_length(provider_chat_id) between 1 and 180 and provider_chat_id!~'[[:cntrl:]]'),
  check(char_length(chat_actor_id) between 1 and 180 and chat_actor_id!~'[[:cntrl:]]'),
  check(char_length(chat_actor_name) between 1 and 120 and chat_actor_name!~'[[:cntrl:]]'),
  check(donor_name_hint is null or (char_length(donor_name_hint) between 1 and 80 and donor_name_hint!~'[[:cntrl:]]')),
  check(roulette_name is null or (char_length(roulette_name) between 1 and 80 and roulette_name!~'[[:cntrl:]]')),
  check(char_length(result_text) between 1 and 120 and result_text!~'[[:cntrl:]]'),
  check(char_length(raw_message) between 1 and 300 and raw_message!~'[[:cntrl:]]'),
  check(char_length(broadcast_key) between 1 and 200 and broadcast_key!~'[[:cntrl:]]')
);

create index if not exists byeollog_soop_core_results_unmatched_idx
  on public.byeollog_soop_core_roulette_results(workspace_id,occurred_at desc)
  where match_state<>'matched';
create index if not exists byeollog_soop_core_results_donation_idx
  on public.byeollog_soop_core_roulette_results(workspace_id,donation_id,occurred_at,id)
  where donation_id is not null;

alter table public.byeollog_soop_core_donations enable row level security;
alter table public.byeollog_soop_core_roulette_results enable row level security;
revoke all on table public.byeollog_soop_core_donations from public,anon,authenticated,service_role;
revoke all on table public.byeollog_soop_core_roulette_results from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_soop_core_donations to service_role;
grant select,insert,update,delete on table public.byeollog_soop_core_roulette_results to service_role;

create policy byeollog_soop_core_donations_deny_browser
  on public.byeollog_soop_core_donations for all to anon,authenticated
  using(false) with check(false);
create policy byeollog_soop_core_results_deny_browser
  on public.byeollog_soop_core_roulette_results for all to anon,authenticated
  using(false) with check(false);

create or replace function byeollog_automation.record_wallpaper_donation_v4(
  p_workspace_id uuid,p_event_id uuid,p_actor_name text,p_amount bigint,
  p_ceremony_image_url text,p_occurred_at timestamptz,p_broadcast_key text,p_release_key text)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_session_id uuid;v_asset jsonb;v_source text;v_inserted integer;
begin
  if p_workspace_id is null or p_event_id is null or p_amount not between 1 and 1000000000
    or char_length(btrim(p_actor_name)) not between 1 and 120 or p_actor_name~'[[:cntrl:]]'
    or p_occurred_at is null or char_length(btrim(p_broadcast_key)) not between 1 and 200
  then raise exception 'wallpaper donation is invalid' using errcode='22023'; end if;
  if p_amount between 1 and 30000 then
    select signature.wallpaper_image into v_asset
    from public.byeollog_signature_balloons signature
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

revoke all on function byeollog_automation.record_wallpaper_donation_v4(uuid,uuid,text,bigint,text,timestamptz,text,text)
  from public,anon,authenticated,service_role;

create or replace function public.ingest_soop_core_donation_v1(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_donation_type_label text,p_ceremony_image_url text,
  p_occurred_at timestamptz,p_broadcast_key text,p_release_key text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare v_id uuid;v_inserted integer;v_wallpaper boolean:=false;v_source_key text;
begin
  if p_workspace_id is null or char_length(btrim(p_event_id)) not between 1 and 180
    or char_length(btrim(p_actor_id)) not between 1 and 180
    or char_length(btrim(p_actor_name)) not between 1 and 120
    or p_amount not between 1 and 1000000000 or p_occurred_at is null
  then raise exception 'core SOOP donation is invalid' using errcode='22023'; end if;
  insert into public.byeollog_soop_core_donations(
    workspace_id,provider_event_id,actor_id,actor_name,amount,donation_type_label,
    occurred_at,broadcast_key)
  values(p_workspace_id,btrim(p_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,
    coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),p_occurred_at,btrim(p_broadcast_key))
  on conflict(workspace_id,provider_event_id) do nothing
  returning id into v_id;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 then
    select donation.id into v_id from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.provider_event_id=btrim(p_event_id);
    return jsonb_build_object('duplicate',true,'status','duplicate','donationId',v_id,'wallpaperRecorded',false);
  end if;
  v_wallpaper:=byeollog_automation.record_wallpaper_donation_v4(
    p_workspace_id,v_id,p_actor_name,p_amount,p_ceremony_image_url,p_occurred_at,
    p_broadcast_key,p_release_key);
  v_source_key:='soop_sdk:'||btrim(p_event_id);
  insert into public.bangsel_donations(
    workspace_id,source_event_key,source,donation_type,donated_date,donated_time,donated_at,
    soop_id,nickname,balloons,message,had_roulette,roulette_count,roulette_results,event_name,raw_payload)
  values(p_workspace_id,v_source_key,'soop_chat_sdk',coalesce(nullif(btrim(p_donation_type_label),''),'별풍선'),
    (p_occurred_at at time zone 'Asia/Seoul')::date,(p_occurred_at at time zone 'Asia/Seoul')::time,
    p_occurred_at,lower(btrim(p_actor_id)),btrim(p_actor_name),p_amount,null,false,0,'[]'::jsonb,null,
    jsonb_build_object('source_provider','soop_chat_sdk','provider_event_id',btrim(p_event_id)))
  on conflict(workspace_id,source_event_key) do nothing;
  return jsonb_build_object('duplicate',false,'status','recorded','donationId',v_id,'wallpaperRecorded',v_wallpaper);
end
$function$;

revoke all on function public.ingest_soop_core_donation_v1(uuid,text,text,text,bigint,text,text,timestamptz,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_core_donation_v1(uuid,text,text,text,bigint,text,text,timestamptz,text,text)
  to service_role;

create or replace function public.ingest_soop_external_roulette_result_v1(
  p_workspace_id uuid,p_chat_event_id text,p_chat_actor_id text,p_chat_actor_name text,
  p_donor_name_hint text,p_roulette_name text,p_result_text text,p_raw_message text,
  p_occurred_at timestamptz,p_broadcast_key text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare
  v_result_id uuid;v_donation public.byeollog_soop_core_donations%rowtype;
  v_candidates integer:=0;v_method text;v_results jsonb;v_count integer;v_event_name text;
begin
  if p_workspace_id is null or char_length(btrim(p_chat_event_id)) not between 1 and 180
    or char_length(btrim(p_chat_actor_id)) not between 1 and 180
    or char_length(btrim(p_chat_actor_name)) not between 1 and 120
    or char_length(btrim(p_result_text)) not between 1 and 120
    or char_length(btrim(p_raw_message)) not between 1 and 300 or p_occurred_at is null
    or char_length(btrim(p_broadcast_key)) not between 1 and 200
  then raise exception 'external roulette result is invalid' using errcode='22023'; end if;
  insert into public.byeollog_soop_core_roulette_results(
    workspace_id,provider_chat_id,chat_actor_id,chat_actor_name,donor_name_hint,
    roulette_name,result_text,raw_message,occurred_at,broadcast_key)
  values(p_workspace_id,btrim(p_chat_event_id),lower(btrim(p_chat_actor_id)),btrim(p_chat_actor_name),
    nullif(btrim(p_donor_name_hint),''),nullif(btrim(p_roulette_name),''),btrim(p_result_text),
    btrim(p_raw_message),p_occurred_at,btrim(p_broadcast_key))
  on conflict(workspace_id,provider_chat_id) do nothing returning id into v_result_id;
  if v_result_id is null then
    return jsonb_build_object('duplicate',true,'matched',false,'status','duplicate');
  end if;

  -- Roulette bots normally post through the streamer account, so the chat
  -- actor is never treated as the donor. Only an explicit donor hint or an
  -- unambiguous single recent donation may establish ownership.
  select count(*)::integer into v_candidates
  from public.byeollog_soop_core_donations donation
  where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
    and donation.status in ('pending','collecting')
    and donation.occurred_at between p_occurred_at-interval '10 minutes' and p_occurred_at+interval '5 seconds'
    and nullif(btrim(p_donor_name_hint),'') is not null
    and lower(donation.actor_name)=lower(btrim(p_donor_name_hint));
  if v_candidates>0 then
    select donation.* into v_donation
    from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
      and donation.status in ('pending','collecting')
      and donation.occurred_at between p_occurred_at-interval '10 minutes' and p_occurred_at+interval '5 seconds'
      and nullif(btrim(p_donor_name_hint),'') is not null
      and lower(donation.actor_name)=lower(btrim(p_donor_name_hint))
    order by donation.occurred_at desc,donation.id
    limit 1;
    v_method:='donor_name';
  else
    -- A multi-spin roulette emits one result chat at a time. Once the first
    -- result has established a donation, keep the short uninterrupted result
    -- sequence on that donation. A newer pending donation breaks the chain so
    -- another viewer's result is never silently stolen.
    select count(*)::integer into v_candidates
    from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
      and donation.status='collecting'
      and donation.last_result_at between p_occurred_at-interval '30 seconds' and p_occurred_at+interval '5 seconds'
      and not exists(
        select 1 from public.byeollog_soop_core_donations newer
        where newer.workspace_id=p_workspace_id and newer.broadcast_key=btrim(p_broadcast_key)
          and newer.status='pending'
          and newer.occurred_at>donation.last_result_at
          and newer.occurred_at<=p_occurred_at+interval '5 seconds');
    if v_candidates=1 then
      select donation.* into v_donation
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status='collecting'
        and donation.last_result_at between p_occurred_at-interval '30 seconds' and p_occurred_at+interval '5 seconds'
        and not exists(
          select 1 from public.byeollog_soop_core_donations newer
          where newer.workspace_id=p_workspace_id and newer.broadcast_key=btrim(p_broadcast_key)
            and newer.status='pending'
            and newer.occurred_at>donation.last_result_at
            and newer.occurred_at<=p_occurred_at+interval '5 seconds')
      limit 1;
      v_method:='sequence_continuation';
    elsif v_candidates=0 then
      select count(*)::integer into v_candidates
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status='pending'
        and donation.occurred_at between p_occurred_at-interval '120 seconds' and p_occurred_at+interval '5 seconds';
      if v_candidates=1 then
        select donation.* into v_donation
        from public.byeollog_soop_core_donations donation
        where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
          and donation.status='pending'
          and donation.occurred_at between p_occurred_at-interval '120 seconds' and p_occurred_at+interval '5 seconds'
        limit 1;
        v_method:='unique_recent';
      end if;
    end if;
  end if;
  if v_donation.id is null then
    update public.byeollog_soop_core_roulette_results result set
      match_state=case when v_candidates>1 then 'ambiguous' else 'unmatched' end
    where result.id=v_result_id;
    return jsonb_build_object('duplicate',false,'matched',false,
      'status',case when v_candidates>1 then 'ambiguous' else 'unmatched' end,'candidateCount',v_candidates);
  end if;

  update public.byeollog_soop_core_roulette_results result set
    donation_id=v_donation.id,match_state='matched',match_method=v_method
  where result.id=v_result_id;
  select jsonb_agg(jsonb_build_object('result',result.result_text,'probability','') order by result.occurred_at,result.id),
    count(*)::integer,
    max(result.roulette_name) filter(where result.roulette_name is not null)
  into v_results,v_count,v_event_name
  from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.donation_id=v_donation.id and result.match_state='matched';
  v_event_name:=coalesce(v_event_name,v_donation.amount::text||'개 룰렛');
  update public.byeollog_soop_core_donations donation set
    result_count=v_count,last_result_at=p_occurred_at,status='collecting',updated_at=clock_timestamp()
  where donation.id=v_donation.id;
  update public.bangsel_donations donation set
    had_roulette=true,roulette_count=v_count,roulette_results=v_results,event_name=v_event_name,
    raw_payload=donation.raw_payload||jsonb_build_object('correlation','soop_chat_sdk','match_method',v_method)
  where donation.workspace_id=p_workspace_id and donation.source_event_key='soop_sdk:'||v_donation.provider_event_id;
  insert into public.bangsel_collector_staging(
    workspace_id,source_uid,session_id,donated_time_text,nickname,soop_id,balloons,roulette,
    collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,
    roulette_results,process_status,source_scope,uploaded_at)
  values(p_workspace_id,'soop_sdk:'||v_donation.provider_event_id,v_donation.broadcast_key,
    to_char(v_donation.occurred_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    v_donation.actor_name,v_donation.actor_id,v_donation.amount,
    (v_results->0->>'result'),'soop-chat-sdk-core-v1',
    jsonb_build_object('type','SENDBALLOON','source_provider','soop_chat_sdk',
      'provider_event_id',v_donation.provider_event_id,'correlation_method',v_method),
    v_event_name,null,v_count,'matched',v_results,'pending','soop',clock_timestamp())
  on conflict(workspace_id,source_uid) do update set
    roulette=excluded.roulette,raw_payload=excluded.raw_payload,event_name=excluded.event_name,
    actual_spins=excluded.actual_spins,validation='matched',roulette_results=excluded.roulette_results,
    process_status='pending',processed_at=null,processing_started_at=null,process_error=null,
    uploaded_at=excluded.uploaded_at;
  return jsonb_build_object('duplicate',false,'matched',true,'status','matched',
    'matchMethod',v_method,'donationId',v_donation.id,'sourceUid','soop_sdk:'||v_donation.provider_event_id,
    'resultCount',v_count);
end
$function$;

revoke all on function public.ingest_soop_external_roulette_result_v1(uuid,text,text,text,text,text,text,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_external_roulette_result_v1(uuid,text,text,text,text,text,text,text,timestamptz,text)
  to service_role;

comment on column public.byeollog_soop_runtime_controls.core_collection_enabled is
  'Authoritative SOOP Chat SDK collection for wallpaper and Upbo; independent of retired native roulette execution.';
comment on table public.byeollog_soop_core_donations is
  'Service-only normalized SOOP donations awaiting zero or more external roulette result messages.';
comment on table public.byeollog_soop_core_roulette_results is
  'Service-only external roulette result observations. Ambiguous results are retained and never guessed.';

-- Correlation rows are an internal short-lived join ledger. Durable donation,
-- wallpaper and Upbo records live in their existing product tables, so keeping
-- this raw join material forever would only increase index and vacuum cost.
create or replace function private.run_soop_core_correlation_retention_v1(p_batch_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path=''
set lock_timeout='200ms'
set statement_timeout='3s'
as $function$
declare v_limit integer;v_results integer:=0;v_donations integer:=0;
begin
  v_limit:=least(greatest(coalesce(p_batch_limit,500),1),2000);
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:soop-core-correlation-retention:v1',0)) then
    return jsonb_build_object('ok',true,'skipped','already_running');
  end if;
  with candidates as (
    select result.id from public.byeollog_soop_core_roulette_results result
    where result.created_at<clock_timestamp()-interval '30 days'
    order by result.created_at,result.id limit v_limit for update skip locked
  ),deleted as (
    delete from public.byeollog_soop_core_roulette_results result using candidates
    where result.id=candidates.id returning 1
  ) select count(*) into v_results from deleted;
  with candidates as (
    select donation.id from public.byeollog_soop_core_donations donation
    where donation.created_at<clock_timestamp()-interval '30 days'
      and not exists(select 1 from public.byeollog_soop_core_roulette_results result where result.donation_id=donation.id)
    order by donation.created_at,donation.id limit v_limit for update skip locked
  ),deleted as (
    delete from public.byeollog_soop_core_donations donation using candidates
    where donation.id=candidates.id returning 1
  ) select count(*) into v_donations from deleted;
  return jsonb_build_object('ok',true,'resultsDeleted',v_results,'donationsDeleted',v_donations);
end
$function$;
revoke all on function private.run_soop_core_correlation_retention_v1(integer)
  from public,anon,authenticated,service_role;
select cron.schedule(
  'byeollog-soop-core-correlation-retention-v1',
  '12,42 * * * *',
  $$select private.run_soop_core_correlation_retention_v1(500)$$
);
