-- New RPCs leave v8/v2 available for the previous web release.
-- No existing rows, normal ingestion trigger, or caller RLS are changed.
create or replace function private.byeollog_repair_wallpaper_sequence_v1(p_workspace_id uuid,p_lease_id uuid)
returns void language plpgsql security definer set search_path='' set lock_timeout='500ms'
as $function$
declare restored_max bigint; sequence_value bigint; sequence_called boolean; global_max bigint; seq regclass;
begin
  if not exists(select 1 from public.byeollog_workspace_backup_leases l
    where l.workspace_id=p_workspace_id and l.lease_id=p_lease_id and l.reason='pre_restore' and l.expires_at>clock_timestamp()) then
    raise exception 'active restore lease required' using errcode='42501';
  end if;
  select max(sequence_no) into restored_max from public.byeollog_wallpaper_tiles where workspace_id=p_workspace_id;
  if restored_max is null then return; end if;
  seq:=pg_get_serial_sequence('public.byeollog_wallpaper_tiles','sequence_no')::regclass;
  execute format('select last_value,is_called from %s',seq) into sequence_value,sequence_called;
  -- Ordinary live-database restores require no table/sequence write lock.
  if sequence_value>restored_max or (sequence_called and sequence_value=restored_max) then return; end if;
  -- Never wait behind live writes. On contention the restore rolls back atomically.
  lock table public.byeollog_wallpaper_tiles in share row exclusive mode nowait;
  execute format('select last_value,is_called from %s',seq) into sequence_value,sequence_called;
  select max(sequence_no) into global_max from public.byeollog_wallpaper_tiles;
  if sequence_value>global_max or (sequence_called and sequence_value=global_max) then return; end if;
  if global_max=9223372036854775807 then raise exception 'wallpaper sequence exhausted' using errcode='22003'; end if;
  -- Transactional RESTART invalidates cached sequence values and cannot regress
  -- a concurrently committed normal INSERT while the table write lock is held.
  execute format('alter sequence %s restart with %s',seq,greatest(sequence_value,global_max)+1);
end
$function$;
revoke all on function private.byeollog_repair_wallpaper_sequence_v1(uuid,uuid) from public,anon,authenticated;
grant usage on schema private to service_role;
grant execute on function private.byeollog_repair_wallpaper_sequence_v1(uuid,uuid) to service_role;

CREATE OR REPLACE FUNCTION public.byeollog_export_backup_v9(p_workspace_id uuid)
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
CREATE OR REPLACE FUNCTION public.byeollog_restore_backup_v3(p_workspace_id uuid, p_lease_id uuid, p_tables jsonb)
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

revoke all on function public.byeollog_export_backup_v9(uuid) from public,anon,authenticated;
revoke all on function public.byeollog_restore_backup_v3(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_export_backup_v9(uuid) to service_role;
grant execute on function public.byeollog_restore_backup_v3(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
