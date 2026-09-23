begin;

set local lock_timeout = '2s';
set local statement_timeout = '20s';

create or replace function public.byeollog_complete_oauth_signup_v2(
  p_auth_user_id uuid,
  p_email text,
  p_streamer_name text,
  p_pending_token_hash text,
  p_consents jsonb,
  p_referrer_workspace_slug text default null,
  p_note text default ''
)
returns table(application_id uuid,workspace_id uuid,workspace_slug text,soop_id text)
language plpgsql
security invoker
set search_path=''
set statement_timeout='10s'
as $function$
declare v record;
begin
  if p_consents is null
    or p_consents->>'termsVersion' is distinct from '2026-09-14'
    or p_consents->>'privacyVersion' is distinct from '2026-09-14'
    or p_consents->'termsAgreed' is distinct from 'true'::jsonb
    or p_consents->'collectionAgreed' is distinct from 'true'::jsonb
    or p_consents->'age14Confirmed' is distinct from 'true'::jsonb then
    raise exception 'current signup consent required' using errcode='22023';
  end if;

  select * into strict v
  from public.byeollog_complete_oauth_signup_v1(
    p_auth_user_id,
    p_email,
    p_streamer_name,
    p_pending_token_hash,
    p_referrer_workspace_slug,
    p_note
  );

  insert into public.byeollog_signup_consents(
    workspace_id,user_id,terms_version,privacy_version,
    collection_agreed,age_14_confirmed
  ) values (
    v.workspace_id,p_auth_user_id,'2026-09-14','2026-09-14',true,true
  );

  return query select v.application_id,v.workspace_id,v.workspace_slug,v.soop_id;
end
$function$;

revoke all on function public.byeollog_complete_oauth_signup_v2(
  uuid,text,text,text,jsonb,text,text
) from public,anon,authenticated;
grant execute on function public.byeollog_complete_oauth_signup_v2(
  uuid,text,text,text,jsonb,text,text
) to service_role;

comment on function public.byeollog_complete_oauth_signup_v2(
  uuid,text,text,text,jsonb,text,text
) is 'Completes verified SOOP signup and records the 2026-09-14 legal consent versions atomically.';

notify pgrst,'reload schema';

commit;
