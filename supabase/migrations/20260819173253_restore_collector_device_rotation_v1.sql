create or replace function public.byeollog_rotate_collector_device_v1(
  p_workspace_id uuid,
  p_device_name text,
  p_token_hash text,
  p_collector_version text,
  p_token_expires_at timestamptz,
  p_created_by_user_id uuid
)
returns setof public.byeollog_collector_devices
language plpgsql
volatile
security invoker
set search_path = ''
set statement_timeout = '10s'
as $function$
declare
  v_now timestamptz := clock_timestamp();
begin
  if p_workspace_id is null then
    raise exception 'workspace_id is required' using errcode = '22023';
  end if;
  if p_device_name is null or btrim(p_device_name) = '' then
    raise exception 'device_name is required' using errcode = '22023';
  end if;
  if p_token_hash is null or btrim(p_token_hash) = '' then
    raise exception 'token_hash is required' using errcode = '22023';
  end if;
  if p_token_expires_at is null or p_token_expires_at <= v_now then
    raise exception 'token_expires_at must be in the future' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_workspace_id::text, 0)
  );
  update public.byeollog_collector_devices
     set status = 'revoked',
         token_hash = null,
         revoked_at = v_now
   where workspace_id = p_workspace_id
     and status = 'active';
  return query
  insert into public.byeollog_collector_devices (
    workspace_id, device_name, token_hash, status, collector_version,
    paired_at, token_expires_at, last_rotated_at, created_by_user_id
  ) values (
    p_workspace_id,
    left(btrim(p_device_name), 80),
    p_token_hash,
    'active',
    nullif(left(coalesce(p_collector_version, ''), 40), ''),
    v_now,
    p_token_expires_at,
    v_now,
    p_created_by_user_id
  )
  returning *;
end;
$function$;

revoke all on function public.byeollog_rotate_collector_device_v1(
  uuid, text, text, text, timestamptz, uuid
) from public, anon, authenticated;

grant execute on function public.byeollog_rotate_collector_device_v1(
  uuid, text, text, text, timestamptz, uuid
) to service_role;

notify pgrst, 'reload schema';
