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
    or coalesce(p_consents->>'termsVersion','') not in ('2026-09-14','2026-10-11')
    or p_consents->>'privacyVersion' is distinct from p_consents->>'termsVersion'
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
    v.workspace_id,p_auth_user_id,p_consents->>'termsVersion',p_consents->>'privacyVersion',true,true
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
) is 'Completes verified SOOP signup and records the submitted legal version atomically; old and new versions coexist during deployment, without rewriting historical consents.';

notify pgrst,'reload schema';

-- Read-only management view. Both paths preserve original receipts; no historical replay.
create or replace function public.byeollog_special_history_v1(p_workspace_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare v jsonb;
begin
 if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
   where m.workspace_id=p_workspace_id and m.user_id=p_user_id and m.role in ('owner','manager') and w.status='active') then
   raise exception 'workspace authorization failed' using errcode='42501';end if;
 select jsonb_build_object('checkedAt',clock_timestamp(),
 'specialPending',coalesce((select jsonb_agg(to_jsonb(s) order by s.updated_at desc) from (
  select coalesce(nullif(f.alias,''),nullif(f.current_nickname,''),state.actor_key) as fan,state.multiplier,state.expires_at,state.updated_at
  from private.special_roulette_state state
  join public.byeollog_soop_gateway_sessions g on g.workspace_id=state.workspace_id and g.broadcast_instance_id=state.broadcast_instance_id
  left join public.bangsel_fans f on f.workspace_id=state.workspace_id and f.soop_id=state.actor_key
  where state.workspace_id=p_workspace_id and state.expires_at>clock_timestamp() order by state.updated_at desc limit 100)s),'[]'::jsonb),
 'specialRecent',coalesce((select jsonb_agg(to_jsonb(r) order by r.occurred_at desc,r.source,r.result_key) from (
   select * from (
    select result.result_text,result.occurred_at,result.special_roulette,d.actor_name,'chat'::text as source,result.id::text as result_key
    from public.byeollog_soop_core_roulette_results result
    left join public.byeollog_soop_core_donations d on d.id=result.donation_id and d.workspace_id=result.workspace_id
    where result.workspace_id=p_workspace_id and result.special_roulette is not null
    union all
    select receipt.result_text,coalesce(j.completed_at,e.first_at),receipt.decision,
     e.message->'data'->>'name','overlay',receipt.job_key||':'||receipt.ordinal
    from byeollog_weflab_trial.production_receipts receipt
    join byeollog_weflab_trial.jobs j on j.workspace_id=receipt.workspace_id and j.job_key=receipt.job_key
    join byeollog_weflab_trial.events e on e.workspace_id=j.workspace_id and e.event_key=j.event_key
    where receipt.workspace_id=p_workspace_id
   ) combined order by occurred_at desc,source,result_key limit 50
 )r),'[]'::jsonb)) into v;
 return v;
end $$;
revoke all on function public.byeollog_special_history_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.byeollog_special_history_v1(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
