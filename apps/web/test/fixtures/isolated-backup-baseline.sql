CREATE OR REPLACE FUNCTION public.begin_workspace_backup_v1(p_workspace_id uuid, p_lease_id uuid, p_reason text, p_lease_seconds integer)
 RETURNS TABLE(lease_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '1s'
 SET statement_timeout TO '3s'
AS $function$
declare
  v_now timestamptz:=clock_timestamp();
  v_expires_at timestamptz;
begin
  if p_workspace_id is null or p_lease_id is null
    or p_reason not in ('automatic','manual','pre_restore')
    or p_lease_seconds not between 30 and 3600
  then
    raise exception 'backup lease request is invalid' using errcode='22023';
  end if;

  perform 1 from public.byeollog_workspaces workspace
  where workspace.id=p_workspace_id for update;
  if not found then
    raise exception 'workspace was not found' using errcode='P0002';
  end if;

  delete from public.byeollog_workspace_backup_leases lease
  where lease.workspace_id=p_workspace_id and lease.expires_at<=v_now;
  delete from public.byeollog_account_withdrawal_intents intent
  where intent.expires_at<=v_now;

  if exists(
    select 1 from public.byeollog_account_withdrawal_intents intent
    where intent.workspace_id=p_workspace_id
      and intent.is_workspace_owner
      and intent.expires_at>v_now
  ) then
    raise exception 'account withdrawal is in progress' using errcode='55000';
  end if;
  if exists(
    select 1 from public.byeollog_workspace_backup_leases lease
    where lease.workspace_id=p_workspace_id and lease.expires_at>v_now
  ) then
    raise exception 'workspace backup is already running' using errcode='55P03';
  end if;

  v_expires_at:=v_now+pg_catalog.make_interval(secs=>p_lease_seconds);
  insert into public.byeollog_workspace_backup_leases(
    workspace_id,lease_id,reason,expires_at,created_at,updated_at)
  values(p_workspace_id,p_lease_id,p_reason,v_expires_at,v_now,v_now);
  return query select p_lease_id,v_expires_at;
end
$function$;

CREATE OR REPLACE FUNCTION public.byeollog_backup_retention_inventory_v1()
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
  select coalesce(jsonb_agg(jsonb_build_object('name',name) order by name),'[]'::jsonb)
    from storage.objects where bucket_id='bangsel-backups' and name like '%.json.gz';
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.release_workspace_backup_lease_v1(p_workspace_id uuid, p_lease_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '1s'
 SET statement_timeout TO '3s'
AS $function$
begin
  if p_workspace_id is null or p_lease_id is null then
    raise exception 'backup lease release request is invalid' using errcode='22023';
  end if;
  delete from public.byeollog_workspace_backup_leases
  where workspace_id=p_workspace_id and lease_id=p_lease_id;
  return found;
end
$function$;
