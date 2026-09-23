set local lock_timeout='2s';
set local statement_timeout='60s';
-- Private, server-only calculator. Public viewer RPCs and ingestion are unchanged.
create table public.byeollog_reverse_fan_days (
 workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
 id uuid not null default gen_random_uuid(),
 name text not null check (char_length(btrim(name)) between 1 and 80),
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 rules jsonb not null,
 payments jsonb not null default '{}'::jsonb check(jsonb_typeof(payments)='object' and pg_column_size(payments)<=8388608),
 revision bigint not null default 1 check(revision>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(workspace_id,id),
 check(isfinite(starts_at) and isfinite(ends_at) and ends_at>starts_at and ends_at-starts_at<=interval '366 days'),
 check(jsonb_typeof(rules)='array' and jsonb_array_length(rules) between 1 and 30)
);
alter table public.byeollog_reverse_fan_days enable row level security;
revoke all on public.byeollog_reverse_fan_days from public,anon,authenticated;
grant select,insert,update,delete on public.byeollog_reverse_fan_days to service_role;
create index reverse_fan_days_recent_idx on public.byeollog_reverse_fan_days(workspace_id,starts_at desc,id);
-- Range scans do not scan other streamers' history.
create index if not exists donations_workspace_time_idx on public.bangsel_donations(workspace_id,donated_at);

create function public.byeollog_reverse_fan_rows_v1(p_workspace_id uuid,p_id uuid)
returns table(fan_id text,nickname text,donation_count bigint,balloons bigint,refund bigint,paid bigint,paid_at text,payable boolean)
language sql stable security invoker set search_path='' set statement_timeout='8s' as $fn$
 with c as (select * from public.byeollog_reverse_fan_days where workspace_id=p_workspace_id and id=p_id),
 donations as (
  select case when btrim(d.soop_id)='' then 'unknown:'||d.source_event_key else lower(btrim(d.soop_id)) end fan_id,
   (array_agg(d.nickname order by d.donated_at desc,d.source_event_key desc))[1] nickname,
   count(*) donation_count,sum(d.balloons)::bigint balloons,
   sum((d.balloons::bigint*(r->>'rateBp')::bigint)/10000)::bigint refund,bool_and(btrim(d.soop_id)<>'') payable
  from c join public.bangsel_donations d on d.workspace_id=c.workspace_id and d.donated_at>=c.starts_at and d.donated_at<c.ends_at
  cross join lateral jsonb_array_elements(c.rules) r
  where d.balloons between (r->>'min')::integer and (r->>'max')::integer
   and d.donation_type<>'구독'
  group by 1
 ), payments as (
  select p.key fan_id,p.value from c cross join lateral jsonb_each(c.payments) p
 )
 select coalesce(d.fan_id,p.fan_id),coalesce(nullif(d.nickname,''),p.value->>'nickname',d.fan_id,p.fan_id),
  coalesce(d.donation_count,0),coalesce(d.balloons,0),coalesce(d.refund,0),coalesce((p.value->>'amount')::bigint,0),p.value->>'at',coalesce(d.payable,false)
 from donations d full join payments p on p.fan_id=d.fan_id;
$fn$;
revoke all on function public.byeollog_reverse_fan_rows_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.byeollog_reverse_fan_rows_v1(uuid,uuid) to service_role;

create function public.byeollog_reverse_fan_day_v1(p_workspace_id uuid,p_user_id uuid,p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' set statement_timeout='8s' set lock_timeout='2s' as $fn$
declare c public.byeollog_reverse_fan_days; rid uuid; r jsonb; ranges int4range[]:='{}'; rr int4range;
 lo integer; hi integer; rate integer; pg integer; term text; filt text; data jsonb; row_data record; write_op boolean;
 ss timestamptz; ee timestamptz; nm text; has_paid boolean;
begin
 write_op:=p_action not in ('list','get');
 if p_workspace_id is null or p_user_id is null or not exists(
  select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
  where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active'
  and (not write_op or lower(m.role::text) in ('owner','editor','manager'))
 ) then raise exception 'permission denied' using errcode='42501'; end if;
 if p_payload is null or jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>20000 then raise exception 'invalid input' using errcode='22023'; end if;
 pg:=coalesce((p_payload->>'page')::integer,0);
 if pg<0 or pg>10000 then raise exception 'invalid page' using errcode='22023'; end if;
 if p_action='list' then
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(x)) from (
   select id,name,starts_at,ends_at,revision,created_at,updated_at from public.byeollog_reverse_fan_days
   where workspace_id=p_workspace_id order by starts_at desc,id limit 50 offset pg*50) x),'[]'::jsonb),
   'totalRows',(select count(*) from public.byeollog_reverse_fan_days where workspace_id=p_workspace_id)) into data;
  return data;
 end if;
 rid:=(p_payload->>'id')::uuid;
 if rid is null then raise exception 'missing id' using errcode='22023'; end if;
 if write_op then
  select * into c from public.byeollog_reverse_fan_days where workspace_id=p_workspace_id and id=rid for update;
 else
  select * into c from public.byeollog_reverse_fan_days where workspace_id=p_workspace_id and id=rid for share;
 end if;
 if p_action='create' then
  if c.id is not null then raise exception 'already saved' using errcode='PT409'; end if;
 elsif c.id is null then raise exception 'not found' using errcode='PT404';
 elsif write_op and c.revision is distinct from (p_payload->>'revision')::bigint then raise exception 'stale revision' using errcode='PT409'; end if;
 has_paid:=exists(select 1 from jsonb_each(coalesce(c.payments,'{}'::jsonb)) v where (v.value->>'amount')::bigint>0);
 if p_action in ('create','save') then
  if has_paid then raise exception 'paid campaign cannot be edited' using errcode='PT422'; end if;
  nm:=btrim(p_payload->>'name');ss:=(p_payload->>'startsAt')::timestamptz;ee:=(p_payload->>'endsAt')::timestamptz;
  if nm is null or char_length(nm) not between 1 and 80 or ss is null or ee is null or not isfinite(ss) or not isfinite(ee) or ee<=ss or ee-ss>interval '366 days'
   or jsonb_typeof(p_payload->'rules') is distinct from 'array' then raise exception 'invalid campaign' using errcode='22023'; end if;
  if jsonb_array_length(p_payload->'rules') not between 1 and 30 then raise exception 'invalid rules' using errcode='22023'; end if;
  for r in select * from jsonb_array_elements(p_payload->'rules') loop
   if (r->>'min') !~ '^[0-9]+$' or (r->>'max') !~ '^[0-9]+$' or (r->>'rateBp') !~ '^[0-9]+$' then raise exception 'invalid rule' using errcode='22023'; end if;
   lo:=(r->>'min')::integer;hi:=(r->>'max')::integer;rate:=(r->>'rateBp')::integer;
   if lo is null or hi is null or rate is null or lo<1 or hi<lo or hi>1000000000 or rate not between 1 and 10000 then raise exception 'invalid rule' using errcode='22023'; end if;
   rr:=int4range(lo,hi,'[]');
   if exists(select 1 from unnest(ranges) x where x&&rr) then raise exception 'overlapping ranges' using errcode='22023'; end if;
   ranges:=array_append(ranges,rr);
  end loop;
  if p_action='create' then
   insert into public.byeollog_reverse_fan_days(workspace_id,id,name,starts_at,ends_at,rules) values(p_workspace_id,rid,nm,ss,ee,p_payload->'rules');
  else
   update public.byeollog_reverse_fan_days set name=nm,starts_at=ss,ends_at=ee,rules=p_payload->'rules',payments='{}',revision=revision+1,updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=rid;
  end if;
  return jsonb_build_object('ok',true,'id',rid);
 elsif p_action='delete' then
  if has_paid then raise exception 'paid campaign cannot be deleted' using errcode='PT422'; end if;
  delete from public.byeollog_reverse_fan_days where workspace_id=p_workspace_id and id=rid;
  return jsonb_build_object('ok',true);
 elsif p_action in ('pay','undo') then
  select * into row_data from public.byeollog_reverse_fan_rows_v1(p_workspace_id,rid) where fan_id=p_payload->>'fanId';
  if not found then raise exception 'fan not found' using errcode='PT404'; end if;
  if row_data.refund is distinct from (p_payload->>'expectedRefund')::bigint or row_data.paid is distinct from (p_payload->>'expectedPaid')::bigint then raise exception 'amount changed' using errcode='PT409'; end if;
  if p_action='pay' and (not row_data.payable or row_data.refund<=row_data.paid) then raise exception 'no payable amount' using errcode='22023'; end if;
  if p_action='undo' and row_data.paid<=0 then raise exception 'no payment' using errcode='PT409'; end if;
  update public.byeollog_reverse_fan_days set payments=jsonb_set(payments,array[row_data.fan_id],jsonb_build_object('amount',case when p_action='pay' then row_data.refund else 0 end,'at',clock_timestamp(),'nickname',row_data.nickname,'by',p_user_id)),revision=revision+1,updated_at=clock_timestamp() where workspace_id=p_workspace_id and id=rid;
  return jsonb_build_object('ok',true);
 elsif p_action<>'get' then raise exception 'invalid action' using errcode='22023'; end if;
 term:=coalesce(p_payload->>'search','');filt:=coalesce(p_payload->>'filter','all');
 if char_length(term)>80 or filt not in ('all','pending','paid','review') then raise exception 'invalid filter' using errcode='22023'; end if;
 with rows as materialized (select *,greatest(refund-paid,0) due from public.byeollog_reverse_fan_rows_v1(p_workspace_id,rid)),
 filtered as (select * from rows where (term='' or position(lower(term) in lower(nickname||' '||fan_id))>0) and
  (filt='all' or (filt='pending' and due>0) or (filt='paid' and paid>0 and due=0 and paid=refund) or (filt='review' and (not payable or paid>refund))))
 select jsonb_build_object('campaign',(to_jsonb(c)-'payments')||jsonb_build_object('hasPayments',has_paid),
  'summary',(select jsonb_build_object('fans',count(*),'balloons',coalesce(sum(balloons),0),'refund',coalesce(sum(refund),0),'paid',coalesce(sum(paid),0),'due',coalesce(sum(due),0),'review',count(*) filter(where not payable or paid>refund)) from rows),
  'totalRows',(select count(*) from filtered),
  'items',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from filtered order by due desc,nickname,fan_id limit 50 offset pg*50) x),'[]'::jsonb)) into data;
 return data;
end
$fn$;
revoke all on function public.byeollog_reverse_fan_day_v1(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_reverse_fan_day_v1(uuid,uuid,text,jsonb) to service_role;
notify pgrst,'reload schema';

-- Include private settlement records in consistent backup / atomic restore.
CREATE OR REPLACE FUNCTION public.byeollog_export_backup_v10(p_workspace_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '30s'
AS $function$
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
    'byeollog_reverse_fan_days',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.byeollog_reverse_fan_days r where r.workspace_id=p_workspace_id),'[]'::jsonb),
    'byeollog_soop_core_donations',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.byeollog_soop_core_donations r where r.workspace_id=p_workspace_id),'[]'::jsonb),
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
$function$
;
CREATE OR REPLACE FUNCTION public.byeollog_restore_backup_v4(p_workspace_id uuid, p_lease_id uuid, p_tables jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
 SET lock_timeout TO '2s'
 SET statement_timeout TO '30s'
AS $function$
declare
  cfg record;
  rows_json jsonb;
  cols text;
  updates text;
  affected bigint;
  inserted_core_ids uuid[];
  counts jsonb := '{}'::jsonb;
  allowed constant text[] := array[
    'byeollog_soop_core_donations','bangsel_fans','bangsel_fan_stations','bangsel_roulette_rules','bangsel_tasks',
    'bangsel_donations','bangsel_task_import_items','bangsel_collector_staging',
    'bangsel_roulette_invalidations','byeollog_workspace_settings',
    'byeollog_signature_balloons','byeollog_default_donation_images',
    'byeollog_fixed_upbo_rules','byeollog_roulette_classification_rules',
    'byeollog_roulette_amount_mappings','byeollog_wallpaper_sessions',
    'byeollog_wallpaper_tiles','byeollog_wallpaper_user_settings',
    'byeollog_wallpaper_overlay_states','byeollog_credit_ledger','byeollog_special_roulette_rules','byeollog_reverse_fan_days'
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
    (0,'byeollog_soop_core_donations','id',false),
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
    (20,'byeollog_special_roulette_rules','workspace_id,result_text',false),
    (21,'byeollog_reverse_fan_days','workspace_id,id',false)
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

    -- A recovered historical donation must never re-enter a live FIFO.
    if cfg.name='byeollog_soop_core_donations' then
      if (select count(distinct r->>'id') from jsonb_array_elements(rows_json) r)<>jsonb_array_length(rows_json) then
        raise exception 'duplicate or missing core donation identity' using errcode='21000';
      end if;
      if exists(select 1 from jsonb_array_elements(rows_json) r join public.byeollog_soop_core_donations d on d.id=(r->>'id')::uuid
        where d.workspace_id<>p_workspace_id or d.provider_event_id is distinct from r->>'provider_event_id'
          or d.actor_id is distinct from r->>'actor_id' or d.amount is distinct from (r->>'amount')::bigint
          or d.occurred_at is distinct from (r->>'occurred_at')::timestamptz) then
        raise exception 'core donation identity or ownership conflict' using errcode='42501';
      end if;
      select jsonb_agg(r||jsonb_build_object('status',case when r->>'status' in ('pending','collecting') then 'expired' else r->>'status' end))
      into rows_json from jsonb_array_elements(rows_json) r;
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

    if cfg.name='byeollog_soop_core_donations' then
      -- Existing records retain current progress. Only missing history is added.
      execute format('with added as (insert into public.byeollog_soop_core_donations (%s)
        select %s from jsonb_populate_recordset(null::public.byeollog_soop_core_donations,$1) r
        where not exists(select 1 from public.byeollog_soop_core_donations d where d.id=r.id)
        on conflict (id) do nothing returning id) select coalesce(array_agg(id),array[]::uuid[]) from added',cols,cols)
        into inserted_core_ids using rows_json;
      -- The normal INSERT snapshot trigger stays unchanged. Restore its three
      -- mapping fields only on rows inserted by this transaction, before commit.
      update public.byeollog_soop_core_donations d set roulette_name=r->>'roulette_name',
        expected_spins=(r->>'expected_spins')::integer,roulette_enabled=coalesce((r->>'roulette_enabled')::boolean,true)
      from jsonb_array_elements(rows_json) r
      where d.id=any(inserted_core_ids) and d.id=(r->>'id')::uuid and d.workspace_id=p_workspace_id;
      select count(*) into affected from jsonb_array_elements(rows_json) r
        join public.byeollog_soop_core_donations d on d.id=(r->>'id')::uuid and d.workspace_id=p_workspace_id;
      if affected<>jsonb_array_length(rows_json) then raise exception 'core donation ownership conflict' using errcode='42501'; end if;
      counts:=counts||jsonb_build_object(cfg.name,affected);
      continue;
    end if;

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
  if jsonb_array_length(coalesce(p_tables->'byeollog_wallpaper_tiles','[]'::jsonb))>0 then
    perform private.byeollog_repair_wallpaper_sequence_v1(p_workspace_id,p_lease_id);
  end if;
  return counts;
end
$function$
;

revoke all on function public.byeollog_export_backup_v10(uuid) from public,anon,authenticated;
revoke all on function public.byeollog_restore_backup_v4(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_export_backup_v10(uuid) to service_role;
grant execute on function public.byeollog_restore_backup_v4(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
