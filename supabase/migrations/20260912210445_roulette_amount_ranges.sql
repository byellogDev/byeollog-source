begin;
set local lock_timeout='3s';
create extension if not exists btree_gist with schema extensions;
alter table public.byeollog_roulette_amount_mappings add column balloons_max bigint;
update public.byeollog_roulette_amount_mappings set balloons_max=balloons;
alter table public.byeollog_roulette_amount_mappings add constraint roulette_range_order check(balloons_max is null or balloons_max between balloons and 1000000000);
-- NULL is the legacy single amount, so old clients and old backups remain valid.
set local search_path=public,extensions;
alter table public.byeollog_roulette_amount_mappings add constraint roulette_range_no_overlap
exclude using gist(workspace_id with =,int8range(balloons,coalesce(balloons_max,balloons),'[]') with &&) deferrable initially immediate;
set local search_path='';

create or replace function public.byeollog_save_roulette_ranges_v1(p_workspace_id uuid,p_user_id uuid,p_rules jsonb,p_previous bigint default null)
returns void language plpgsql security invoker set search_path='' set lock_timeout='3s' set statement_timeout='8s'
as $$
declare r jsonb;
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active' and lower(m.role::text) in ('owner','editor','manager')) then
    raise exception 'unauthorized' using errcode='42501';end if;
  if jsonb_typeof(p_rules) is distinct from 'array' or jsonb_array_length(p_rules) not between 1 and 50 or (p_previous is not null and jsonb_array_length(p_rules)<>1) then
    raise exception 'invalid rules' using errcode='22023';end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('roulette-ranges:'||p_workspace_id::text,0));
  set constraints public.roulette_range_no_overlap deferred;
  if p_previous is not null and p_previous<>(p_rules->0->>'balloons')::bigint then
    if exists(select 1 from public.byeollog_roulette_amount_mappings where workspace_id=p_workspace_id and balloons=(p_rules->0->>'balloons')::bigint) then
      raise exception 'range already exists' using errcode='23P01';end if;
    delete from public.byeollog_roulette_amount_mappings where workspace_id=p_workspace_id and balloons=p_previous;
    if not found then raise exception 'rule changed' using errcode='PT409';end if;
  end if;
  for r in select value from jsonb_array_elements(p_rules) loop
    insert into public.byeollog_roulette_amount_mappings(workspace_id,balloons,balloons_max,roulette_name,expected_spins,enabled)
      values(p_workspace_id,(r->>'balloons')::bigint,coalesce((r->>'balloons_max')::bigint,(r->>'balloons')::bigint),r->>'roulette_name',(r->>'expected_spins')::integer,coalesce((r->>'enabled')::boolean,true))
    on conflict(workspace_id,balloons) do update set
      balloons_max=case when r ? 'balloons_max' then excluded.balloons_max else byeollog_roulette_amount_mappings.balloons_max end,
      roulette_name=excluded.roulette_name,updated_at=clock_timestamp(),
      expected_spins=case when r ? 'expected_spins' then excluded.expected_spins else byeollog_roulette_amount_mappings.expected_spins end,
      enabled=case when r ? 'enabled' then excluded.enabled else byeollog_roulette_amount_mappings.enabled end;
  end loop;
  set constraints public.roulette_range_no_overlap immediate;
end $$;
revoke all on function public.byeollog_save_roulette_ranges_v1(uuid,uuid,jsonb,bigint) from public,anon,authenticated;
grant execute on function public.byeollog_save_roulette_ranges_v1(uuid,uuid,jsonb,bigint) to service_role;
create or replace function private.snapshot_soop_roulette_mapping_v2()
returns trigger
language plpgsql
set search_path=''
as $function$
declare v_name text;v_spins integer;
begin
  select mapping.enabled into new.roulette_enabled
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.amount between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons)
  for share;
  new.roulette_enabled:=coalesce(new.roulette_enabled,true);
  if new.roulette_name is not null or new.expected_spins is not null then
    return new;
  end if;
  select mapping.roulette_name,mapping.expected_spins
  into v_name,v_spins
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.amount between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons);
  new.roulette_name:=nullif(btrim(v_name),'');
  new.expected_spins:=v_spins;
  return new;
end
$function$;


create or replace function public.apply_roulette_amount_mapping_to_staging_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
declare v_name text;
begin
  if coalesce(new.raw_payload->>'source_provider','')<>'soop_chat_sdk'
     or coalesce(new.balloons,0)<1
     or jsonb_array_length(coalesce(new.roulette_results,'[]'::jsonb))=0
  then return new; end if;
  select mapping.roulette_name into v_name
  from public.byeollog_roulette_amount_mappings mapping
  where mapping.workspace_id=new.workspace_id and new.balloons between mapping.balloons and coalesce(mapping.balloons_max,mapping.balloons);
  if v_name is not null then new.event_name:=v_name; end if;
  return new;
end
$function$;

create or replace function public.reapply_roulette_amount_mapping_v1()
returns trigger
language plpgsql
security definer
set search_path=''
as $function$
begin
  update public.bangsel_collector_staging staging
  set event_name=new.roulette_name
  where staging.workspace_id=new.workspace_id
    and staging.balloons between new.balloons and coalesce(new.balloons_max,new.balloons)
    and staging.raw_payload->>'source_provider'='soop_chat_sdk'
    and jsonb_array_length(coalesce(staging.roulette_results,'[]'::jsonb))>0
    and staging.event_name is distinct from new.roulette_name;
  return new;
end
$function$;


commit;


