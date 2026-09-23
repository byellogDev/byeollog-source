-- Stale UI revisions are business conflicts, not retryable serialization failures.
-- Preserve data, signatures, permissions and all successful-save behavior.
begin;
set local lock_timeout='1s';
set local statement_timeout='10s';

CREATE OR REPLACE FUNCTION public.save_wallpaper_size_rules_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_expected_revision bigint, p_size_ranges jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '1s'
 SET statement_timeout TO '5s'
AS $function$
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
    raise exception 'wallpaper size revision conflict' using errcode='PT409';
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
$function$
;

CREATE OR REPLACE FUNCTION public.save_wallpaper_visible_keys_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_expected_revision bigint, p_visible_keys text[])
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_revision bigint;v_keys text[];
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0 or p_visible_keys is null
    or cardinality(p_visible_keys)>500
    or exists(select 1 from unnest(p_visible_keys) key where key!~'^(donation|challenge_success|subscription):[1-9][0-9]{0,9}$')
  then raise exception 'wallpaper visible keys request is invalid' using errcode='22023'; end if;
  select coalesce(array_agg(distinct key order by key),'{}'::text[]) into v_keys
  from unnest(p_visible_keys) key;
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper visibility revision conflict' using errcode='PT409'; end if;
  update public.byeollog_wallpaper_overlay_states overlay set
    visible_group_keys=v_keys,hide_below=0,hidden_amounts='{}'::integer[],
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$
;

notify pgrst, 'reload schema';
commit;

