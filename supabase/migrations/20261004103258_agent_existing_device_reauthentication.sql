-- Preserve the existing runtime/session/role gates, device secret checks and ACL.
CREATE OR REPLACE FUNCTION public.g3a_register_agent_device_v1(p_workspace_id uuid, p_device_id uuid, p_device_name text, p_device_secret_hash text, p_authorized_user_id uuid, p_session_id uuid, p_authenticated_at bigint, p_authentication_method text, p_runtime_component text, p_runtime_revision text, p_db_revision text)
 RETURNS TABLE(created boolean, registered_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET statement_timeout TO '5s'
AS $function$
declare
  v_now timestamptz := clock_timestamp();
  v_now_epoch bigint := floor(extract(epoch from clock_timestamp()))::bigint;
  v_hash bytea;
  v_existing byeollog_automation.agent_devices%rowtype;
  v_registered_at timestamptz;
begin
  perform byeollog_automation.assert_runtime_locked_v1(
    p_workspace_id,
    p_authorized_user_id,
    p_session_id,
    p_runtime_component,
    p_runtime_revision,
    p_db_revision
  );

  if p_runtime_component <> 'agent_runtime'
     or p_device_id is null
     or p_device_name is null or char_length(btrim(p_device_name)) not between 1 and 120
     or p_device_secret_hash is null or p_device_secret_hash !~ '^[0-9a-f]{64}$'
 then
    raise exception 'recent interactive authentication is required' using errcode = 'BL101';
  end if;

  v_hash := decode(p_device_secret_hash, 'hex');
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('g3a-agent-registration:' || p_workspace_id::text, 3100)
  );

  select d.* into v_existing
  from byeollog_automation.agent_devices d
  where d.workspace_id = p_workspace_id and d.device_id = p_device_id
  for update;

  if found then
    if v_existing.revoked_at is not null or v_existing.secret_hash <> v_hash then
      raise exception 'agent authentication failed' using errcode = '28000';
    end if;
    return query select false, v_existing.registered_at;
    return;
  end if;

  -- Existing devices already proved their workspace-bound secret above.
  -- A recent interactive login is required only to enroll a NEW device.
  if p_authenticated_at is null
     or p_authenticated_at < v_now_epoch - 600
     or p_authenticated_at > v_now_epoch + 60
     or p_authentication_method is null or p_authentication_method not in (
       'password','otp','totp','magiclink','oauth','sso/saml',
       'oauth_provider/authorization_code'
     ) then
    raise exception 'recent interactive authentication is required' using errcode = 'BL101';
  end if;

  if exists (
    select 1
    from byeollog_automation.agent_devices d
    where d.registration_session_id = p_session_id
  ) then
    raise exception 'authentication session already registered an agent' using errcode = 'BL102';
  end if;

  if (
    select count(*)
    from byeollog_automation.agent_devices d
    where d.workspace_id = p_workspace_id and d.revoked_at is null
  ) >= 5 then
    raise exception 'active agent device limit reached' using errcode = 'BL103';
  end if;

  insert into byeollog_automation.agent_devices(
    workspace_id,
    device_id,
    device_name,
    secret_hash,
    created_by_user_id,
    registration_session_id,
    registered_at,
    secret_rotated_at
  ) values (
    p_workspace_id,
    p_device_id,
    btrim(p_device_name),
    v_hash,
    p_authorized_user_id,
    p_session_id,
    v_now,
    v_now
  )
  returning agent_devices.registered_at into v_registered_at;

  return query select true, v_registered_at;
end;
$function$;
