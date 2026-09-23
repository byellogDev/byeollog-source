-- Additive UX controls. Does not replay historical donations or change FIFO attribution.
set lock_timeout='2s';
set statement_timeout='20s';

create table public.byeollog_signup_consents (
  workspace_id uuid primary key references public.byeollog_workspaces(id) on delete cascade,
  user_id uuid not null,
  terms_version text not null,
  privacy_version text not null,
  collection_agreed boolean not null check(collection_agreed),
  age_14_confirmed boolean not null check(age_14_confirmed),
  agreed_at timestamptz not null default clock_timestamp()
);
alter table public.byeollog_signup_consents enable row level security;
revoke all on public.byeollog_signup_consents from public,anon,authenticated;
grant select,insert,delete on public.byeollog_signup_consents to service_role;

create or replace function public.byeollog_complete_oauth_signup_v2(
  p_auth_user_id uuid,p_email text,p_streamer_name text,p_pending_token_hash text,
  p_consents jsonb,p_referrer_workspace_slug text default null,p_note text default '')
returns table(application_id uuid,workspace_id uuid,workspace_slug text,soop_id text)
language plpgsql security invoker set search_path='' set statement_timeout='10s'
as $$
declare v record;
begin
  if p_consents is null or p_consents->>'termsVersion' is distinct from '2026-09-06'
    or p_consents->>'privacyVersion' is distinct from '2026-09-09'
    or p_consents->'termsAgreed' is distinct from 'true'::jsonb
    or p_consents->'collectionAgreed' is distinct from 'true'::jsonb
    or p_consents->'age14Confirmed' is distinct from 'true'::jsonb then
    raise exception 'current signup consent required' using errcode='22023';
  end if;
  select * into strict v from public.byeollog_complete_oauth_signup_v1(
    p_auth_user_id,p_email,p_streamer_name,p_pending_token_hash,p_referrer_workspace_slug,p_note);
  insert into public.byeollog_signup_consents(workspace_id,user_id,terms_version,privacy_version,collection_agreed,age_14_confirmed)
    values(v.workspace_id,p_auth_user_id,'2026-09-06','2026-09-09',true,true);
  return query select v.application_id,v.workspace_id,v.workspace_slug,v.soop_id;
end $$;
revoke all on function public.byeollog_complete_oauth_signup_v2(uuid,text,text,text,jsonb,text,text) from public,anon,authenticated;
grant execute on function public.byeollog_complete_oauth_signup_v2(uuid,text,text,text,jsonb,text,text) to service_role;

-- Internal result includes a grouping identity. The web API MUST map it to an HMAC
-- and return only the explicit public field allowlist. Never grant this RPC to browsers.
create or replace function public.byeollog_public_upbo_page_v1(
  p_workspace_slug text,p_search text default null,p_page integer default 0,p_sort text default 'name')
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='5s'
as $$
declare v jsonb;
begin
  if p_page is null or p_page not between 0 and 2000 or p_sort not in ('name','remaining','newest')
    or char_length(coalesce(p_search,''))>100 then raise exception 'invalid public page' using errcode='22023';end if;
  with ws as (
    select id from public.byeollog_workspaces where slug=lower(btrim(p_workspace_slug))
      and status='active' and coalesce(public_page_enabled,true) limit 1
  ), base as (
    select t.id,t.fan,t.event,t.type,t.created_at,greatest(t.total_qty-t.done_qty,0) as remaining,
      coalesce(nullif(lower(btrim(t.fan_soop_id)),''),'legacy:'||coalesce(t.fan,'')) as identity,
      split_part(replace(replace(coalesce(t.public_comment,''),E'\r\n',E'\n'),E'\r',E'\n'),E'\n',1) as comment
    from public.bangsel_tasks t join ws on ws.id=t.workspace_id
    where t.total_qty>t.done_qty and (
      nullif(btrim(p_search),'') is null
      or position(lower(p_search) in lower(coalesce(t.fan,'')))>0
      or position(lower(p_search) in lower(coalesce(t.fan_soop_id,'')))>0
      or exists(select 1 from public.bangsel_fans f where f.workspace_id=t.workspace_id and f.soop_id=t.fan_soop_id
        and (position(lower(p_search) in lower(coalesce(f.alias,'')))>0
          or position(lower(p_search) in lower(coalesce(f.current_nickname,'')))>0))
    )
  ), ranked as (
    select b.*,sum(remaining) over(partition by identity) as fan_remaining,
      row_number() over(order by case when p_sort='remaining' then remaining end desc nulls last,
        case when p_sort='newest' then created_at end desc nulls last,fan,identity,event,type,created_at,id) as ordinal
    from base b
  ), page as (select * from ranked where ordinal>p_page*50 and ordinal<=p_page*50+51)
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(p)-'ordinal' order by ordinal) from page p where ordinal<=p_page*50+50),'[]'::jsonb),
    'hasMore',exists(select 1 from page where ordinal>p_page*50+50),'totalRows',(select count(*) from base),'page',p_page) into v;
  return v;
end $$;
revoke all on function public.byeollog_public_upbo_page_v1(text,text,integer,text) from public,anon,authenticated;
grant execute on function public.byeollog_public_upbo_page_v1(text,text,integer,text) to service_role;

create table public.byeollog_roulette_exception_reviews (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  result_id uuid not null references public.byeollog_soop_core_roulette_results(id) on delete cascade,
  user_id uuid not null,action text not null,previous_status text not null,previous_details jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
create index byeollog_exception_reviews_result_idx on public.byeollog_roulette_exception_reviews(workspace_id,result_id,created_at desc);
alter table public.byeollog_roulette_exception_reviews enable row level security;
revoke all on public.byeollog_roulette_exception_reviews from public,anon,authenticated;
grant select,insert,delete on public.byeollog_roulette_exception_reviews to service_role;
grant usage on sequence public.byeollog_roulette_exception_reviews_id_seq to service_role;

create or replace function public.resolve_soop_roulette_exception_v2(
  p_workspace_id uuid,p_authorized_user_id uuid,p_result_id uuid,p_decision jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='8s'
as $$
declare v public.byeollog_soop_core_roulette_results%rowtype; t public.bangsel_tasks%rowtype;
  quantity integer; tracked integer; other_tracked integer; result jsonb; action text:=p_decision->>'action';
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_authorized_user_id and w.status='active'
      and lower(m.role::text) in ('owner','editor','manager')) then
    raise exception 'exception authorization failed' using errcode='42501';
  end if;
  select * into v from public.byeollog_soop_core_roulette_results where workspace_id=p_workspace_id and id=p_result_id for update;
  if not found or v.match_state='matched' or v.donation_id is not null then raise exception 'exception not found' using errcode='PT404';end if;
  if action='undo' then
    if v.review_status='pending' then return jsonb_build_object('status','pending','duplicate',true);end if;
    if v.review_status not in ('excluded','registered') then raise exception 'automatic exclusion cannot be undone' using errcode='PT409';end if;
    if v.review_status='registered' then
      quantity:=(v.review_details->'decision'->>'quantity')::integer;
      if quantity is null or quantity<1 then raise exception 'missing registration receipt' using errcode='PT409';end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array(p_workspace_id,
        v.review_details->'decision'->>'soopId',v.review_details->'decision'->>'event',v.review_details->'decision'->>'type')::text,1701));
      select * into t from public.bangsel_tasks where workspace_id=p_workspace_id and id=(v.review_details->'receipt'->>'taskId')::uuid for update;
      if not found or t.done_qty<>0 or t.total_qty<quantity
        or t.fan_soop_id is distinct from v.review_details->'decision'->>'soopId'
        or t.event is distinct from v.review_details->'decision'->>'event'
        or t.type is distinct from v.review_details->'decision'->>'type' then raise exception 'upbo changed since registration' using errcode='PT409';end if;
      select count(*) into tracked from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id
        and i.task_id=t.id and i.source_event_key like 'soop-exception:'||p_result_id::text||':%';
      select count(*) into other_tracked from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id
        and i.task_id=t.id and i.source_event_key not like 'soop-exception:'||p_result_id::text||':%';
      if tracked<>quantity or t.total_qty<tracked+other_tracked or (t.total_qty=quantity and other_tracked<>0) then raise exception 'upbo ledger changed' using errcode='PT409';end if;
      delete from public.bangsel_task_import_items where workspace_id=p_workspace_id and task_id=t.id
        and source_event_key like 'soop-exception:'||p_result_id::text||':%';
      if t.total_qty=quantity then delete from public.bangsel_tasks where workspace_id=p_workspace_id and id=t.id;
      else update public.bangsel_tasks set total_qty=total_qty-quantity where workspace_id=p_workspace_id and id=t.id;end if;
    end if;
    update public.byeollog_soop_core_roulette_results set review_status='pending',reviewed_at=null,reviewed_by=null,review_details=case when v.review_details ? 'fifoHead' then jsonb_build_object('fifoHead',v.review_details->'fifoHead') else '{}'::jsonb end
      where workspace_id=p_workspace_id and id=p_result_id;
    result:=jsonb_build_object('status','pending','duplicate',false);
  else
    if action='registered' and p_decision->'createFan'='true'::jsonb and v.review_status='pending' then
      if coalesce(p_decision->>'soopId','')!~'^[a-z0-9_.-]{2,80}$'
        or char_length(btrim(coalesce(p_decision->>'fanName',''))) not between 1 and 120
        or p_decision->>'fanName' ~ '[[:cntrl:]]' then raise exception 'invalid new fan' using errcode='22023';end if;
      insert into public.bangsel_fans(workspace_id,soop_id,alias,current_nickname)
        values(p_workspace_id,p_decision->>'soopId',btrim(p_decision->>'fanName'),btrim(p_decision->>'fanName'))
        on conflict(workspace_id,soop_id) do nothing;
    end if;
    result:=public.resolve_soop_roulette_exception_v1(p_workspace_id,p_authorized_user_id,p_result_id,p_decision);
    if v.review_details ? 'fifoHead' then
      update public.byeollog_soop_core_roulette_results set review_details=review_details||jsonb_build_object('fifoHead',v.review_details->'fifoHead') where workspace_id=p_workspace_id and id=p_result_id;
    end if;
  end if;
  if coalesce((result->>'duplicate')::boolean,false)=false then
    insert into public.byeollog_roulette_exception_reviews(workspace_id,result_id,user_id,action,previous_status,previous_details)
      values(p_workspace_id,p_result_id,p_authorized_user_id,action,v.review_status,coalesce(v.review_details,'{}'::jsonb));
  end if;
  return result;
end $$;
revoke all on function public.resolve_soop_roulette_exception_v2(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_soop_roulette_exception_v2(uuid,uuid,uuid,jsonb) to service_role;

-- The sole private-state reader exposes only this workspace's UX status.
create or replace function public.byeollog_ux_roulette_status_v1(p_workspace_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s'
as $$
declare v jsonb;
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active') then
    raise exception 'workspace authorization failed' using errcode='42501';end if;
  with pending as (select id,actor_name,amount,roulette_name,occurred_at,result_count,expected_spins,broadcast_key,updated_at
    from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and status in ('pending','collecting')
      and expected_spins is not null and result_count<expected_spins)
  select jsonb_build_object('checkedAt',clock_timestamp(),'pendingCount',(select count(*) from pending),
    'pending',coalesce((select jsonb_agg(to_jsonb(p) order by occurred_at,id) from (select * from pending order by occurred_at,id limit 50)p),'[]'::jsonb),
    'byAmount',coalesce((select jsonb_agg(to_jsonb(g)) from (select amount,count(*) as count from pending group by amount)g),'[]'::jsonb),
    'specialPending',coalesce((select jsonb_agg(to_jsonb(s)) from (
      select state.actor_key as soop_id,coalesce(nullif(f.alias,''),nullif(f.current_nickname,''),state.actor_key) as fan,
        state.multiplier,state.expires_at,state.updated_at from private.special_roulette_state state
        join public.byeollog_soop_gateway_sessions gateway on gateway.workspace_id=state.workspace_id and gateway.broadcast_instance_id=state.broadcast_instance_id
        left join public.bangsel_fans f on f.workspace_id=state.workspace_id and f.soop_id=state.actor_key
        where state.workspace_id=p_workspace_id and state.expires_at>clock_timestamp() order by state.updated_at desc limit 100)s),'[]'::jsonb),
    'specialRecent',coalesce((select jsonb_agg(to_jsonb(r)) from (
      select result.result_text,result.occurred_at,result.special_roulette,d.actor_name
      from public.byeollog_soop_core_roulette_results result left join public.byeollog_soop_core_donations d on d.id=result.donation_id and d.workspace_id=result.workspace_id
      where result.workspace_id=p_workspace_id and result.special_roulette is not null
      order by result.occurred_at desc,result.id desc limit 50)r),'[]'::jsonb)) into v;
  return v;
end $$;
revoke all on function public.byeollog_ux_roulette_status_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.byeollog_ux_roulette_status_v1(uuid,uuid) to service_role;

alter table public.byeollog_soop_core_donations add column user_closed_at timestamptz,add column user_closed_by uuid;
create or replace function public.byeollog_close_stale_donation_v1(p_workspace_id uuid,p_user_id uuid,p_id uuid,p_expected_updated_at timestamptz)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='5s'
as $$
declare d public.byeollog_soop_core_donations%rowtype;
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active' and lower(m.role::text) in ('owner','editor','manager')) then
    raise exception 'workspace authorization failed' using errcode='42501';end if;
  select * into d from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and id=p_id;
  if not found then raise exception 'donation not found' using errcode='PT404';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:soop-roulette-fifo-v2:'||p_workspace_id::text||':'||d.broadcast_key,0));
  select * into d from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and id=p_id for update;
  if not found then raise exception 'donation not found' using errcode='PT404';end if;
  if d.user_closed_at is not null then return jsonb_build_object('ok',true,'duplicate',true);end if;
  if d.status not in ('pending','collecting') or d.expected_spins is null or d.result_count>=d.expected_spins
    or d.occurred_at>clock_timestamp()-interval '10 minutes' or d.updated_at is distinct from p_expected_updated_at then
    raise exception 'donation changed or not stale' using errcode='PT409';end if;
  update public.byeollog_soop_core_donations set status='expired',user_closed_at=clock_timestamp(),user_closed_by=p_user_id,updated_at=clock_timestamp()
    where workspace_id=p_workspace_id and id=p_id;
  return jsonb_build_object('ok',true,'duplicate',false);
end $$;
revoke all on function public.byeollog_close_stale_donation_v1(uuid,uuid,uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.byeollog_close_stale_donation_v1(uuid,uuid,uuid,timestamptz) to service_role;

create or replace function public.byeollog_ux_history_v1(p_workspace_id uuid,p_from timestamptz,p_until timestamptz,
  p_before_at timestamptz default null,p_before_key text default null,p_search text default '')
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='5s'
as $$
declare result jsonb;
begin
  if p_from is null or p_until is null or p_until<=p_from or p_until-p_from>interval '366 days'
    or char_length(coalesce(p_search,''))>100 or (p_before_at is null)<>(p_before_key is null) then
    raise exception 'invalid history range' using errcode='22023';end if;
  with stage as (
    select s.uploaded_at as received_at,
      case when s.source_scope='soop' or s.raw_payload->>'source_provider'='soop_chat_sdk' or s.source_uid like 'soop_sdk:%'
        then case when s.source_uid like 'soop_sdk:%' then s.source_uid else 'soop_sdk:'||s.source_uid end
        else case when s.source_uid like 'weflab:%' then s.source_uid else 'weflab:'||s.source_uid end end as key,
      jsonb_build_object('source_uid',s.source_uid,'source_scope',s.source_scope,'history_origin','staging',
        'nickname',to_jsonb(s)->'nickname','soop_id',to_jsonb(s)->'soop_id','balloons',to_jsonb(s)->'balloons',
        'event_name',to_jsonb(s)->'event_name','roulette_results',to_jsonb(s)->'roulette_results','roulette',to_jsonb(s)->'roulette',
        'validation',to_jsonb(s)->'validation','process_status',s.process_status,'donated_time_text',to_jsonb(s)->'donated_time_text',
        'uploaded_at',s.uploaded_at,'donation_type',to_jsonb(s)->'donation_type',
        'raw_payload',jsonb_build_object('source_provider',s.raw_payload->'source_provider','type',s.raw_payload->'type',
          'subtype',s.raw_payload->'subtype','collector_event_kind',coalesce(s.raw_payload->'collector_event_kind',s.raw_payload->'collectorEventKind'),
          'subscription_months',coalesce(s.raw_payload->'subscription_months',s.raw_payload->'subscriptionMonths'),
          'value',s.raw_payload->'value','img',coalesce(s.raw_payload->'img',s.raw_payload->'image',s.raw_payload->'image_url',s.raw_payload->'imageUrl'))) as payload
    from public.bangsel_collector_staging s where s.workspace_id=p_workspace_id
      and s.uploaded_at>=p_from and s.uploaded_at<p_until
  ), original as (
    select coalesce(d.imported_at,d.donated_at) as received_at,d.source_event_key as key,
      jsonb_build_object('source_uid',d.source_event_key,'history_origin','donation','process_status','received',
        'nickname',d.nickname,'soop_id',d.soop_id,'balloons',d.balloons,'event_name',d.event_name,
        'roulette_results',d.roulette_results,'donation_type',d.donation_type,'donated_at',d.donated_at,
        'donated_date',d.donated_date,'donated_time',d.donated_time,'uploaded_at',d.imported_at,'raw_payload','{}'::jsonb) as payload
    from public.bangsel_donations d where d.workspace_id=p_workspace_id
      and coalesce(d.imported_at,d.donated_at)>=p_from and coalesce(d.imported_at,d.donated_at)<p_until
      and not exists(select 1 from stage s where s.key=d.source_event_key)
  ), combined as (select * from stage union all select * from original), selected as (
    select * from combined where (p_before_at is null or (received_at,key)<(p_before_at,p_before_key))
      and (nullif(btrim(p_search),'') is null or position(lower(p_search) in lower(coalesce(payload->>'nickname','')||' '||coalesce(payload->>'soop_id','')||' '||coalesce(payload->>'event_name','')||' '||coalesce(payload->>'roulette_results','')||' '||coalesce(payload->>'roulette','')))>0)
    order by received_at desc,key desc limit 51
  ), numbered as (select *,row_number() over(order by received_at desc,key desc) as n from selected)
  select jsonb_build_object('items',coalesce((select jsonb_agg(payload||jsonb_build_object('history_key',key,'received_at',received_at) order by n) from numbered where n<=50),'[]'::jsonb),
    'hasMore',exists(select 1 from numbered where n>50),
    'cursor',case when exists(select 1 from numbered where n>50) then (select jsonb_build_object('at',received_at,'key',key) from numbered where n=50) else null end) into result;
  return result;
end $$;
revoke all on function public.byeollog_ux_history_v1(uuid,timestamptz,timestamptz,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.byeollog_ux_history_v1(uuid,timestamptz,timestamptz,timestamptz,text,text) to service_role;

-- Preserve the exact existing FIFO decisions; record the blocking head for explanation.
create or replace function public.ingest_soop_external_roulette_result_v2(
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
  v_expected integer;v_validation text;v_complete boolean:=false;
begin
  if p_workspace_id is null or char_length(btrim(p_chat_event_id)) not between 1 and 180
    or char_length(btrim(p_chat_actor_id)) not between 1 and 180
    or char_length(btrim(p_chat_actor_name)) not between 1 and 120
    or char_length(btrim(p_result_text)) not between 1 and 120
    or char_length(btrim(p_raw_message)) not between 1 and 300 or p_occurred_at is null
    or char_length(btrim(p_broadcast_key)) not between 1 and 200
  then raise exception 'external roulette result is invalid' using errcode='22023'; end if;

  -- The gateway already sequences each workspace.  This database lock also
  -- protects direct retries and overlapping serverless invocations.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'byeollog:soop-roulette-fifo-v2:'||p_workspace_id::text||':'||btrim(p_broadcast_key),0));

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

  -- For configured roulettes, the oldest incomplete donation owns the lane.
  -- Both one-spin bursts and multi-spin jobs use the same queue rule.  A
  -- parsed donor hint is deliberately not allowed to skip an older configured
  -- job: the configured queue is deterministic FIFO by contract.
  select donation.* into v_donation
  from public.byeollog_soop_core_donations donation
  where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
    and donation.status in ('pending','collecting')
    and donation.expected_spins is not null
    and donation.result_count<donation.expected_spins
    and donation.occurred_at<=p_occurred_at+interval '5 seconds'
  order by donation.occurred_at,donation.id
  limit 1 for update;
  if v_donation.id is not null then
    if v_donation.occurred_at<p_occurred_at-interval '10 minutes' then
      update public.byeollog_soop_core_roulette_results result
      set match_state='ambiguous',match_method='fifo_head_stale',review_details=jsonb_build_object('fifoHead',jsonb_build_object('id',v_donation.id,'actor_name',v_donation.actor_name,'amount',v_donation.amount,'occurred_at',v_donation.occurred_at,'result_count',v_donation.result_count,'expected_spins',v_donation.expected_spins))
      where result.id=v_result_id;
      return jsonb_build_object('duplicate',false,'matched',false,
        'status','fifo_blocked_stale_head','candidateCount',1);
    end if;
    if nullif(btrim(p_roulette_name),'') is not null and v_donation.roulette_name is not null
      and lower(v_donation.roulette_name)<>lower(btrim(p_roulette_name)) then
      update public.byeollog_soop_core_roulette_results result
      set match_state='ambiguous',match_method='fifo_head_roulette_mismatch',review_details=jsonb_build_object('fifoHead',jsonb_build_object('id',v_donation.id,'actor_name',v_donation.actor_name,'amount',v_donation.amount,'occurred_at',v_donation.occurred_at,'result_count',v_donation.result_count,'expected_spins',v_donation.expected_spins))
      where result.id=v_result_id;
      return jsonb_build_object('duplicate',false,'matched',false,
        'status','fifo_head_roulette_mismatch','candidateCount',1);
    end if;
    v_method:='fifo_expected_spins';
  end if;

  -- Accounts without confirmed expected-spin mappings retain the prior
  -- conservative matching behavior.  They never bypass a configured head.
  if v_donation.id is null then
    v_candidates:=0;
    if nullif(btrim(p_donor_name_hint),'') is not null then
      select donation.* into v_donation
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status in ('pending','collecting') and donation.expected_spins is null
        and donation.occurred_at between p_occurred_at-interval '10 minutes' and p_occurred_at+interval '5 seconds'
        and lower(donation.actor_name)=lower(btrim(p_donor_name_hint))
      order by donation.occurred_at,donation.id
      limit 1 for update;
      if v_donation.id is not null then v_method:='legacy_donor_name_fifo'; end if;
    end if;
  end if;
  if v_donation.id is null then
    select count(*)::integer into v_candidates
    from public.byeollog_soop_core_donations donation
    where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
      and donation.status='collecting' and donation.expected_spins is null
      and donation.last_result_at between p_occurred_at-interval '30 seconds' and p_occurred_at+interval '5 seconds'
      and not exists(
        select 1 from public.byeollog_soop_core_donations newer
        where newer.workspace_id=p_workspace_id and newer.broadcast_key=btrim(p_broadcast_key)
          and newer.status='pending' and newer.expected_spins is null
          and newer.occurred_at>donation.last_result_at
          and newer.occurred_at<=p_occurred_at+interval '5 seconds');
    if v_candidates=1 then
      select donation.* into v_donation
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status='collecting' and donation.expected_spins is null
        and donation.last_result_at between p_occurred_at-interval '30 seconds' and p_occurred_at+interval '5 seconds'
        and not exists(
          select 1 from public.byeollog_soop_core_donations newer
          where newer.workspace_id=p_workspace_id and newer.broadcast_key=btrim(p_broadcast_key)
            and newer.status='pending' and newer.expected_spins is null
            and newer.occurred_at>donation.last_result_at
            and newer.occurred_at<=p_occurred_at+interval '5 seconds')
      limit 1 for update;
      v_method:='sequence_continuation';
    elsif v_candidates=0 then
      select count(*)::integer into v_candidates
      from public.byeollog_soop_core_donations donation
      where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
        and donation.status='pending' and donation.expected_spins is null
        and donation.occurred_at between p_occurred_at-interval '120 seconds' and p_occurred_at+interval '5 seconds';
      if v_candidates=1 then
        select donation.* into v_donation
        from public.byeollog_soop_core_donations donation
        where donation.workspace_id=p_workspace_id and donation.broadcast_key=btrim(p_broadcast_key)
          and donation.status='pending' and donation.expected_spins is null
          and donation.occurred_at between p_occurred_at-interval '120 seconds' and p_occurred_at+interval '5 seconds'
        limit 1 for update;
        v_method:='unique_recent';
      end if;
    end if;
  end if;

  if v_donation.id is null then
    update public.byeollog_soop_core_roulette_results result set
      match_state=case when v_candidates>1 then 'ambiguous' else 'unmatched' end
    where result.id=v_result_id;
    return jsonb_build_object('duplicate',false,'matched',false,
      'status',case when v_candidates>1 then 'ambiguous' else 'unmatched' end,
      'candidateCount',v_candidates);
  end if;

  update public.byeollog_soop_core_roulette_results result set
    donation_id=v_donation.id,match_state='matched',match_method=v_method
  where result.id=v_result_id;
  select jsonb_agg(jsonb_build_object('result',result.result_text,'probability','')
      order by result.occurred_at,result.id),
    count(*)::integer,
    max(result.roulette_name) filter(where result.roulette_name is not null)
  into v_results,v_count,v_event_name
  from public.byeollog_soop_core_roulette_results result
  where result.workspace_id=p_workspace_id and result.donation_id=v_donation.id
    and result.match_state='matched';

  v_expected:=v_donation.expected_spins;
  v_complete:=v_expected is not null and v_count>=v_expected;
  v_validation:=case
    when v_expected is null then 'matched'
    when v_count<v_expected then 'short'
    when v_count=v_expected then 'matched'
    else 'over'
  end;
  v_event_name:=coalesce(v_donation.roulette_name,v_event_name,v_donation.amount::text||'개 룰렛');

  update public.byeollog_soop_core_donations donation set
    result_count=v_count,last_result_at=p_occurred_at,
    status=case when v_complete then 'complete' else 'collecting' end,
    updated_at=clock_timestamp()
  where donation.id=v_donation.id;
  update public.bangsel_donations donation set
    had_roulette=true,roulette_count=v_count,roulette_results=v_results,event_name=v_event_name,
    raw_payload=donation.raw_payload||jsonb_build_object(
      'correlation','soop_chat_sdk','match_method',v_method,
      'expected_spins',v_expected,'correlation_complete',v_complete,'roulette_enabled',v_donation.roulette_enabled)
  where donation.workspace_id=p_workspace_id
    and donation.source_event_key='soop_sdk:'||v_donation.provider_event_id;
  insert into public.bangsel_collector_staging(
    workspace_id,source_uid,session_id,donated_time_text,nickname,soop_id,balloons,roulette,
    collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,
    roulette_results,process_status,source_scope,uploaded_at)
  values(p_workspace_id,'soop_sdk:'||v_donation.provider_event_id,v_donation.broadcast_key,
    to_char(v_donation.occurred_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
    v_donation.actor_name,v_donation.actor_id,v_donation.amount,
    (v_results->0->>'result'),'soop-chat-sdk-core-v2',
    jsonb_build_object('type','SENDBALLOON','source_provider','soop_chat_sdk',
      'provider_event_id',v_donation.provider_event_id,'correlation_method',v_method,
      'expected_spins',v_expected,'correlation_complete',v_complete,'roulette_enabled',v_donation.roulette_enabled),
    v_event_name,v_expected,v_count,v_validation,v_results,'pending','soop',clock_timestamp())
  on conflict(workspace_id,source_uid) do update set
    roulette=excluded.roulette,collector_version=excluded.collector_version,
    raw_payload=excluded.raw_payload,event_name=excluded.event_name,
    expected_spins=excluded.expected_spins,actual_spins=excluded.actual_spins,
    validation=excluded.validation,roulette_results=excluded.roulette_results,
    process_status='pending',processed_at=null,processing_started_at=null,process_error=null,
    uploaded_at=excluded.uploaded_at;
  return jsonb_build_object('duplicate',false,'matched',true,'status','matched',
    'matchMethod',v_method,'donationId',v_donation.id,
    'sourceUid',case when v_expected is null or v_complete
      then 'soop_sdk:'||v_donation.provider_event_id else null end,
    'resultCount',v_count,'expectedSpins',v_expected,'queueComplete',v_complete,
    'validation',v_validation);
end
$function$;
notify pgrst,'reload schema';


