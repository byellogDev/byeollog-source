begin;

-- Avoid PL/pgSQL output-column ambiguity in the runtime-control upsert.
create or replace function public.byeollog_complete_oauth_signup_v1(
  p_auth_user_id uuid,
  p_email text,
  p_streamer_name text,
  p_pending_token_hash text,
  p_referrer_workspace_slug text default null,
  p_note text default ''
)
returns table(application_id uuid,workspace_id uuid,workspace_slug text,soop_id text)
language plpgsql
security definer
set search_path=''
set lock_timeout='2s'
set statement_timeout='10s'
as $function$
declare
  pending public.byeollog_soop_signup_oauth_pending%rowtype;
  existing public.byeollog_signup_applications%rowtype;
  v_application_id uuid;
  v_workspace_id uuid;
  v_referrer_workspace_id uuid;
  v_referrer_name text;
  v_email text:=lower(btrim(coalesce(p_email,'')));
  v_streamer_name text:=btrim(coalesce(p_streamer_name,''));
  v_base text;
  v_slug text;
  v_suffix integer:=1;
  v_credit_rows integer:=0;
begin
  if p_auth_user_id is null or v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    or length(v_email)>254 or length(v_streamer_name)<1 or length(v_streamer_name)>80
    or v_streamer_name~'[[:cntrl:]]' or length(coalesce(p_note,''))>1000
    or p_pending_token_hash!~'^[0-9a-f]{64}$' then
    raise exception 'invalid automatic signup input' using errcode='22023';
  end if;

  select * into pending
  from public.byeollog_soop_signup_oauth_pending p
  where p.token_hash=p_pending_token_hash and p.consumed_at is null
    and p.expires_at>clock_timestamp()
  for update;
  if not found then
    raise exception 'verified SOOP signup session is missing or expired' using errcode='28000';
  end if;
  if exists(select 1 from public.byeollog_workspaces w where lower(w.soop_id)=pending.provider_user_id) then
    raise exception 'SOOP account is already registered' using errcode='23505';
  end if;
  if exists(select 1 from public.byeollog_workspace_members m where m.user_id=p_auth_user_id) then
    raise exception 'auth user is already assigned' using errcode='23505';
  end if;

  select * into existing
  from public.byeollog_signup_applications a
  where lower(a.email)=v_email
  for update;
  if found and (existing.status<>'pending' or lower(existing.soop_id)<>pending.provider_user_id) then
    raise exception 'email is already registered' using errcode='23505';
  end if;

  if nullif(btrim(coalesce(p_referrer_workspace_slug,'')),'') is not null then
    select w.id,w.display_name into v_referrer_workspace_id,v_referrer_name
    from public.byeollog_workspaces w
    where w.slug=lower(btrim(p_referrer_workspace_slug)) and w.status='active'
      and exists(select 1 from public.byeollog_workspace_members m where m.workspace_id=w.id and m.role='owner')
    limit 1;
    if not found then raise exception 'referrer is unavailable' using errcode='22023'; end if;
  end if;

  v_base:=pg_catalog.regexp_replace(pending.provider_user_id,'[^a-z0-9_-]+','-','g');
  v_base:=trim(both '-' from v_base);
  if length(v_base)<2 then v_base:='streamer'; end if;
  v_base:=left(v_base,48);
  v_slug:=v_base;
  while exists(select 1 from public.byeollog_workspaces w where lower(w.slug)=lower(v_slug)) loop
    v_suffix:=v_suffix+1;
    v_slug:=left(v_base,48-length(v_suffix::text)-1)||'-'||v_suffix::text;
  end loop;

  insert into public.byeollog_workspaces(slug,display_name,soop_id,owner_user_id,status)
  values(v_slug,v_streamer_name,pending.provider_user_id,p_auth_user_id,'active')
  returning id into v_workspace_id;
  insert into public.byeollog_workspace_members(user_id,workspace_id,role)
  values(p_auth_user_id,v_workspace_id,'owner');

  if existing.id is null then
    insert into public.byeollog_signup_applications(
      auth_user_id,email,streamer_name,soop_id,station_url,
      verification_channel,verification_account,note,status,rejection_reason,
      reviewed_at,workspace_id,referrer_workspace_id,referrer_name_snapshot,
      provisioning_state,status_token_hash,status_token_issued_at
    ) values (
      p_auth_user_id,v_email,v_streamer_name,pending.provider_user_id,
      'https://ch.sooplive.co.kr/'||pending.provider_user_id,
      'soop_oauth',pending.provider_user_id,coalesce(p_note,''),'approved','',
      clock_timestamp(),v_workspace_id,v_referrer_workspace_id,v_referrer_name,
      'approved',null,null
    ) returning id into v_application_id;
  else
    update public.byeollog_signup_applications a set
      auth_user_id=p_auth_user_id,streamer_name=v_streamer_name,
      soop_id=pending.provider_user_id,station_url='https://ch.sooplive.co.kr/'||pending.provider_user_id,
      verification_channel='soop_oauth',verification_account=pending.provider_user_id,
      note=coalesce(p_note,''),status='approved',rejection_reason='',reviewed_by=null,
      reviewed_at=clock_timestamp(),workspace_id=v_workspace_id,
      referrer_workspace_id=v_referrer_workspace_id,referrer_name_snapshot=v_referrer_name,
      provisioning_state='approved',status_token_hash=null,status_token_issued_at=null,
      updated_at=clock_timestamp()
    where a.id=existing.id returning a.id into v_application_id;
  end if;

  insert into public.byeollog_soop_connections(
    workspace_id,connected_by_user_id,status,access_token_ciphertext,
    refresh_token_ciphertext,access_token_expires_at,connected_at,refreshed_at,
    revoked_at,last_error_code,updated_at
  ) values (
    v_workspace_id,p_auth_user_id,'connected',pending.access_token_ciphertext,
    pending.refresh_token_ciphertext,pending.access_token_expires_at,clock_timestamp(),
    clock_timestamp(),null,null,clock_timestamp()
  );

  insert into public.byeollog_soop_runtime_controls(
    workspace_id,gateway_enabled,core_collection_enabled,native_roulette_enabled,
    overlay_experiment_enabled,overlay_experiment_draft_id,overlay_experiment_expires_at,
    updated_by_user_id,updated_at
  ) values (
    v_workspace_id,true,true,false,false,null,null,p_auth_user_id,clock_timestamp()
  ) on conflict on constraint byeollog_soop_runtime_controls_pkey do update set
    gateway_enabled=true,core_collection_enabled=true,native_roulette_enabled=false,
    overlay_experiment_enabled=false,overlay_experiment_draft_id=null,
    overlay_experiment_expires_at=null,updated_by_user_id=p_auth_user_id,
    updated_at=clock_timestamp();

  if v_referrer_workspace_id is not null then
    insert into public.byeollog_credit_ledger(workspace_id,credit_delta,entry_type,source_key)
    values(v_referrer_workspace_id,500,'signup_referral','signup_referral:'||v_application_id::text)
    on conflict(source_key) do nothing;
    get diagnostics v_credit_rows=row_count;
    if v_credit_rows=1 then
      update public.byeollog_signup_applications a set referral_credit_awarded_at=clock_timestamp()
      where a.id=v_application_id;
    end if;
  end if;

  delete from public.byeollog_soop_signup_oauth_pending p where p.id=pending.id;
  return query select v_application_id,v_workspace_id,v_slug,pending.provider_user_id;
end
$function$;

revoke all on function public.byeollog_complete_oauth_signup_v1(uuid,text,text,text,text,text)
  from public,anon,authenticated,service_role;
grant execute on function public.byeollog_complete_oauth_signup_v1(uuid,text,text,text,text,text)
  to service_role;

notify pgrst,'reload schema';
commit;



