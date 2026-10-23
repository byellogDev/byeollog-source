begin;
set local lock_timeout='2s';
set local statement_timeout='15s';

create table public.byeollog_upbo_collection_settings(
 workspace_id uuid primary key references public.byeollog_workspaces(id),
 enabled boolean not null default false,
 rules jsonb not null default '[]',
 rules_url text not null default '',
 rules_checked_at timestamptz,
 rules_attempted_at timestamptz,
 updated_at timestamptz not null default clock_timestamp()
);
create table public.byeollog_upbo_event_names(
 workspace_id uuid not null references public.byeollog_workspaces(id),
 amount bigint not null check(amount between 1 and 1000000000),
 amount_max bigint not null check(amount_max between amount and 1000000000),
 event_name text not null check(char_length(btrim(event_name)) between 1 and 120 and event_name !~ '[[:cntrl:]]'),
 primary key(workspace_id,amount)
);
alter table public.byeollog_upbo_collection_settings enable row level security;
alter table public.byeollog_upbo_event_names enable row level security;
revoke all on public.byeollog_upbo_collection_settings,public.byeollog_upbo_event_names from public,anon,authenticated,service_role;

-- Existing saved names and technical spin counts survive; names no longer enable collection.
insert into public.byeollog_upbo_event_names(workspace_id,amount,amount_max,event_name)
 select workspace_id,balloons,coalesce(balloons_max,balloons),roulette_name from public.byeollog_roulette_amount_mappings;
-- Only accounts with an already-saved valid URL retain collection at migration time.
insert into public.byeollog_upbo_collection_settings(workspace_id,enabled)
 select workspace_id,true from byeollog_weflab_trial.settings where url<>'';

create function private.upbo_collection_enabled_v1(p_workspace uuid)
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from public.byeollog_upbo_collection_settings s
 join byeollog_weflab_trial.settings w using(workspace_id)
 where s.workspace_id=p_workspace and s.enabled and w.url<>'' and s.rules_url=w.url);
$$;
revoke all on function private.upbo_collection_enabled_v1(uuid) from public,anon,authenticated,service_role;

create function private.validate_upbo_auto_rules_v1(rules jsonb) returns void language plpgsql set search_path='' as $$
begin
 if jsonb_typeof(rules) is distinct from 'array' then raise exception 'invalid auto rules' using errcode='22023'; end if;
 if jsonb_array_length(rules)>500 then raise exception 'invalid auto rules' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(rules) r where jsonb_typeof(r->'amount') is distinct from 'number'
  or jsonb_typeof(r->'amountMax') is distinct from 'number' or jsonb_typeof(r->'spins') is distinct from 'number'
  or (r->>'amount')::numeric<>trunc((r->>'amount')::numeric) or (r->>'amountMax')::numeric<>trunc((r->>'amountMax')::numeric)
  or (r->>'spins')::numeric<>trunc((r->>'spins')::numeric)
  or (r->>'amount')::numeric<1 or (r->>'amountMax')::numeric>1000000000 or (r->>'amountMax')::numeric<(r->>'amount')::numeric
  or (r->>'spins')::numeric not between 1 and 1000) then raise exception 'invalid auto rules' using errcode='22023'; end if;
 if exists(select 1 from jsonb_array_elements(rules) with ordinality a(r,i),jsonb_array_elements(rules) with ordinality b(r,i)
   where a.i<b.i and (a.r->>'amount')::bigint<=(b.r->>'amountMax')::bigint and (a.r->>'amountMax')::bigint>=(b.r->>'amount')::bigint) then
   raise exception 'overlapping auto rules' using errcode='22023'; end if;
end $$;
revoke all on function private.validate_upbo_auto_rules_v1(jsonb) from public,anon,authenticated,service_role;

create function public.byeollog_upbo_collection_runtime_v1(p_workspace_id uuid,p_request jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare claimed boolean:=false;
begin
 if p_request->>'action'='refresh' then
   perform private.validate_upbo_auto_rules_v1(p_request->'rules');
   perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
   update public.byeollog_upbo_collection_settings s set rules=p_request->'rules',rules_url=p_request->>'url',rules_checked_at=clock_timestamp()
    where s.workspace_id=p_workspace_id and s.enabled and exists(select 1 from byeollog_weflab_trial.settings w
      where w.workspace_id=s.workspace_id and w.url=p_request->>'url' and w.url<>'');
 elsif p_request->>'action'='claim_refresh' then
   update public.byeollog_upbo_collection_settings s set rules_attempted_at=clock_timestamp()
    where s.workspace_id=p_workspace_id and s.enabled
      and (s.rules_checked_at is null or s.rules_checked_at<clock_timestamp()-interval '60 seconds')
      and (s.rules_attempted_at is null or s.rules_attempted_at<clock_timestamp()-interval '60 seconds')
      and exists(select 1 from byeollog_weflab_trial.settings w where w.workspace_id=s.workspace_id and w.url<>'');
   claimed:=found;
 elsif p_request->>'action' is distinct from 'get' then raise exception 'invalid collection runtime action'; end if;
 return (select jsonb_build_object('requestedEnabled',s.enabled,'url',w.url,'owner',a.soop_id,'checkedAt',s.rules_checked_at,'refreshAllowed',claimed)
  from public.byeollog_upbo_collection_settings s join byeollog_weflab_trial.settings w using(workspace_id)
  join public.byeollog_workspaces a on a.id=s.workspace_id where s.workspace_id=p_workspace_id and a.status='active');
end $$;
revoke all on function public.byeollog_upbo_collection_runtime_v1(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_upbo_collection_runtime_v1(uuid,jsonb) to service_role;
alter table public.byeollog_soop_runtime_controls add column upbo_settings_protocol integer not null default 1;

create function public.byeollog_upbo_collection_settings_v1(p_workspace_id uuid,p_user_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare a text:=p_request->>'action';u text;e boolean;lo bigint;hi bigint;n text;
begin
 if not exists(select 1 from public.byeollog_workspaces w join public.byeollog_workspace_members m on m.workspace_id=w.id
   where w.id=p_workspace_id and w.status='active' and m.user_id=p_user_id and m.role in ('owner','manager')) then
   raise exception 'collection_forbidden' using errcode='42501'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
 if a='settings_save' then
   if jsonb_typeof(p_request->'enabled') is distinct from 'boolean' or jsonb_typeof(p_request->'url') is distinct from 'string' then
     raise exception 'collection_settings' using errcode='22023'; end if;
   u:=btrim(p_request->>'url');e:=(p_request->>'enabled')::boolean;
   if length(u)>256 or (u<>'' and u!~'^https://weflab[.]com/page/[A-Za-z0-9]+$') or (e and u='') then
     raise exception 'collection_url_required' using errcode='22023'; end if;
   -- Same order as existing Agent settings: campaign before URL. No campaign is enrolled here.
   perform 1 from byeollog_weflab_trial.campaigns where workspace_id=p_workspace_id for update;
   insert into byeollog_weflab_trial.settings(workspace_id,url) values(p_workspace_id,u)
    on conflict(workspace_id) do update set url=excluded.url,updated_at=clock_timestamp();
   insert into public.byeollog_upbo_collection_settings(workspace_id,enabled) values(p_workspace_id,e)
    on conflict(workspace_id) do update set enabled=excluded.enabled,updated_at=clock_timestamp();
   if e then
     perform private.validate_upbo_auto_rules_v1(p_request->'rules');
     update public.byeollog_upbo_collection_settings set rules=p_request->'rules',rules_url=u,rules_checked_at=clock_timestamp() where workspace_id=p_workspace_id;
   end if;
 elsif a='name_save' then
   lo:=(p_request->>'amount')::bigint;hi:=(p_request->>'amountMax')::bigint;n:=btrim(p_request->>'name');
   if lo is null or hi is null or lo<1 or hi<lo or hi>1000000000 or n is null or length(n) not between 1 and 120 or n~'[[:cntrl:]]' then
     raise exception 'collection_name' using errcode='22023'; end if;
   if exists(select 1 from public.byeollog_upbo_event_names where workspace_id=p_workspace_id and amount<>lo and amount<=hi and amount_max>=lo) then
     raise exception 'collection_name_overlap' using errcode='23P01'; end if;
   insert into public.byeollog_upbo_event_names values(p_workspace_id,lo,hi,n)
    on conflict(workspace_id,amount) do update set amount_max=excluded.amount_max,event_name=excluded.event_name;
 elsif a='name_delete' then
   delete from public.byeollog_upbo_event_names where workspace_id=p_workspace_id and amount=(p_request->>'amount')::bigint;
 elsif a is distinct from 'get' then raise exception 'collection_action' using errcode='22023'; end if;
 return jsonb_build_object('enabled',private.upbo_collection_enabled_v1(p_workspace_id),
  'needsReviewCount',(select count(*) from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and upbo_collection_issue is not null),
  'url',coalesce((select url from byeollog_weflab_trial.settings where workspace_id=p_workspace_id),''),
  'names',coalesce((select jsonb_agg(jsonb_build_object('amount',amount,'amountMax',amount_max,'name',event_name) order by amount)
    from public.byeollog_upbo_event_names where workspace_id=p_workspace_id),'[]'::jsonb));
end $$;
revoke all on function public.byeollog_upbo_collection_settings_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_upbo_collection_settings_v1(uuid,uuid,jsonb) to service_role;

-- Historical eligibility and event names are preserved. New donations snapshot the master switch.
alter table public.byeollog_soop_core_donations add column upbo_collection_managed boolean not null default false;
alter table public.byeollog_soop_core_donations add column upbo_collection_enabled boolean not null default true;
alter table public.byeollog_soop_core_donations add column upbo_event_name text;
alter table public.byeollog_soop_core_donations add column upbo_collection_issue text;
create index upbo_collection_issue_workspace on public.byeollog_soop_core_donations(workspace_id) where upbo_collection_issue is not null;
create function private.snapshot_upbo_collection_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare spins integer;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||new.workspace_id::text,0));
 new.upbo_collection_managed:=true;
 new.upbo_collection_enabled:=private.upbo_collection_enabled_v1(new.workspace_id);
 if exists(select 1 from public.byeollog_upbo_collection_settings s where s.workspace_id=new.workspace_id and s.enabled
   and (not new.upbo_collection_enabled or s.rules_checked_at is null or s.rules_checked_at<=clock_timestamp()-interval '2 minutes')) then
   new.upbo_collection_issue:='overlay_settings_unavailable';
 end if;
 select event_name into new.upbo_event_name from public.byeollog_upbo_event_names
  where workspace_id=new.workspace_id and new.amount between amount and amount_max;
 select (r->>'spins')::integer into spins from public.byeollog_upbo_collection_settings s,
   lateral jsonb_array_elements(s.rules) r where s.workspace_id=new.workspace_id
   and s.rules_checked_at>clock_timestamp()-interval '2 minutes'
   and new.amount between (r->>'amount')::bigint and (r->>'amountMax')::bigint;
 -- Correlation configuration comes from the overlay, never from optional names or stale manual registrations.
 new.expected_spins:=spins;
 new.roulette_name:=null;
 new.roulette_enabled:=new.upbo_collection_enabled and spins is not null and new.donation_type_label not in ('애드벌룬','영상후원');
 if not new.roulette_enabled then new.status:='complete'; end if;
 return new;
end $$;
revoke all on function private.snapshot_upbo_collection_v1() from public,anon,authenticated,service_role;
create trigger zz_snapshot_upbo_collection before insert on public.byeollog_soop_core_donations
 for each row execute function private.snapshot_upbo_collection_v1();

-- Suppress only new OFF-period work; previously accepted work drains normally, including fixed rewards.
create function private.guard_upbo_staging_v1() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from public.byeollog_soop_core_donations d where d.workspace_id=new.workspace_id
   and 'soop_sdk:'||d.provider_event_id=new.source_uid and d.upbo_collection_managed and not d.upbo_collection_enabled) then return null; end if;
 return new;
end $$;
revoke all on function private.guard_upbo_staging_v1() from public,anon,authenticated,service_role;
create trigger aa_guard_upbo_staging before insert or update on public.bangsel_collector_staging
 for each row execute function private.guard_upbo_staging_v1();

-- Patch verified boundaries without replacing unrelated receipt, multiplier or timeout fixes.
do $patch$
declare f text;marker text;replacement text;
begin
 f:=pg_get_functiondef('public.apply_roulette_amount_mapping_to_staging_v1()'::regprocedure);
 marker:='begin';
 if strpos(lower(f),marker)=0 then raise exception 'collection staging name definition drift'; end if;
 -- New names have a donation-time snapshot. Old mapping triggers must not overwrite it.
 f:=regexp_replace(f,'\m[Bb][Ee][Gg][Ii][Nn]\M',$new$begin
  if exists(select 1 from public.byeollog_soop_core_donations d where d.workspace_id=new.workspace_id
    and 'soop_sdk:'||d.provider_event_id=new.source_uid and d.upbo_collection_managed) then return new; end if;$new$);
 execute f;
 f:=pg_get_functiondef('public.ingest_soop_external_roulette_result_v4(uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text)'::regprocedure);
 marker:=$old$if not exists(select 1 from public.byeollog_roulette_amount_mappings m
      where m.workspace_id=p_workspace_id and m.enabled) then$old$;
 if strpos(f,marker)=0 then raise exception 'collection gate definition drift'; end if;
 f:=replace(f,marker,'if not private.upbo_collection_enabled_v1(p_workspace_id) then');
 execute f;

 f:=pg_get_functiondef('public.ingest_soop_external_roulette_result_v2(uuid,text,text,text,text,text,text,text,timestamptz,text)'::regprocedure);
 marker:='if v_donation.id is not null then';
 if strpos(f,marker)=0 then raise exception 'collection FIFO definition drift'; end if;
 f:=replace(f,marker,$guard$if exists(select 1 from public.byeollog_soop_core_donations d
    where d.workspace_id=p_workspace_id and d.upbo_collection_issue is not null and d.user_closed_at is null
      and private.same_soop_broadcast_v1(p_workspace_id,d.id,d.broadcast_key,btrim(p_broadcast_key))
      and d.occurred_at between p_occurred_at-interval '10 minutes' and p_occurred_at+interval '5 seconds'
      and (v_donation.id is null or (d.occurred_at,d.id)<=(v_donation.occurred_at,v_donation.id))) then
    update public.byeollog_soop_core_roulette_results set match_state='ambiguous',match_method='overlay_settings_unavailable'
      where id=v_result_id;
    return jsonb_build_object('duplicate',false,'matched',false,'status','overlay_settings_unavailable');
  end if;
  if v_donation.id is not null then$guard$);
 marker:=$old$v_event_name:=v_donation.roulette_name;$old$;
 if strpos(f,marker)=0 then raise exception 'collection event name definition drift'; end if;
 replacement:=$new$if v_donation.upbo_collection_managed then
    v_event_name:=coalesce(v_donation.upbo_event_name,
      extract(month from (coalesce((select min(r.occurred_at) from public.byeollog_soop_core_roulette_results r
        where r.workspace_id=p_workspace_id and r.donation_id=v_donation.id),p_occurred_at) at time zone 'Asia/Seoul'))::integer::text
      ||'월 '||v_donation.amount::text||'개');
    update public.byeollog_soop_core_donations set upbo_event_name=v_event_name where id=v_donation.id and workspace_id=p_workspace_id;
  else
    v_event_name:=v_donation.roulette_name;
  end if;$new$;
 execute replace(f,marker,replacement);

end $patch$;
notify pgrst,'reload schema';
commit;
