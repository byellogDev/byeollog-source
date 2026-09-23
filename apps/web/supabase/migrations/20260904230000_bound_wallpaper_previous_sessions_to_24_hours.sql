-- SOOP-provided images remain available for the complete newest broadcast
-- session, even when that one session lasts longer than 24 hours. Additional
-- closed sessions are a short recovery aid only and expire 24 hours after the
-- session closes. Expiry runs off the donation ingest hot path.

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
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('wallpaper-selection:'||p_workspace_id::text,8311));
  select count(*),count(distinct value) into v_requested,v_matched from unnest(p_session_ids) value;
  if v_requested<>v_matched then raise exception 'wallpaper session selection contains duplicates' using errcode='22023'; end if;
  select count(*) into v_matched
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id=p_workspace_id and session.id=any(p_session_ids)
    and (
      session.state='active'
      or session.id=(
        select newest.id
        from public.byeollog_wallpaper_sessions newest
        where newest.workspace_id=p_workspace_id
        order by newest.started_at desc,newest.id desc
        limit 1)
      or session.closed_at>=clock_timestamp()-interval '24 hours'
    );
  if v_matched<>v_requested then
    raise exception 'wallpaper session is outside the 24-hour recovery window' using errcode='22023';
  end if;
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

create or replace function private.prune_expired_wallpaper_session_selections_v1()
returns integer
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='15s'
as $function$
declare
  v_workspace_id uuid;
  v_deleted integer:=0;
  v_workspace_deleted integer:=0;
begin
  for v_workspace_id in
    select distinct selected.workspace_id
    from public.byeollog_wallpaper_overlay_sessions selected
    join public.byeollog_wallpaper_sessions session
      on session.id=selected.session_id and session.workspace_id=selected.workspace_id
    where session.state<>'active'
      and session.closed_at<clock_timestamp()-interval '24 hours'
      and session.id<>(
        select newest.id
        from public.byeollog_wallpaper_sessions newest
        where newest.workspace_id=selected.workspace_id
        order by newest.started_at desc,newest.id desc
        limit 1)
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('wallpaper-selection:'||v_workspace_id::text,8311));
    delete from public.byeollog_wallpaper_overlay_sessions selected
    using public.byeollog_wallpaper_sessions session
    where selected.workspace_id=v_workspace_id
      and session.id=selected.session_id
      and session.workspace_id=selected.workspace_id
      and session.state<>'active'
      and session.closed_at<clock_timestamp()-interval '24 hours'
      and session.id<>(
        select newest.id
        from public.byeollog_wallpaper_sessions newest
        where newest.workspace_id=v_workspace_id
        order by newest.started_at desc,newest.id desc
        limit 1);
    get diagnostics v_workspace_deleted=row_count;
    if v_workspace_deleted>0 then
      v_deleted:=v_deleted+v_workspace_deleted;
      update public.byeollog_wallpaper_overlay_states overlay set
        revision=overlay.revision+1,updated_at=clock_timestamp()
      where overlay.workspace_id=v_workspace_id;
    end if;
  end loop;
  return v_deleted;
end
$function$;

revoke all on function private.prune_expired_wallpaper_session_selections_v1()
  from public,anon,authenticated,service_role;

comment on function private.prune_expired_wallpaper_session_selections_v1() is
  'Removes selected closed wallpaper sessions 24 hours after close while preserving the newest complete broadcast session.';

select private.prune_expired_wallpaper_session_selections_v1();

do $block$
declare v_job_id bigint;
begin
  for v_job_id in select jobid from cron.job where jobname='byeollog-wallpaper-session-window-v1'
  loop perform cron.unschedule(v_job_id); end loop;
  perform cron.schedule(
    'byeollog-wallpaper-session-window-v1',
    '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
    $job$select private.prune_expired_wallpaper_session_selections_v1()$job$
  );
end
$block$;
