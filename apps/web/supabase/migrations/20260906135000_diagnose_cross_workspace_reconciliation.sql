create or replace function public.diagnose_cross_workspace_soop_incident_v1(
  p_incident_key text,
  p_authoritative_workspace_slug text,
  p_affected_workspace_slug text,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='25s'
as $function$
begin
  return public.reconcile_cross_workspace_soop_incident_v1(
    p_incident_key,p_authoritative_workspace_slug,p_affected_workspace_slug,p_from,p_to);
exception when others then
  return jsonb_build_object(
    'ok',false,
    'sqlstate',sqlstate,
    'message',left(sqlerrm,500)
  );
end
$function$;

revoke all on function public.diagnose_cross_workspace_soop_incident_v1(
  text,text,text,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.diagnose_cross_workspace_soop_incident_v1(
  text,text,text,timestamptz,timestamptz)
  to service_role;
