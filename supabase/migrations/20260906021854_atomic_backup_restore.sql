-- Additive, service-only restore boundary. No existing data is modified here.
-- The seven-table v7 archive scope and merge semantics stay unchanged.
create or replace function public.byeollog_restore_backup_v1(
  p_workspace_id uuid, p_lease_id uuid, p_tables jsonb
) returns jsonb
language plpgsql security invoker
set search_path = ''
set lock_timeout = '2s'
set statement_timeout = '15s'
as $function$
declare
  cfg record; rows_json jsonb; cols text; updates text; affected bigint;
  counts jsonb := '{}'::jsonb;
  allowed constant text[] := array['bangsel_fans','bangsel_fan_stations','bangsel_roulette_rules',
    'bangsel_tasks','bangsel_donations','bangsel_task_import_items','bangsel_roulette_invalidations'];
begin
  if p_workspace_id is null or p_lease_id is null or p_tables is null
    or jsonb_typeof(p_tables) <> 'object' or pg_column_size(p_tables)>67108864 then
    raise exception 'invalid backup restore payload' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_object_keys(p_tables) k where not (k=any(allowed))) then
    raise exception 'unsupported backup table' using errcode='22023';
  end if;
  -- Lock only this lease, not the workspace row used by normal service paths.
  perform 1 from public.byeollog_workspace_backup_leases l
    where l.workspace_id=p_workspace_id and l.lease_id=p_lease_id
      and l.reason='pre_restore' and l.expires_at>clock_timestamp()
    for update;
  if not found then
    raise exception 'restore lease is missing or expired' using errcode='55000';
  end if;
  if not exists(select 1 from public.byeollog_workspaces w where w.id=p_workspace_id and w.status='active') then
    raise exception 'workspace is not active' using errcode='55000';
  end if;

  -- Fans precede tasks; import ledger follows tasks. Every write below is part
  -- of this one database transaction, including validation and trigger errors.
  for cfg in select * from (values
    (1,'bangsel_fans','workspace_id,soop_id'),
    (2,'bangsel_fan_stations','workspace_id,fan'),
    (3,'bangsel_roulette_rules','workspace_id,result_text'),
    (4,'bangsel_tasks','id'),
    (5,'bangsel_donations','workspace_id,source_event_key'),
    (6,'bangsel_task_import_items','workspace_id,source_event_key'),
    (7,'bangsel_roulette_invalidations','workspace_id,source_uid')
  ) as t(position,name,conflict_columns) order by position loop
    rows_json := coalesce(p_tables->cfg.name,'[]'::jsonb);
    if jsonb_typeof(rows_json)<>'array' or jsonb_array_length(rows_json)>100000 then
      raise exception 'invalid backup rows for %',cfg.name using errcode='22023';
    end if;
    if exists(select 1 from jsonb_array_elements(rows_json) r
      where jsonb_typeof(r)<>'object' or (r->>'workspace_id') is distinct from p_workspace_id::text) then
      raise exception 'backup workspace mismatch' using errcode='42501';
    end if;
    if jsonb_array_length(rows_json)=0 then
      counts:=counts||jsonb_build_object(cfg.name,0); continue;
    end if;

    -- Preserve defaults for absent legacy columns, but do not silently discard
    -- unknown fields from archives created against a different schema.
    if exists(select 1 from jsonb_array_elements(rows_json) r cross join lateral jsonb_object_keys(r) k
      where not exists(select 1 from pg_catalog.pg_attribute a
        where a.attrelid=pg_catalog.to_regclass('public.'||cfg.name)
          and a.attname=k and a.attnum>0 and not a.attisdropped and a.attgenerated='')) then
      raise exception 'unknown backup column for %',cfg.name using errcode='22023';
    end if;
    select string_agg(format('%I',k),',' order by k),
      string_agg(format('%I=excluded.%I',k,k),',' order by k) filter(where k<>'workspace_id' and k<>'id')
    into cols,updates
    from (select distinct k from jsonb_array_elements(rows_json) r cross join lateral jsonb_object_keys(r) k) keys;

    if cfg.name='bangsel_task_import_items' and exists(
      select 1 from jsonb_array_elements(rows_json) r where not exists(
        select 1 from public.bangsel_tasks t where t.id=(r->>'task_id')::uuid and t.workspace_id=p_workspace_id
      )
    ) then
      raise exception 'backup task reference is not owned by workspace' using errcode='42501';
    end if;

    execute format('insert into public.%I as target (%s) select %s from jsonb_populate_recordset(null::public.%I,$1)
      on conflict (%s) do update set %s where target.workspace_id=$2',
      cfg.name,cols,cols,cfg.name,cfg.conflict_columns,
      coalesce(updates,'workspace_id=excluded.workspace_id')) using rows_json,p_workspace_id;
    get diagnostics affected=row_count;
    -- A global task UUID collision must not move another account's task.
    if affected<>jsonb_array_length(rows_json) then
      raise exception 'backup row ownership conflict' using errcode='42501';
    end if;
    counts:=counts||jsonb_build_object(cfg.name,affected);
  end loop;
  return counts;
end
$function$;
revoke all on function public.byeollog_restore_backup_v1(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_restore_backup_v1(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';


