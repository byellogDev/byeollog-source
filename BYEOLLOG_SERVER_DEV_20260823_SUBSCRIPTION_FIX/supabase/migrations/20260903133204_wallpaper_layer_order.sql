alter table public.byeollog_wallpaper_tiles
  add column if not exists layout_layer integer;

alter table public.byeollog_wallpaper_tiles
  drop constraint if exists byeollog_wallpaper_tiles_layout_layer_check;

alter table public.byeollog_wallpaper_tiles
  add constraint byeollog_wallpaper_tiles_layout_layer_check
  check (layout_layer is null or layout_layer between 1 and 216);

create or replace function public.save_wallpaper_overlay_layout_v4(
  p_workspace_id uuid,
  p_authorized_user_id uuid,
  p_expected_revision bigint,
  p_protocol integer,
  p_tiles jsonb)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_revision bigint;
  v_tile_count integer;
  v_matched_count integer;
  v_same_count integer;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(
    p_workspace_id,p_authorized_user_id,true);
  if p_protocol<>3
    or p_expected_revision is null or p_expected_revision<0
    or p_tiles is null or jsonb_typeof(p_tiles)<>'array'
    or jsonb_array_length(p_tiles)>216
  then
    raise exception 'wallpaper layout request is invalid' using errcode='22023';
  end if;

  select overlay.revision into v_revision
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id
  for update;
  if not found then
    raise exception 'wallpaper overlay was not found' using errcode='P0002';
  end if;

  select count(*) into v_tile_count from jsonb_array_elements(p_tiles);
  if exists(
    select 1 from jsonb_array_elements(p_tiles) item
    where jsonb_typeof(item)<>'object'
      or jsonb_typeof(item->'id')<>'string'
      or (item->>'x')!~'^[0-9]+$' or (item->>'y')!~'^[0-9]+$'
      or (item->>'width')!~'^[0-9]+$' or (item->>'height')!~'^[0-9]+$'
      or (item->>'columns')!~'^[0-9]+$' or (item->>'rows')!~'^[0-9]+$'
      or not (item ? 'layer') or (item->>'layer')!~'^[0-9]+$'
      or jsonb_typeof(item->'next_side')<>'string'
      or (item->>'next_side') not in ('left','right'))
  then
    raise exception 'wallpaper tile layout is invalid' using errcode='22023';
  end if;
  if exists(
    select 1
    from jsonb_to_recordset(p_tiles)
      tile(id uuid,x integer,y integer,width integer,height integer,
        columns integer,rows integer,next_side text,layer integer)
    where tile.x<0 or tile.y<0 or tile.width<80 or tile.height<60
      or tile.x+tile.width>1920 or tile.y+tile.height>1080
      or tile.columns not between 1 and 217
      or tile.rows not between 1 and 216
      or tile.layer not between 1 and 216
      or tile.next_side not in ('left','right'))
  then
    raise exception 'wallpaper tile layout is out of bounds' using errcode='22023';
  end if;
  if (
    select count(distinct tile.id)
    from jsonb_to_recordset(p_tiles)
      tile(id uuid,x integer,y integer,width integer,height integer,
        columns integer,rows integer,next_side text,layer integer)
  )<>v_tile_count then
    raise exception 'wallpaper layout contains duplicate tiles' using errcode='22023';
  end if;

  select count(*) into v_matched_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles)
    tile(id uuid,x integer,y integer,width integer,height integer,
      columns integer,rows integer,next_side text,layer integer)
    on tile.id=stored.id
  join public.byeollog_wallpaper_overlay_sessions selected
    on selected.workspace_id=stored.workspace_id
    and selected.session_id=stored.session_id
  where stored.workspace_id=p_workspace_id;
  if v_matched_count<>v_tile_count then
    raise exception 'wallpaper tile is not selected' using errcode='22023';
  end if;

  select count(*) into v_same_count
  from public.byeollog_wallpaper_tiles stored
  join jsonb_to_recordset(p_tiles)
    tile(id uuid,x integer,y integer,width integer,height integer,
      columns integer,rows integer,next_side text,layer integer)
    on tile.id=stored.id
  where stored.workspace_id=p_workspace_id
    and stored.layout_x is not distinct from tile.x
    and stored.layout_y is not distinct from tile.y
    and stored.layout_width is not distinct from tile.width
    and stored.layout_height is not distinct from tile.height
    and stored.layout_columns is not distinct from tile.columns
    and stored.layout_rows is not distinct from tile.rows
    and stored.layout_next_side is not distinct from tile.next_side
    and stored.layout_layer is not distinct from tile.layer;
  if v_same_count=v_tile_count then
    return v_revision;
  end if;

  if v_revision<>p_expected_revision then
    raise exception 'wallpaper layout revision conflict' using errcode='40001';
  end if;

  update public.byeollog_wallpaper_tiles stored set
    layout_x=tile.x,
    layout_y=tile.y,
    layout_width=tile.width,
    layout_height=tile.height,
    layout_columns=tile.columns,
    layout_rows=tile.rows,
    layout_next_side=tile.next_side,
    layout_layer=tile.layer,
    layout_updated_at=clock_timestamp()
  from jsonb_to_recordset(p_tiles)
    tile(id uuid,x integer,y integer,width integer,height integer,
      columns integer,rows integer,next_side text,layer integer)
  where stored.id=tile.id
    and stored.workspace_id=p_workspace_id
    and (stored.layout_x,stored.layout_y,stored.layout_width,stored.layout_height,
      stored.layout_columns,stored.layout_rows,stored.layout_next_side,stored.layout_layer)
      is distinct from
      (tile.x,tile.y,tile.width,tile.height,tile.columns,tile.rows,tile.next_side,tile.layer);

  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,
    updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id
  returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.save_wallpaper_overlay_layout_v4(
  uuid,uuid,bigint,integer,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.save_wallpaper_overlay_layout_v4(
  uuid,uuid,bigint,integer,jsonb) to service_role;

create or replace function public.clear_wallpaper_overlay_layout_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_expected_revision bigint)
returns bigint
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_revision bigint;
begin
  perform byeollog_automation.assert_native_roulette_member_v1(p_workspace_id,p_authorized_user_id,true);
  select overlay.revision into v_revision from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id=p_workspace_id for update;
  if not found then raise exception 'wallpaper overlay was not found' using errcode='P0002'; end if;
  if v_revision<>p_expected_revision then raise exception 'wallpaper layout revision conflict' using errcode='40001'; end if;
  update public.byeollog_wallpaper_tiles stored set
    layout_x=null,layout_y=null,layout_width=null,layout_height=null,
    layout_columns=null,layout_rows=null,layout_next_side=null,layout_layer=null,layout_updated_at=null
  where stored.workspace_id=p_workspace_id
    and (stored.layout_x is not null or stored.layout_layer is not null)
    and exists(
      select 1 from public.byeollog_wallpaper_overlay_sessions selected
      where selected.workspace_id=p_workspace_id and selected.session_id=stored.session_id);
  update public.byeollog_wallpaper_overlay_states overlay set
    revision=overlay.revision+1,updated_at=clock_timestamp()
  where overlay.workspace_id=p_workspace_id returning overlay.revision into v_revision;
  return v_revision;
end
$function$;

revoke all on function public.clear_wallpaper_overlay_layout_v1(uuid,uuid,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.clear_wallpaper_overlay_layout_v1(uuid,uuid,bigint)
  to service_role;

create or replace function public.g3a_get_wallpaper_snapshot_v1(
  p_workspace_id uuid,
  p_known_revision bigint,
  p_device_id uuid,
  p_device_secret_hash text,
  p_authorized_user_id uuid,
  p_session_id uuid,
  p_runtime_component text,
  p_runtime_revision text,
  p_db_revision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_revision bigint := 0;
  v_overlay jsonb;
  v_selected_session_ids uuid[] := '{}'::uuid[];
  v_sessions jsonb := '[]'::jsonb;
  v_tiles jsonb := '[]'::jsonb;
  v_signatures jsonb := '[]'::jsonb;
  v_activation_snapshot jsonb;
  v_gateway jsonb;
begin
  if p_known_revision is null or p_known_revision < -1 then
    raise exception 'wallpaper revision is invalid' using errcode = '22023';
  end if;

  perform public.g3a_authenticate_agent_device_v1(
    p_workspace_id,p_device_id,p_device_secret_hash,p_authorized_user_id,
    p_session_id,p_runtime_component,p_runtime_revision,p_db_revision);

  select overlay.revision,
    jsonb_build_object(
      'visibleGroupKeys', overlay.visible_group_keys,
      'mergeRanges', overlay.merge_ranges,
      'updatedAt', overlay.updated_at)
  into v_revision, v_overlay
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id = p_workspace_id;

  if not found then
    v_revision := 0;
    v_overlay := jsonb_build_object(
      'visibleGroupKeys', '[]'::jsonb,
      'mergeRanges', '[]'::jsonb,
      'updatedAt', null);
  end if;

  if p_known_revision = v_revision then
    return jsonb_build_object('changed', false, 'revision', v_revision);
  end if;

  select coalesce(array_agg(selected.session_id order by selected.position, selected.selected_at), '{}'::uuid[])
  into v_selected_session_ids
  from public.byeollog_wallpaper_overlay_sessions selected
  where selected.workspace_id = p_workspace_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', session.id,
    'state', session.state,
    'canvasWidth', session.canvas_width,
    'canvasHeight', session.canvas_height,
    'startedAt', session.started_at,
    'closedAt', session.closed_at,
    'updatedAt', session.updated_at
  ) order by session.started_at), '[]'::jsonb)
  into v_sessions
  from public.byeollog_wallpaper_sessions session
  where session.workspace_id = p_workspace_id
    and session.id = any(v_selected_session_ids);

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', tile.id,
    'sequenceNo', tile.sequence_no,
    'sessionId', tile.session_id,
    'actorName', tile.actor_name,
    'amount', tile.amount,
    'displayKind', tile.display_kind,
    'assetSource', tile.asset_source,
    'asset', tile.asset,
    'receivedAt', tile.received_at,
    'layoutX', tile.layout_x,
    'layoutY', tile.layout_y,
    'layoutWidth', tile.layout_width,
    'layoutHeight', tile.layout_height,
    'layoutColumns', tile.layout_columns,
    'layoutRows', tile.layout_rows,
    'layoutNextSide', tile.layout_next_side,
    'layoutLayer', tile.layout_layer
  ) order by tile.received_at, tile.sequence_no), '[]'::jsonb)
  into v_tiles
  from (
    select stored.*
    from public.byeollog_wallpaper_tiles stored
    where stored.workspace_id = p_workspace_id
      and stored.session_id = any(v_selected_session_ids)
    order by stored.received_at desc, stored.sequence_no desc
    limit 216
  ) tile;

  select coalesce(jsonb_agg(jsonb_build_object(
    'amount', signature.balloon_count,
    'asset', signature.wallpaper_image,
    'updatedAt', signature.updated_at
  )), '[]'::jsonb)
  into v_signatures
  from public.byeollog_signature_balloons signature
  where signature.workspace_id = p_workspace_id
    and signature.wallpaper_image is not null
    and signature.balloon_count in (
      select distinct (value->>'amount')::integer
      from jsonb_array_elements(v_tiles) value
      where (value->>'displayKind') = 'donation'
        and (value->>'amount') ~ '^[1-9][0-9]{0,8}$'
        and (value->>'amount')::bigint <= 30000);

  select service.activation_snapshot
  into v_activation_snapshot
  from public.byeollog_native_roulette_services service
  where service.workspace_id = p_workspace_id and service.state = 'active'
  limit 1;

  select jsonb_build_object(
    'state', gateway.state,
    'chatNumber', gateway.chat_number,
    'heartbeatAt', gateway.heartbeat_at)
  into v_gateway
  from public.byeollog_soop_gateway_sessions gateway
  where gateway.workspace_id = p_workspace_id
  limit 1;

  return jsonb_build_object(
    'changed', true,
    'revision', v_revision,
    'overlay', v_overlay,
    'selectedSessionIds', to_jsonb(v_selected_session_ids),
    'sessions', v_sessions,
    'tiles', v_tiles,
    'signatures', v_signatures,
    'activationSnapshot', v_activation_snapshot,
    'gateway', v_gateway);
end
$function$;

revoke execute on function public.g3a_get_wallpaper_snapshot_v1(
  uuid,bigint,uuid,text,uuid,uuid,text,text,text
) from public, anon, authenticated;
grant execute on function public.g3a_get_wallpaper_snapshot_v1(
  uuid,bigint,uuid,text,uuid,uuid,text,text,text
) to service_role;

comment on column public.byeollog_wallpaper_tiles.layout_layer
  is 'User-controlled group stacking order; larger values render above smaller values.';
