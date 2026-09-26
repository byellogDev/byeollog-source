set lock_timeout='2s';
-- Add a version marker; preserve the existing return type, owner and grants.
create or replace function public.byeollog_backup_retention_inventory_v1()
returns jsonb language sql security invoker set search_path='' set statement_timeout='5s' as $$
 select coalesce(jsonb_agg(jsonb_build_object('name',name,'created_at',created_at,'updated_at',updated_at) order by name),'[]'::jsonb)
 from storage.objects where bucket_id='bangsel-backups' and name like '%.json.gz';
$$;
