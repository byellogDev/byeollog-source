-- Revoke every custom web session for a user without adding another lookup to
-- the authenticated request hot path. The epoch rides on the membership row
-- that lib/auth.js already reads for every live authorization decision.

alter table public.byeollog_workspace_members
  add column if not exists web_session_epoch bigint not null default 0;

alter table public.byeollog_workspace_members
  drop constraint if exists byeollog_workspace_members_web_session_epoch_check;
alter table public.byeollog_workspace_members
  add constraint byeollog_workspace_members_web_session_epoch_check
  check (web_session_epoch between 0 and 9223372036854775806);

create or replace function public.revoke_web_sessions_v1(p_user_id uuid)
returns bigint
language sql
security invoker
set search_path = ''
set statement_timeout = '5s'
as $function$
  with revoked as (
    update public.byeollog_workspace_members
    set web_session_epoch = web_session_epoch + 1
    where user_id = p_user_id
    returning 1
  )
  select count(*)::bigint from revoked;
$function$;

revoke all on function public.revoke_web_sessions_v1(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_web_sessions_v1(uuid)
  to service_role;

-- Historical migrations used an explicit trusted-schema search_path. Keep the
-- deployed routines on the stricter empty search_path posture as well.
alter function public.ensure_soop_runtime_controls_v1()
  set search_path = '';
alter function private.notify_soop_gateway_incident_v1(text,uuid,uuid,timestamptz)
  set search_path = '';
alter function private.check_soop_gateway_heartbeats_v1()
  set search_path = '';
