-- Preserve administrator suspension during OAuth completion. No row or grant changes.
CREATE OR REPLACE FUNCTION public.byeollog_complete_game_link(p_session_token_hash text, p_microsoft_state_hash text, p_minecraft_uuid text, p_minecraft_name text, p_entitlement_count integer DEFAULT 0)
 RETURNS TABLE(id uuid, soop_user_id text, minecraft_uuid text, minecraft_name text, byeollog_user_id uuid, workspace_id uuid, status text, linked_at timestamp with time zone, verified_at timestamp with time zone, updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_session public.byeollog_game_link_sessions%rowtype;
  v_binding public.byeollog_game_identity_bindings%rowtype;
  v_byeollog_user_id uuid;
  v_workspace_id uuid;
  v_now timestamptz := clock_timestamp();
begin
  if p_session_token_hash !~ '^[a-f0-9]{64}$'
     or p_microsoft_state_hash !~ '^[a-f0-9]{64}$'
     or p_minecraft_uuid !~ '^[a-f0-9]{32}$'
     or p_minecraft_name !~ '^[A-Za-z0-9_]{3,16}$' then
    raise exception using message = 'game_link_input_invalid';
  end if;

  select s.* into v_session
  from public.byeollog_game_link_sessions s
  where s.browser_token_hash = p_session_token_hash
  for update;

  if not found then
    raise exception using message = 'game_link_session_not_found';
  end if;
  if v_session.status <> 'microsoft_pending' or v_session.expires_at <= v_now then
    raise exception using message = 'game_link_session_expired_or_invalid';
  end if;
  if v_session.microsoft_oauth_state_hash is distinct from p_microsoft_state_hash then
    raise exception using message = 'microsoft_oauth_state_invalid';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('soop:' || v_session.soop_user_id, 0));
  perform pg_advisory_xact_lock(hashtextextended('minecraft:' || p_minecraft_uuid, 0));

  select b.* into v_binding
  from public.byeollog_game_identity_bindings b
  where b.soop_user_id = v_session.soop_user_id
  for update;

  if found and v_binding.status = 'suspended' then
    raise exception using message = 'game_link_suspended';
  end if;

  if found and v_binding.minecraft_uuid <> p_minecraft_uuid then
    raise exception using message = 'game_link_soop_conflict';
  end if;

  if not found then
    select b.* into v_binding
    from public.byeollog_game_identity_bindings b
    where b.minecraft_uuid = p_minecraft_uuid
    for update;

    if found and v_binding.status = 'suspended' then
      raise exception using message = 'game_link_suspended';
    end if;

    if found and v_binding.soop_user_id <> v_session.soop_user_id then
      raise exception using message = 'game_link_minecraft_conflict';
    end if;
  end if;

  -- A person may link a game before or after joining Byeollog. SOOP is the
  -- canonical anchor, so an existing active workspace is attached here and a
  -- later workspace creation is handled by the trigger below.
  select w.owner_user_id, w.id
  into v_byeollog_user_id, v_workspace_id
  from public.byeollog_workspaces w
  where lower(btrim(w.soop_id)) = v_session.soop_user_id
    and w.status = 'active'
    and w.owner_user_id is not null
  limit 1;

  if v_binding.id is null then
    insert into public.byeollog_game_identity_bindings (
      soop_user_id, minecraft_uuid, minecraft_name, byeollog_user_id, workspace_id,
      status, linked_at, verified_at, updated_at
    ) values (
      v_session.soop_user_id, p_minecraft_uuid, p_minecraft_name,
      v_byeollog_user_id, v_workspace_id, 'active', v_now, v_now, v_now
    ) returning * into v_binding;
  else
    update public.byeollog_game_identity_bindings b
    set minecraft_name = p_minecraft_name,
        byeollog_user_id = coalesce(v_byeollog_user_id, b.byeollog_user_id),
        workspace_id = coalesce(v_workspace_id, b.workspace_id),
        status = 'active',
        verified_at = v_now,
        updated_at = v_now
    where b.id = v_binding.id
    returning * into v_binding;
  end if;

  update public.byeollog_game_link_sessions s
  set status = 'completed',
      microsoft_oauth_state_hash = null,
      pkce_verifier_ciphertext = null,
      completed_at = v_now,
      updated_at = v_now
  where s.id = v_session.id;

  insert into public.byeollog_game_identity_audit (
    event_type, binding_id, soop_user_id, minecraft_uuid, details, created_at
  ) values (
    'game_link_completed',
    v_binding.id,
    v_binding.soop_user_id,
    v_binding.minecraft_uuid,
    jsonb_build_object(
      'minecraft_name', v_binding.minecraft_name,
      'entitlement_count', greatest(coalesce(p_entitlement_count, 0), 0)
    ),
    v_now
  );

  return query
  select b.id, b.soop_user_id, b.minecraft_uuid, b.minecraft_name,
         b.byeollog_user_id, b.workspace_id,
         b.status, b.linked_at, b.verified_at, b.updated_at
  from public.byeollog_game_identity_bindings b
  where b.id = v_binding.id;
end;
$function$;
