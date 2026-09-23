-- Change-triggered wallpaper snapshots for the existing localhost Agent overlay.
-- The RPC is service-role only and authenticates the exact Agent device before
-- returning any workspace data.  When the revision did not change it touches
-- only the overlay-state row and returns a tiny acknowledgement.

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
    p_workspace_id,
    p_device_id,
    p_device_secret_hash,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  select overlay.revision,
    jsonb_build_object(
      'visibleGroupKeys', overlay.visible_group_keys,
      'mergeRanges', overlay.merge_ranges,
      'updatedAt', overlay.updated_at
    )
  into v_revision, v_overlay
  from public.byeollog_wallpaper_overlay_states overlay
  where overlay.workspace_id = p_workspace_id;

  if not found then
    v_revision := 0;
    v_overlay := jsonb_build_object(
      'visibleGroupKeys', '[]'::jsonb,
      'mergeRanges', '[]'::jsonb,
      'updatedAt', null
    );
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
    'layoutNextSide', tile.layout_next_side
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
        and (value->>'amount')::bigint <= 30000
    );

  select service.activation_snapshot
  into v_activation_snapshot
  from public.byeollog_native_roulette_services service
  where service.workspace_id = p_workspace_id and service.state = 'active'
  limit 1;

  select jsonb_build_object(
    'state', gateway.state,
    'chatNumber', gateway.chat_number,
    'heartbeatAt', gateway.heartbeat_at
  )
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
    'gateway', v_gateway
  );
end
$function$;

revoke execute on function public.g3a_get_wallpaper_snapshot_v1(
  uuid,bigint,uuid,text,uuid,uuid,text,text,text
) from public, anon, authenticated;
grant execute on function public.g3a_get_wallpaper_snapshot_v1(
  uuid,bigint,uuid,text,uuid,uuid,text,text,text
) to service_role;

comment on function public.g3a_get_wallpaper_snapshot_v1(uuid,bigint,uuid,text,uuid,uuid,text,text,text)
  is 'Device-authenticated, change-triggered raw wallpaper snapshot for the existing localhost Agent overlay.';


