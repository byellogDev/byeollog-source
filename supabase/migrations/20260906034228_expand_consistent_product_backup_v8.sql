-- Additive v8 backup boundary. Export is one PostgreSQL statement/snapshot;
-- restore is one transaction. Runtime OAuth/session/queue state is deliberately
-- outside this user-data archive so a restore cannot revive stale credentials or
-- replay already handled live events.

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
    'byeollog_wallpaper_overlay_states',coalesce((select jsonb_agg(to_jsonb(r) order by r.workspace_id) from public.byeollog_wallpaper_overlay_states r where r.workspace_id=p_workspace_id),'[]'::jsonb)
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
    'byeollog_wallpaper_overlay_states'
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
    (18,'byeollog_wallpaper_overlay_states','workspace_id',false)
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

revoke all on function public.byeollog_export_backup_v8(uuid) from public,anon,authenticated;
revoke all on function public.byeollog_restore_backup_v2(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.byeollog_export_backup_v8(uuid) to service_role;
grant execute on function public.byeollog_restore_backup_v2(uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';


