-- Additive: no existing worker, customer session, or service-role privilege changes.
set lock_timeout='2s';
create role byeollog_backup_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
grant byeollog_backup_reader to postgres;
create schema byeollog_worker_security;
revoke all on schema byeollog_worker_security from public,anon;
grant usage on schema byeollog_worker_security to authenticated,byeollog_backup_reader;
create table byeollog_worker_security.accounts(user_id uuid primary key references auth.users(id) on delete cascade,kind text not null check(kind in ('backup')),enabled boolean not null default true);
alter table byeollog_worker_security.accounts enable row level security;
revoke all on byeollog_worker_security.accounts from public,anon,authenticated,service_role,byeollog_backup_reader;

create function byeollog_worker_security.authorized(p_kind text) returns boolean
language sql stable security definer set search_path='' as $$
 select auth.uid() is not null and exists(
  select 1 from byeollog_worker_security.accounts a join auth.sessions s on s.user_id=a.user_id
  where a.user_id=(select auth.uid()) and a.enabled and a.kind=p_kind
    and s.id::text=(select auth.jwt()->>'session_id')
 );
$$;
revoke all on function byeollog_worker_security.authorized(text) from public,anon,service_role;
grant execute on function byeollog_worker_security.authorized(text) to authenticated,byeollog_backup_reader;
grant usage on schema public,storage to byeollog_backup_reader;
grant select(id,slug,status) on public.byeollog_workspaces to byeollog_backup_reader,authenticated;
create policy backup_reader_workspaces on public.byeollog_workspaces for select to byeollog_backup_reader using(status='active');
create policy backup_machine_workspaces on public.byeollog_workspaces for select to authenticated using(status='active' and (select byeollog_worker_security.authorized('backup')));

do $$ declare t text; begin
 foreach t in array array['byeollog_reverse_fan_days','byeollog_soop_core_donations','bangsel_fans','bangsel_fan_stations','bangsel_roulette_rules','bangsel_tasks','bangsel_donations','bangsel_task_import_items','bangsel_collector_staging','bangsel_roulette_invalidations','byeollog_workspace_settings','byeollog_signature_balloons','byeollog_default_donation_images','byeollog_fixed_upbo_rules','byeollog_roulette_classification_rules','byeollog_roulette_amount_mappings','byeollog_special_roulette_rules','byeollog_wallpaper_sessions','byeollog_wallpaper_tiles','byeollog_wallpaper_user_settings','byeollog_wallpaper_overlay_states','byeollog_credit_ledger'] loop
  execute format('grant select on public.%I to byeollog_backup_reader',t);
  execute format('create policy isolated_backup_read on public.%I for select to byeollog_backup_reader using(workspace_id in (select id from public.byeollog_workspaces where status=''active''))',t);
 end loop;
end $$;

grant select on storage.objects to byeollog_backup_reader;
create policy backup_reader_objects on storage.objects for select to byeollog_backup_reader using(bucket_id='bangsel-backups');
-- Storage access is limited to the existing backup bucket; other buckets stay denied.
grant select on storage.buckets to authenticated;
create policy backup_machine_bucket on storage.buckets for select to authenticated using(id='bangsel-backups' and (select byeollog_worker_security.authorized('backup')));
create policy backup_machine_objects on storage.objects for all to authenticated
 using(bucket_id='bangsel-backups' and (select byeollog_worker_security.authorized('backup')))
 with check(bucket_id='bangsel-backups' and (select byeollog_worker_security.authorized('backup')));
grant execute on function public.byeollog_export_backup_v10(uuid),public.begin_workspace_backup_v1(uuid,uuid,text,integer),public.release_workspace_backup_lease_v1(uuid,uuid),public.byeollog_backup_retention_inventory_v1() to byeollog_backup_reader;

create function byeollog_worker_security.backup_gateway(p_operation text,p_args jsonb) returns jsonb
language plpgsql security definer set search_path='' set statement_timeout='30s' set lock_timeout='2s' as $$
declare result jsonb;
begin
 if not byeollog_worker_security.authorized('backup') then raise exception 'Unauthorized backup worker' using errcode='42501';end if;
 if p_args is null or jsonb_typeof(p_args)<>'object' or pg_column_size(p_args)>2048 then raise exception 'Invalid backup request' using errcode='22023';end if;
 case p_operation
 when 'probe' then return 'true'::jsonb;
 when 'export' then return public.byeollog_export_backup_v10((p_args->>'p_workspace_id')::uuid);
 when 'begin' then
  if p_args->>'p_reason' not in ('automatic','manual') then raise exception 'Backup worker cannot restore' using errcode='42501';end if;
  select jsonb_agg(to_jsonb(r)) into result from public.begin_workspace_backup_v1((p_args->>'p_workspace_id')::uuid,(p_args->>'p_lease_id')::uuid,p_args->>'p_reason',(p_args->>'p_lease_seconds')::integer) r;
  return result;
 when 'release' then return to_jsonb(public.release_workspace_backup_lease_v1((p_args->>'p_workspace_id')::uuid,(p_args->>'p_lease_id')::uuid));
 when 'inventory' then return public.byeollog_backup_retention_inventory_v1();
 else raise exception 'Unknown backup operation' using errcode='22023';
 end case;
end $$;
grant create on schema byeollog_worker_security to byeollog_backup_reader;
alter function byeollog_worker_security.backup_gateway(text,jsonb) owner to byeollog_backup_reader;
revoke create on schema byeollog_worker_security from byeollog_backup_reader;
revoke all on function byeollog_worker_security.backup_gateway(text,jsonb) from public,anon,service_role;
grant execute on function byeollog_worker_security.backup_gateway(text,jsonb) to authenticated;
create function public.byeollog_backup_worker_v1(p_operation text,p_args jsonb) returns jsonb
language sql security invoker set search_path='' as $$ select byeollog_worker_security.backup_gateway(p_operation,p_args); $$;
revoke all on function public.byeollog_backup_worker_v1(text,jsonb) from public,anon,service_role;
grant execute on function public.byeollog_backup_worker_v1(text,jsonb) to authenticated;
notify pgrst,'reload schema';
