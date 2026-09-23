-- Fixed next-result doubling is decided only after SOOP ownership and FIFO
-- donation attribution. Historical results remain undecorated and are never
-- replayed into the new state machine by this migration.
begin;
set local lock_timeout='3s';

create table public.byeollog_special_roulette_rules (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  result_text text not null check (
    char_length(result_text) between 1 and 120
    and result_text=normalize(btrim(result_text),NFC)
    and result_text !~ '[[:cntrl:]]'
  ),
  allow_stacking boolean not null default false,
  enabled boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,result_text)
);
alter table public.byeollog_special_roulette_rules enable row level security;
create policy byeollog_special_roulette_rules_deny_browser
  on public.byeollog_special_roulette_rules for all to anon,authenticated
  using(false) with check(false);
revoke all on table public.byeollog_special_roulette_rules from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.byeollog_special_roulette_rules to service_role;

create table private.special_roulette_state (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  broadcast_instance_id uuid not null,
  actor_key text not null check(char_length(actor_key) between 1 and 180),
  multiplier integer not null check(multiplier between 2 and 100),
  source_event_key text not null check(char_length(source_event_key) between 1 and 200),
  expires_at timestamptz not null,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,broadcast_instance_id,actor_key)
);
create table private.special_roulette_receipts (
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  source_event_key text not null check(char_length(source_event_key) between 1 and 200),
  broadcast_key text not null check(char_length(broadcast_key) between 1 and 200),
  broadcast_instance_id uuid not null,
  actor_key text check(actor_key is null or char_length(actor_key) between 1 and 180),
  result_text text not null check(char_length(result_text) between 1 and 120),
  control_event boolean not null,
  allow_stacking boolean not null,
  applied_multiplier integer not null check(applied_multiplier between 1 and 100),
  pending_multiplier integer check(pending_multiplier between 2 and 100),
  created_at timestamptz not null default clock_timestamp(),
  primary key(workspace_id,source_event_key),
  check(not control_event or applied_multiplier=1)
);
alter table private.special_roulette_state enable row level security;
alter table private.special_roulette_receipts enable row level security;
revoke all on table private.special_roulette_state,private.special_roulette_receipts
  from public,anon,authenticated,service_role;

alter table public.byeollog_soop_core_roulette_results
  add column special_roulette jsonb;
comment on column public.byeollog_soop_core_roulette_results.special_roulette is
  'Immutable receipt from ownership-attested ingestion; NULL is a historical/unmatched result and must not be retroactively resolved.';

create function private.resolve_special_roulette_result_v1(p_result_id uuid)
returns jsonb
language plpgsql security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_result public.byeollog_soop_core_roulette_results%rowtype;
  v_donation public.byeollog_soop_core_donations%rowtype;
  v_receipt private.special_roulette_receipts%rowtype;
  v_actor text;v_key text;v_instance uuid;v_now timestamptz:=clock_timestamp();
  v_pending integer;v_applied integer:=1;v_control boolean:=false;v_stacking boolean:=false;
begin
  if p_result_id is null then raise exception 'special roulette result is required' using errcode='22023'; end if;
  select result.* into v_result from public.byeollog_soop_core_roulette_results result
  where result.id=p_result_id and result.match_state='matched';
  if v_result.id is null then raise exception 'special roulette result is not matched' using errcode='22023'; end if;
  select donation.* into v_donation from public.byeollog_soop_core_donations donation
  where donation.id=v_result.donation_id and donation.workspace_id=v_result.workspace_id
    and donation.broadcast_key=v_result.broadcast_key;
  if v_donation.id is null or not exists(
    select 1 from public.byeollog_workspaces workspace
    join public.byeollog_soop_event_ownership donation_owner
      on donation_owner.workspace_id=workspace.id
     and donation_owner.event_fingerprint=v_donation.source_event_fingerprint
     and donation_owner.provider_bj_id=v_donation.source_bj_id
     and donation_owner.chat_number=v_donation.source_chat_number
    join public.byeollog_soop_event_ownership result_owner
      on result_owner.workspace_id=workspace.id
     and result_owner.event_fingerprint=v_result.source_event_fingerprint
     and result_owner.provider_bj_id=v_result.source_bj_id
     and result_owner.chat_number=v_result.source_chat_number
    where workspace.id=v_result.workspace_id and workspace.status='active'
      and lower(workspace.soop_id)=v_result.source_bj_id
      and v_donation.source_bj_id=v_result.source_bj_id
      and v_donation.source_chat_number=v_result.source_chat_number
  ) then raise exception 'special roulette donation ownership is invalid'
    using errcode='23514',constraint='special_roulette_donation_owner_mismatch'; end if;

  -- The relay connection key changes on process restart. The donation's
  -- wallpaper session is the server-issued broadcast identity and survives
  -- reconnects; a reused SOOP chat number must never reuse this state.
  select substring(session.source_key from 16)::uuid into v_instance
  from public.byeollog_wallpaper_tiles tile
  join public.byeollog_wallpaper_sessions session
    on session.id=tile.session_id and session.workspace_id=tile.workspace_id
  where tile.workspace_id=v_result.workspace_id and tile.donation_event_id=v_donation.id
    and session.source_key~'^soop-broadcast:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  if v_instance is null then raise exception 'special roulette broadcast identity is unavailable'
    using errcode='23514',constraint='special_roulette_broadcast_missing'; end if;

  v_actor:=lower(nullif(btrim(coalesce(v_donation.actor_id,'')),''));
  v_key:='soop_result:'||v_result.provider_chat_id;
  if char_length(v_key) not between 1 and 200
    or char_length(v_result.broadcast_key) not between 1 and 200
    or char_length(v_result.result_text) not between 1 and 120
    or (v_actor is not null and char_length(v_actor)>180)
  then raise exception 'special roulette identity is invalid' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog:special-roulette:'||v_result.workspace_id::text||':'||v_instance::text||':'||coalesce(v_actor,v_key),4102));
  select receipt.* into v_receipt from private.special_roulette_receipts receipt
  where receipt.workspace_id=v_result.workspace_id and receipt.source_event_key=v_key;
  if found then
    if v_receipt.broadcast_key is distinct from v_result.broadcast_key
      or v_receipt.broadcast_instance_id is distinct from v_instance
      or v_receipt.actor_key is distinct from v_actor
      or v_receipt.result_text is distinct from v_result.result_text
    then raise exception 'special roulette receipt identity conflicts' using errcode='23514'; end if;
  else
    if not exists(select 1 from public.byeollog_soop_gateway_sessions gateway
      where gateway.workspace_id=v_result.workspace_id and gateway.broadcast_instance_id=v_instance
        and gateway.last_live_chat_number=v_result.source_chat_number
        and (gateway.broadcast_offline_since is null or gateway.broadcast_offline_since>v_now-interval '20 minutes'))
    then raise exception 'special roulette broadcast identity is stale'
      using errcode='23514',constraint='special_roulette_broadcast_mismatch'; end if;
    select true,rule.allow_stacking into v_control,v_stacking
    from public.byeollog_special_roulette_rules rule
    where rule.workspace_id=v_result.workspace_id
      and rule.result_text=normalize(btrim(v_result.result_text),NFC) and rule.enabled;
    v_control:=coalesce(v_control,false);v_stacking:=coalesce(v_stacking,false);
    -- A missing donor identifier cannot create or consume another donor's state.
    if v_actor is not null then
      delete from private.special_roulette_state state
      where state.workspace_id=v_result.workspace_id and state.broadcast_instance_id=v_instance
        and state.actor_key=v_actor and state.expires_at<=v_now;
      select state.multiplier into v_pending from private.special_roulette_state state
      where state.workspace_id=v_result.workspace_id and state.broadcast_instance_id=v_instance
        and state.actor_key=v_actor for update;
      if v_control then
        v_pending:=case when v_stacking then least(100,coalesce(v_pending,1)*2) else 2 end;
        insert into private.special_roulette_state(workspace_id,broadcast_instance_id,actor_key,multiplier,source_event_key,expires_at,updated_at)
        values(v_result.workspace_id,v_instance,v_actor,v_pending,v_key,v_now+interval '12 hours',v_now)
        on conflict(workspace_id,broadcast_instance_id,actor_key) do update set
          multiplier=excluded.multiplier,source_event_key=excluded.source_event_key,
          expires_at=excluded.expires_at,updated_at=excluded.updated_at;
      else
        v_applied:=coalesce(v_pending,1);v_pending:=null;
        delete from private.special_roulette_state state
        where state.workspace_id=v_result.workspace_id and state.broadcast_instance_id=v_instance and state.actor_key=v_actor;
      end if;
    end if;
    insert into private.special_roulette_receipts(workspace_id,source_event_key,broadcast_key,broadcast_instance_id,actor_key,result_text,
      control_event,allow_stacking,applied_multiplier,pending_multiplier)
    values(v_result.workspace_id,v_key,v_result.broadcast_key,v_instance,v_actor,v_result.result_text,
      v_control,v_stacking,v_applied,v_pending) returning * into v_receipt;
  end if;
  return jsonb_build_object('version',1,'sourceEventKey',v_receipt.source_event_key,
    'appliedMultiplier',v_receipt.applied_multiplier,'controlEvent',v_receipt.control_event,
    'pendingMultiplier',v_receipt.pending_multiplier);
end
$function$;
revoke all on function private.resolve_special_roulette_result_v1(uuid) from public,anon,authenticated,service_role;

create or replace function public.ingest_soop_external_roulette_result_v3(
  p_workspace_id uuid,p_chat_event_id text,p_chat_actor_id text,p_chat_actor_name text,
  p_donor_name_hint text,p_roulette_name text,p_result_text text,p_raw_message text,
  p_occurred_at timestamptz,p_broadcast_key text,p_provider_bj_id text,
  p_source_chat_number bigint,p_event_fingerprint text)
returns jsonb
language plpgsql security definer
set search_path=''
set statement_timeout='8s'
as $function$
declare
  v_result jsonb;v_updated integer;v_row public.byeollog_soop_core_roulette_results%rowtype;
  v_decision jsonb;v_results jsonb;v_source_uid text;
begin
  if p_workspace_id is null or p_provider_bj_id is null
    or char_length(btrim(p_provider_bj_id)) not between 1 and 180
    or lower(btrim(p_provider_bj_id))!~'^[a-z0-9_.-]+$'
    or p_source_chat_number is null or p_source_chat_number<=0
    or p_event_fingerprint is null or p_event_fingerprint!~'^[0-9a-f]{64}$'
  then raise exception 'SOOP roulette ownership is invalid' using errcode='22023'; end if;
  if not exists(
    select 1 from public.byeollog_workspaces workspace
    join public.byeollog_soop_event_ownership owner
      on owner.workspace_id=workspace.id and owner.event_fingerprint=p_event_fingerprint
     and owner.provider_bj_id=lower(btrim(p_provider_bj_id)) and owner.chat_number=p_source_chat_number
    where workspace.id=p_workspace_id and workspace.status='active'
      and lower(workspace.soop_id)=lower(btrim(p_provider_bj_id)))
  then raise exception 'SOOP roulette ownership is invalid' using errcode='23514',constraint='roulette_owner_mismatch'; end if;

  -- v2 holds the workspace+broadcast FIFO lock until this whole transaction ends.
  v_result:=public.ingest_soop_external_roulette_result_v2(
    p_workspace_id,p_chat_event_id,p_chat_actor_id,p_chat_actor_name,p_donor_name_hint,
    p_roulette_name,p_result_text,p_raw_message,p_occurred_at,p_broadcast_key);
  update public.byeollog_soop_core_roulette_results result set
    source_bj_id=lower(btrim(p_provider_bj_id)),source_chat_number=p_source_chat_number,
    source_event_fingerprint=p_event_fingerprint
  where result.workspace_id=p_workspace_id and result.provider_chat_id=btrim(p_chat_event_id)
    and ((result.source_bj_id is null and result.source_chat_number is null and result.source_event_fingerprint is null)
      or (result.source_bj_id=lower(btrim(p_provider_bj_id))
        and result.source_chat_number=p_source_chat_number and result.source_event_fingerprint=p_event_fingerprint));
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'SOOP roulette result provenance conflicts with stored row'
    using errcode='23514',constraint='roulette_result_owner_mismatch'; end if;
  select result.* into v_row from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.provider_chat_id=btrim(p_chat_event_id);
  if v_row.broadcast_key is distinct from btrim(p_broadcast_key)
    or v_row.result_text is distinct from btrim(p_result_text)
  then raise exception 'SOOP roulette result identity conflicts with stored row' using errcode='23514'; end if;

  -- A retry of an old row never consumes current pending state or current rules.
  if coalesce((v_result->>'duplicate')::boolean,false) or v_row.match_state<>'matched' then
    return v_result;
  end if;
  -- Installing the additive schema must not change the old server's ledger
  -- identities before promotion. An unconfigured workspace stays on its old
  -- result format. Once used, receipts keep the new identities stable even
  -- after every rule and pending multiplier has been removed.
  if not exists(select 1 from public.byeollog_special_roulette_rules rule
      where rule.workspace_id=p_workspace_id and rule.enabled)
    and not exists(select 1 from private.special_roulette_receipts receipt
      where receipt.workspace_id=p_workspace_id)
    and not exists(select 1 from private.special_roulette_state state
      where state.workspace_id=p_workspace_id)
  then return v_result; end if;
  v_decision:=private.resolve_special_roulette_result_v1(v_row.id);
  update public.byeollog_soop_core_roulette_results set special_roulette=v_decision where id=v_row.id;
  select jsonb_agg(jsonb_build_object('result',result.result_text,'probability','')||
      case when result.special_roulette is null then '{}'::jsonb
        else jsonb_build_object('special_roulette',result.special_roulette) end
      order by result.occurred_at,result.id)
  into v_results from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.donation_id=v_row.donation_id and result.match_state='matched';
  select 'soop_sdk:'||donation.provider_event_id into v_source_uid
  from public.byeollog_soop_core_donations donation
  where donation.id=v_row.donation_id and donation.workspace_id=p_workspace_id;
  update public.bangsel_collector_staging set roulette_results=v_results
  where workspace_id=p_workspace_id and source_uid=v_source_uid;
  update public.bangsel_donations set roulette_results=v_results
  where workspace_id=p_workspace_id and source_event_key=v_source_uid;
  return v_result;
end
$function$;
revoke all on function public.ingest_soop_external_roulette_result_v3(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_soop_external_roulette_result_v3(
  uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text) to service_role;

-- SPECIAL_ROULETTE_BACKUP_START

create or replace function public.byeollog_export_backup_v8(p_workspace_id uuid)
returns jsonb
language plpgsql security invoker
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '30s'
as $function$
declare
  result jsonb;
begin
  if p_workspace_id is null then
    raise exception 'workspace is required' using errcode='22023';
  end if;
  if not exists(
    select 1 from public.byeollog_workspaces w
    where w.id=p_workspace_id and w.status='active'
  ) then
    raise exception 'workspace is not active' using errcode='55000';
  end if;

  select jsonb_build_object(
    'bangsel_fans',coalesce((select jsonb_agg(to_jsonb(r) order by r.soop_id) from public.bangsel_fans r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_fan_stations',coalesce((select jsonb_agg(to_jsonb(r) order by r.fan) from public.bangsel_fan_stations r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_roulette_rules',coalesce((select jsonb_agg(to_jsonb(r) order by r.result_text) from public.bangsel_roulette_rules r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_tasks',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.bangsel_tasks r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_donations',coalesce((select jsonb_agg(to_jsonb(r) order by r.source_event_key) from public.bangsel_donations r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_task_import_items',coalesce((select jsonb_agg(to_jsonb(r) order by r.source_event_key) from public.bangsel_task_import_items r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_collector_staging',coalesce((select jsonb_agg(to_jsonb(r) order by r.source_scope,r.source_uid) from public.bangsel_collector_staging r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'bangsel_roulette_invalidations',coalesce((select jsonb_agg(to_jsonb(r) order by r.source_uid) from public.bangsel_roulette_invalidations r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_workspace_settings',coalesce((select jsonb_agg(to_jsonb(r) order by r.workspace_id) from public.byeollog_workspace_settings r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_signature_balloons',coalesce((select jsonb_agg(to_jsonb(r) order by r.balloon_count) from public.byeollog_signature_balloons r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_default_donation_images',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.byeollog_default_donation_images r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_fixed_upbo_rules',coalesce((select jsonb_agg(to_jsonb(r) order by r.balloons,r.event_name,r.upbo_type) from public.byeollog_fixed_upbo_rules r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_roulette_classification_rules',coalesce((select jsonb_agg(to_jsonb(r) order by r.roulette_name,r.result_text) from public.byeollog_roulette_classification_rules r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_roulette_amount_mappings',coalesce((select jsonb_agg(to_jsonb(r) order by r.balloons) from public.byeollog_roulette_amount_mappings r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_wallpaper_sessions',coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at,r.id) from public.byeollog_wallpaper_sessions r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_wallpaper_tiles',coalesce((select jsonb_agg(to_jsonb(r) order by r.session_id,r.sequence_no,r.id) from public.byeollog_wallpaper_tiles r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_wallpaper_user_settings',coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id) from public.byeollog_wallpaper_user_settings r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_wallpaper_overlay_states',coalesce((select jsonb_agg(to_jsonb(r) order by r.workspace_id) from public.byeollog_wallpaper_overlay_states r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_special_roulette_rules',coalesce((select jsonb_agg(to_jsonb(r) order by r.result_text) from public.byeollog_special_roulette_rules r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_credit_ledger',coalesce((select jsonb_agg(to_jsonb(r) order by r.source_key) from public.byeollog_credit_ledger r where r.workspace_id=p_workspace_id),'[]'::jsonb)
  ) into result;

  if pg_column_size(result)>67108864 then
    raise exception 'backup snapshot exceeds the safe size limit' using errcode='54000';
  end if;
  return result;
end
$function$;

create or replace function public.byeollog_restore_backup_v2(
  p_workspace_id uuid, p_lease_id uuid, p_tables jsonb
) returns jsonb
language plpgsql security invoker
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '30s'
as $function$
declare
  cfg record;
  rows_json jsonb;
  cols text;
  updates text;
  affected bigint;
  counts jsonb := '{}'::jsonb;
  allowed constant text[] := array[
    'bangsel_fans','bangsel_fan_stations','bangsel_roulette_rules','bangsel_tasks',
    'bangsel_donations','bangsel_task_import_items','bangsel_collector_staging',
    'bangsel_roulette_invalidations','byeollog_workspace_settings',
    'byeollog_signature_balloons','byeollog_default_donation_images',
    'byeollog_fixed_upbo_rules','byeollog_roulette_classification_rules',
    'byeollog_roulette_amount_mappings','byeollog_wallpaper_sessions',
    'byeollog_wallpaper_tiles','byeollog_wallpaper_user_settings',
    'byeollog_wallpaper_overlay_states','byeollog_credit_ledger','byeollog_special_roulette_rules'
  ];
begin
  if p_workspace_id is null or p_lease_id is null or p_tables is null
    or jsonb_typeof(p_tables)<>'object' or pg_column_size(p_tables)>67108864 then
    raise exception 'invalid backup restore payload' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_tables) k where not (k=any(allowed))) then
    raise exception 'unsupported backup table' using errcode='22023';
  end if;

  perform 1 from public.byeollog_workspace_backup_leases l
  where l.workspace_id=p_workspace_id and l.lease_id=p_lease_id
    and l.reason='pre_restore' and l.expires_at>clock_timestamp()
  for update;
  if not found then
    raise exception 'restore lease is missing or expired' using errcode='55000';
  end if;
  if not exists(
    select 1 from public.byeollog_workspaces w
    where w.id=p_workspace_id and w.status='active'
  ) then
    raise exception 'workspace is not active' using errcode='55000';
  end if;

  for cfg in select * from (values
    (1,'bangsel_fans','workspace_id,soop_id',false),
    (2,'bangsel_fan_stations','workspace_id,fan',false),
    (3,'bangsel_roulette_rules','workspace_id,result_text',false),
    (4,'bangsel_tasks','id',false),
    (5,'bangsel_donations','workspace_id,source_event_key',false),
    (6,'bangsel_task_import_items','workspace_id,source_event_key',false),
    (7,'bangsel_collector_staging','workspace_id,source_scope,source_uid',false),
    (8,'bangsel_roulette_invalidations','workspace_id,source_uid',false),
    (9,'byeollog_workspace_settings','workspace_id',false),
    (10,'byeollog_signature_balloons','workspace_id,balloon_count',false),
    (11,'byeollog_default_donation_images','workspace_id,id',false),
    (12,'byeollog_fixed_upbo_rules','workspace_id,balloons,event_name,upbo_type',false),
    (13,'byeollog_roulette_classification_rules','workspace_id,roulette_name,result_text',false),
    (14,'byeollog_roulette_amount_mappings','workspace_id,balloons',false),
    (15,'byeollog_wallpaper_sessions','id',false),
    (16,'byeollog_wallpaper_tiles','id',true),
    (17,'byeollog_wallpaper_user_settings','workspace_id,user_id',false),
    (18,'byeollog_wallpaper_overlay_states','workspace_id',false),
    (19,'byeollog_credit_ledger','source_key',false),
    (20,'byeollog_special_roulette_rules','workspace_id,result_text',false)
  ) as t(position,name,conflict_columns,override_identity) order by position loop
    rows_json:=coalesce(p_tables->cfg.name,'[]'::jsonb);
    if jsonb_typeof(rows_json)<>'array' or jsonb_array_length(rows_json)>100000 then
      raise exception 'invalid backup rows for %',cfg.name using errcode='22023';
    end if;
    if exists(
      select 1 from jsonb_array_elements(rows_json) r
      where jsonb_typeof(r)<>'object'
        or (r->>'workspace_id') is distinct from p_workspace_id::text
    ) then
      raise exception 'backup workspace mismatch' using errcode='42501';
    end if;
    if jsonb_array_length(rows_json)=0 then
      counts:=counts||jsonb_build_object(cfg.name,0);
      continue;
    end if;

    if exists(
      select 1
      from jsonb_array_elements(rows_json) r
      cross join lateral jsonb_object_keys(r) k
      where not exists(
        select 1 from pg_catalog.pg_attribute a
        where a.attrelid=pg_catalog.to_regclass('public.'||cfg.name)
          and a.attname=k and a.attnum>0 and not a.attisdropped
          and a.attgenerated=''
      )
    ) then
      raise exception 'unknown backup column for %',cfg.name using errcode='22023';
    end if;

    select string_agg(format('%I',k),',' order by k),
      string_agg(format('%I=excluded.%I',k,k),',' order by k)
        filter(where k<>'workspace_id' and k<>'id' and not exists(
          select 1 from pg_catalog.pg_attribute a
          where a.attrelid=pg_catalog.to_regclass('public.'||cfg.name)
            and a.attname=k and a.attnum>0 and not a.attisdropped
            and a.attidentity<>''
        ))
    into cols,updates
    from (
      select distinct k
      from jsonb_array_elements(rows_json) r
      cross join lateral jsonb_object_keys(r) k
    ) keys;

    if cfg.name='bangsel_task_import_items' and exists(
      select 1 from jsonb_array_elements(rows_json) r where not exists(
        select 1 from public.bangsel_tasks t
        where t.id=(r->>'task_id')::uuid and t.workspace_id=p_workspace_id
      )
    ) then
      raise exception 'backup task reference is not owned by workspace' using errcode='42501';
    end if;
    if cfg.name='bangsel_roulette_invalidations' and exists(
      select 1 from jsonb_array_elements(rows_json) r where not exists(
        select 1 from public.bangsel_collector_staging s
        where s.workspace_id=p_workspace_id and s.source_uid=r->>'source_uid'
      )
    ) then
      raise exception 'backup invalidation reference is not owned by workspace' using errcode='42501';
    end if;
    if cfg.name='byeollog_wallpaper_tiles' and exists(
      select 1 from jsonb_array_elements(rows_json) r where not exists(
        select 1 from public.byeollog_wallpaper_sessions s
        where s.id=(r->>'session_id')::uuid and s.workspace_id=p_workspace_id
      )
    ) then
      raise exception 'backup wallpaper session reference is not owned by workspace' using errcode='42501';
    end if;

    execute format(
      'insert into public.%I as target (%s) %s select %s from jsonb_populate_recordset(null::public.%I,$1)
       on conflict (%s) do update set %s where target.workspace_id=$2',
      cfg.name,cols,
      case when cfg.override_identity then 'overriding system value' else '' end,
      cols,cfg.name,cfg.conflict_columns,coalesce(updates,'workspace_id=excluded.workspace_id')
    ) using rows_json,p_workspace_id;
    get diagnostics affected=row_count;
    if affected<>jsonb_array_length(rows_json) then
      raise exception 'backup row ownership conflict' using errcode='42501';
    end if;
    counts:=counts||jsonb_build_object(cfg.name,affected);
  end loop;
  return counts;
end
$function$;

revoke all on function public.byeollog_export_backup_v8(uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.byeollog_restore_backup_v2(uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.byeollog_export_backup_v8(uuid) to service_role;
grant execute on function public.byeollog_restore_backup_v2(uuid,uuid,jsonb) to service_role;

notify pgrst,'reload schema';

commit;

