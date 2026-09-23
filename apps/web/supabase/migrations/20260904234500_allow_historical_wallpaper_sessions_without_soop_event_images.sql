-- Historical wallpaper rounds remain user-selectable. SOOP event image URLs
-- are suppressed by the application outside the current broadcast round.

create or replace function public.select_wallpaper_sessions_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_session_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;v_requested integer;v_matched integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_session_ids is null or cardinality(p_session_ids)>20
  then raise exception 'wallpaper session selection is invalid' using errcode='22023'; end if;
  select count(*),count(distinct value) into v_requested,v_matched from unnest(p_session_ids) value;
  if v_requested<>v_matched then raise exception 'wallpaper session selection contains duplicates' using errcode='22023'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-selection:'||p_workspace_id::text,8311));
  select count(*) into v_matched
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.id=any(p_session_ids);
  if v_matched<>v_requested then raise exception 'wallpaper session selection was not found' using errcode='22023'; end if;
  insert into public.byeollog_wallpaper_overlay_states(workspace_id)
  values(p_workspace_id) on conflict(workspace_id) do nothing;
  delete from public.byeollog_wallpaper_overlay_sessions selected where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  select p_workspace_id,value,ordinality::integer-1 from unnest(p_session_ids) with ordinality item(value,ordinality);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.select_wallpaper_sessions_v1(uuid,uuid,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.select_wallpaper_sessions_v1(uuid,uuid,uuid[])
  to service_role;

do $block$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='byeollog-wallpaper-session-window-v1'
  loop perform cron.unschedule(v_job_id); end loop;
end
$block$;

drop function if exists private.prune_expired_wallpaper_session_selections_v1();
