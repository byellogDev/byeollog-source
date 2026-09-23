begin;

set local lock_timeout='2s';
set local statement_timeout='20s';

-- A client can lose the HTTP response after PostgreSQL committed the write.
-- Repeating the exact desired state must therefore return the current
-- revision instead of raising a stale-revision conflict or incrementing it.
create or replace function public.save_wallpaper_size_rules_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,p_size_ranges jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='5s'
as $function$
declare
  v_revision bigint;
  v_ranges jsonb;
  v_current_ranges jsonb;
  v_active_user_id uuid;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0
    or not byeollog_automation.is_valid_wallpaper_size_ranges_v1(p_size_ranges)
  then raise exception 'wallpaper size rules are invalid' using errcode='22023'; end if;

  select coalesce(jsonb_agg(item.value order by (item.value->>'min')::integer,(item.value->>'max')::integer),'[]'::jsonb)
  into v_ranges from jsonb_array_elements(p_size_ranges) item(value);

  select overlay.revision,overlay.size_ranges,overlay.active_settings_user_id
  into v_revision,v_current_ranges,v_active_user_id
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id
  for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;

  if coalesce(v_current_ranges,'[]'::jsonb)=v_ranges
    and v_active_user_id is not distinct from p_authorized_user_id
  then return v_revision; end if;
  if v_revision<>p_expected_revision then
    raise exception 'wallpaper size revision conflict' using errcode='40001';
  end if;

  insert into public.byeollog_wallpaper_user_settings(workspace_id,user_id,size_ranges,updated_at)
  values(p_workspace_id,p_authorized_user_id,v_ranges,clock_timestamp())
  on conflict(workspace_id,user_id) do update set
    size_ranges=excluded.size_ranges,updated_at=excluded.updated_at;
  update public.byeollog_wallpaper_overlay_states overlay set
    size_ranges=v_ranges,active_settings_user_id=p_authorized_user_id,
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id
  returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_size_rules_v1(uuid,uuid,bigint,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_size_rules_v1(uuid,uuid,bigint,jsonb)
  to service_role;

create or replace function public.select_wallpaper_sessions_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_session_ids uuid[])
returns bigint
language plpgsql
security definer
set search_path=''
set lock_timeout='1s'
set statement_timeout='5s'
as $function$
declare
  v_revision bigint;
  v_requested integer;
  v_matched integer;
  v_current_ids uuid[];
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
  select overlay.revision into v_revision
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id
  for update;
  select coalesce(array_agg(selected.session_id order by selected.position,selected.selected_at),array[]::uuid[])
  into v_current_ids
  from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id=p_workspace_id;
  if v_current_ids=p_session_ids then return v_revision; end if;

  delete from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id=p_workspace_id;
  insert into public.byeollog_wallpaper_overlay_sessions(workspace_id,session_id,position)
  select p_workspace_id,value,ordinality::integer-1
  from unnest(p_session_ids) with ordinality item(value,ordinality);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id
  returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.select_wallpaper_sessions_v1(uuid,uuid,uuid[])
  from public,anon,authenticated,service_role;
grant execute on function public.select_wallpaper_sessions_v1(uuid,uuid,uuid[])
  to service_role;

notify pgrst,'reload schema';

commit;


