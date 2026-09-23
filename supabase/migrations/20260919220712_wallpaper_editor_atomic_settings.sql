-- Additive Agent editor transaction support. No data rewrite or retention change.
CREATE OR REPLACE FUNCTION public.save_wallpaper_merge_rules_v1(p_workspace_id uuid, p_authorized_user_id uuid, p_expected_revision bigint, p_merge_ranges jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare v_revision bigint;v_ranges jsonb;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  if p_expected_revision is null or p_expected_revision<0
    or not byeollog_automation.is_valid_wallpaper_merge_ranges_v1(p_merge_ranges)
  then raise exception 'wallpaper merge rules are invalid' using errcode='22023'; end if;
  select coalesce(jsonb_agg(item.value order by (item.value->>'min')::integer,(item.value->>'max')::integer),'[]'::jsonb)
  into v_ranges from jsonb_array_elements(p_merge_ranges) item(value);
  select overlay.revision into v_revision
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if exists(select 1 from public.byeollog_wallpaper_overlay_states o
    join public.byeollog_wallpaper_user_settings s on s.workspace_id=o.workspace_id and s.user_id=p_authorized_user_id
    where o.workspace_id=p_workspace_id and o.active_settings_user_id=p_authorized_user_id
      and o.merge_ranges=v_ranges and s.merge_ranges=v_ranges) then return v_revision; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper merge revision conflict' using errcode='PT409'; end if;
  insert into public.byeollog_wallpaper_user_settings(workspace_id,user_id,merge_ranges,updated_at)
  values(p_workspace_id,p_authorized_user_id,v_ranges,clock_timestamp())
  on conflict(workspace_id,user_id) do update set
    merge_ranges=excluded.merge_ranges,updated_at=excluded.updated_at;
  update public.byeollog_wallpaper_overlay_states overlay set
    merge_ranges=v_ranges,active_settings_user_id=p_authorized_user_id,
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$
;

CREATE OR REPLACE FUNCTION public.save_wallpaper_size_and_layout_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint,
  p_size_ranges jsonb,p_protocol integer,p_tiles jsonb)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s'
AS $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  select revision into v_revision from public.byeollog_wallpaper_overlay_states
    where workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if p_expected_revision is null or p_expected_revision<>v_revision then
    raise exception 'wallpaper settings revision conflict' using errcode='PT409';
  end if;
  v_revision:=public.save_wallpaper_size_rules_v1(p_workspace_id,p_authorized_user_id,p_expected_revision,p_size_ranges);
  -- Both calls share one transaction and row lock. Invalid geometry/foreign cards
  -- roll back the rule change as well. Legacy RPC signatures remain unchanged.
  return public.save_wallpaper_overlay_layout_v4(p_workspace_id,p_authorized_user_id,v_revision,p_protocol,p_tiles);
end
$function$;
REVOKE ALL ON FUNCTION public.save_wallpaper_size_and_layout_v1(uuid,uuid,bigint,jsonb,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_wallpaper_size_and_layout_v1(uuid,uuid,bigint,jsonb,integer,jsonb) TO service_role;

-- A single MVCC statement captures the edit revision, selection, rules and cards.
-- Ordering and 50/20/216 limits match the previous REST reconstruction exactly.
CREATE OR REPLACE FUNCTION public.read_wallpaper_editor_snapshot_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_limit integer DEFAULT 216)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s'
AS $function$
declare v_result jsonb;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,false);
  with sessions as materialized (
    select id,label,state,canvas_width,canvas_height,revision,tile_count,started_at,closed_at,updated_at
    from public.byeollog_wallpaper_sessions where workspace_id=p_workspace_id order by started_at desc limit 50
  ), selection as materialized (
    select session_id,position,selected_at from public.byeollog_wallpaper_overlay_sessions
    where workspace_id=p_workspace_id order by position asc,selected_at asc limit 20
  ), cards as (
    select id,sequence_no,session_id,actor_name,amount,display_kind,asset_source,asset,received_at,
      layout_x,layout_y,layout_width,layout_height,layout_columns,layout_rows,layout_next_side,layout_layer
    from public.byeollog_wallpaper_tiles
    where workspace_id=p_workspace_id and session_id in(select session_id from selection where session_id in(select id from sessions))
    order by received_at desc,sequence_no desc limit greatest(1,least(coalesce(p_limit,216),216))
  )
  select jsonb_build_object(
    'sessions',coalesce((select jsonb_agg(to_jsonb(s) order by s.started_at desc) from sessions s),'[]'::jsonb),
    'selections',coalesce((select jsonb_agg(to_jsonb(s) order by s.position,s.selected_at) from selection s),'[]'::jsonb),
    'overlays',coalesce((select jsonb_agg(to_jsonb(o)) from (
      select revision,visible_group_keys,merge_ranges,size_ranges,active_settings_user_id,updated_at
      from public.byeollog_wallpaper_overlay_states where workspace_id=p_workspace_id limit 1) o),'[]'::jsonb),
    'gateway',coalesce((select jsonb_agg(to_jsonb(g)) from (
      select state,chat_number,heartbeat_at,connected_at,last_event_at
      from public.byeollog_soop_gateway_sessions where workspace_id=p_workspace_id limit 1) g),'[]'::jsonb),
    'settings',coalesce((select jsonb_agg(to_jsonb(u)) from (
      select merge_ranges,size_ranges,updated_at from public.byeollog_wallpaper_user_settings
      where workspace_id=p_workspace_id and user_id=p_authorized_user_id limit 1) u),'[]'::jsonb),
    'tiles',coalesce((select jsonb_agg(to_jsonb(c) order by c.received_at desc,c.sequence_no desc) from cards c),'[]'::jsonb)
  ) into v_result;
  return v_result;
end
$function$;
REVOKE ALL ON FUNCTION public.read_wallpaper_editor_snapshot_v1(uuid,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_wallpaper_editor_snapshot_v1(uuid,uuid,integer) TO service_role;


