create or replace function private.run_wallpaper_retention_v1(p_batch_limit integer default 500)
returns jsonb language plpgsql security invoker set search_path=''
set lock_timeout='200ms' set statement_timeout='5s' as $$
declare cutoff timestamptz:=statement_timestamp()-interval '7 days';n integer;sn integer;
  touched uuid[];workspaces uuid[];extra uuid[];limit_rows integer;
begin
  if p_batch_limit is null or p_batch_limit<1 or p_batch_limit>2000 then raise exception 'invalid batch limit' using errcode='22023';end if;
  limit_rows:=p_batch_limit;
  if not pg_try_advisory_xact_lock(hashtextextended('byeollog:wallpaper-retention:v1',0)) then return jsonb_build_object('skipped',true);end if;
  with candidates as (
    select t.id from public.byeollog_wallpaper_tiles t
    where t.received_at<cutoff order by t.received_at,t.id limit limit_rows for update skip locked
  ), removed as (
    delete from public.byeollog_wallpaper_tiles t using candidates c where t.id=c.id
    returning t.session_id,t.workspace_id
  ) select count(*)::integer,array_agg(distinct session_id),array_agg(distinct workspace_id) into n,touched,workspaces from removed;
  update public.byeollog_wallpaper_sessions s set tile_count=(select count(*) from public.byeollog_wallpaper_tiles t where t.session_id=s.id),revision=s.revision+1
    where s.id=any(touched);
  with candidates as (
    select s.id from public.byeollog_wallpaper_sessions s where s.state='closed' and s.closed_at<cutoff
      and not exists(select 1 from public.byeollog_wallpaper_tiles t where t.session_id=s.id)
    order by s.closed_at,s.id limit limit_rows for update skip locked
  ), removed as (
    delete from public.byeollog_wallpaper_sessions s using candidates c where s.id=c.id returning s.workspace_id
  ) select count(*)::integer,array_agg(distinct workspace_id) into sn,extra from removed;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id,revision,updated_at)
    select id,1,statement_timestamp() from (select distinct id from unnest(coalesce(workspaces,'{}'::uuid[])||coalesce(extra,'{}'::uuid[])) id) unique_workspaces
    on conflict(workspace_id) do update set revision=public.byeollog_wallpaper_overlay_states.revision+1,updated_at=excluded.updated_at;
  return jsonb_build_object('tilesDeleted',n,'sessionsDeleted',sn,'cutoff',cutoff);
end $$;
