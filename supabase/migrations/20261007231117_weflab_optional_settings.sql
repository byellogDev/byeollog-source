-- Optional URL preferences are private; registration does not enroll a new campaign.
create table byeollog_weflab_trial.settings (
 workspace_id uuid primary key references public.byeollog_workspaces(id),
 url text not null default '' check(url='' or url ~ '^https://weflab[.]com/page/[A-Za-z0-9]+$'),
 updated_at timestamptz not null default now()
);
alter table byeollog_weflab_trial.settings enable row level security;
revoke all on byeollog_weflab_trial.settings from public,anon,authenticated;
insert into byeollog_weflab_trial.settings(workspace_id,url) select workspace_id,config->>'url' from byeollog_weflab_trial.campaigns;
create function byeollog_weflab_trial.settings(p_workspace_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare u text; active boolean;
begin
 if auth.uid() is null or not coalesce(public.g3a_assert_active_auth_session_v1(auth.uid(),nullif(auth.jwt()->>'session_id','')::uuid),false)
 or not exists(select 1 from public.byeollog_workspaces w join public.byeollog_workspace_members m on m.workspace_id=w.id
 where w.id=p_workspace_id and w.status='active' and m.user_id=auth.uid() and m.role in ('owner','manager')) then
 raise exception 'settings_forbidden' using errcode='42501'; end if;
 if p_request->>'action'='settings_save' then
   u:=btrim(coalesce(p_request->>'url',''));
   if length(u)>256 or (u<>'' and u!~'^https://weflab[.]com/page/[A-Za-z0-9]+$') then raise exception 'settings_url'; end if;
   -- Serialize with collector leases; no cleared URL can reserve another job.
   perform 1 from byeollog_weflab_trial.campaigns where workspace_id=p_workspace_id for update;
   insert into byeollog_weflab_trial.settings(workspace_id,url) values(p_workspace_id,u)
   on conflict(workspace_id) do update set url=excluded.url,updated_at=now();
 end if;
 select url into u from byeollog_weflab_trial.settings where workspace_id=p_workspace_id;
 select exists(select 1 from byeollog_weflab_trial.campaigns c where c.workspace_id=p_workspace_id and c.enabled and c.config->>'url'=u and u<>'') into active;
 return jsonb_build_object('status','saved','url',coalesce(u,''),'active',active);
end; $$;
revoke all on function byeollog_weflab_trial.settings(uuid,jsonb) from public,anon,authenticated;
create or replace function byeollog_weflab_trial.rpc(p_workspace_id uuid,p_request jsonb)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare
 c byeollog_weflab_trial.campaigns%rowtype; j byeollog_weflab_trial.jobs%rowtype;
 action text:=p_request->>'action'; worker text; server boolean:=false; ready boolean;
 k text; a uuid; result jsonb; vnow timestamptz:=clock_timestamp();
begin
 if action in ('settings_get','settings_save') then return byeollog_weflab_trial.settings(p_workspace_id,p_request); end if;
 if pg_column_size(p_request)>1048576 then raise exception 'trial_request_limit'; end if;
 select * into c from byeollog_weflab_trial.campaigns where workspace_id=p_workspace_id for update;
 -- No private data for accounts that are not enrolled.
 if not found then return jsonb_build_object('status','disabled'); end if;
 if coalesce(p_request->>'serverSecret','')<>'' then
   if encode(extensions.digest(p_request->>'serverSecret','sha256'),'hex')<>c.server_secret_hash then raise exception 'trial_forbidden' using errcode='42501'; end if;
   server:=true; worker:='server';
 else
   if auth.uid() is null or not coalesce(public.g3a_assert_active_auth_session_v1(auth.uid(),nullif(auth.jwt()->>'session_id','')::uuid),false)
      or not exists(select 1 from public.byeollog_workspaces w join public.byeollog_workspace_members m on m.workspace_id=w.id
        where w.id=p_workspace_id and w.status='active' and m.user_id=auth.uid() and m.role in ('owner','manager')) then
     raise exception 'trial_forbidden' using errcode='42501';
   end if;
   if coalesce(p_request->>'workerId','') !~ '^[a-f0-9-]{36}$' then raise exception 'trial_worker'; end if;
   worker:='agent:'||auth.uid()::text||':'||(p_request->>'workerId');
 end if;
 if (not c.enabled or not exists(select 1 from byeollog_weflab_trial.settings s where s.workspace_id=p_workspace_id and s.url=c.config->>'url' and s.url<>'')) and action<>'complete' then return jsonb_build_object('status','disabled'); end if;
 if action='heartbeat' then
   ready:=coalesce((p_request->>'ready')::boolean,false);
   if server then c.last_server_at:=vnow; else c.last_agent_at:=vnow; end if;
   if not server and ready and (c.preferred_until is null or c.preferred_until<=vnow or c.preferred_agent=worker) then
     c.preferred_agent:=worker;c.preferred_until:=vnow+interval '45 seconds';
   end if;
   if not ready and c.lease_worker=worker then c.lease_until:=vnow; end if;
   if ready and (c.lease_until is null or c.lease_until<=vnow) and
      ((server and (c.preferred_until is null or c.preferred_until<=vnow)) or (not server and c.preferred_agent=worker)) then
     c.lease_worker:=worker;c.lease_token:=gen_random_uuid();c.lease_until:=vnow+interval '45 seconds';
   end if;
   if ready and c.lease_worker=worker and c.lease_until>vnow and
      (not server or c.preferred_until is null or c.preferred_until<=vnow) then c.lease_until:=vnow+interval '45 seconds'; end if;
   update byeollog_weflab_trial.campaigns set lease_worker=c.lease_worker,lease_token=c.lease_token,lease_until=c.lease_until,
     preferred_agent=c.preferred_agent,preferred_until=c.preferred_until,last_server_at=c.last_server_at,last_agent_at=c.last_agent_at where workspace_id=p_workspace_id;
   return jsonb_build_object('status',case
       when c.lease_worker=worker and c.lease_until>vnow then case when server and c.preferred_until>vnow then 'draining' else 'owner' end
       when not server and (c.preferred_until is null or c.preferred_until<=vnow or c.preferred_agent=worker) then 'prepare'
       when server and (c.lease_until is null or c.lease_until<=vnow) and (c.preferred_until is null or c.preferred_until<=vnow) then 'prepare'
       else 'standby' end,
     'token',case when c.lease_worker=worker and c.lease_until>vnow then c.lease_token else null end,
     'config',c.config,'campaignId',c.campaign_id,'policy',c.policy,'delaySeconds',c.delay_seconds);
 elsif action='release' then
   if c.lease_worker<>worker or c.lease_token::text is distinct from p_request->>'token' then raise exception 'trial_stale_lease'; end if;
   update byeollog_weflab_trial.campaigns set lease_until=vnow where workspace_id=p_workspace_id;
   return jsonb_build_object('status','released');
 elsif action='ingest' then
   if (p_request->'message'->>'type') not in ('alert','test_donation') then return jsonb_build_object('status','ignored'); end if;
   if p_request->'context'->'platform'->'afreeca'->>'id' is distinct from c.config->>'owner'
     or p_request->'context'->>'idx' is distinct from c.config->>'idx'
     or p_request->'context'->>'preset' is distinct from c.config->>'preset'
     or p_request->'context'->>'type' is distinct from 'page' or p_request->'context'->>'pageid' is distinct from 'alert'
     or jsonb_typeof(p_request->'rules') is distinct from 'object' then raise exception 'trial_scope'; end if;
   k:=encode(extensions.digest((p_request->'message')::text,'sha256'),'hex');
   if not exists(select 1 from byeollog_weflab_trial.events where workspace_id=p_workspace_id and event_key=k)
     and (select count(*) from byeollog_weflab_trial.events where workspace_id=p_workspace_id)>=10000 then
     update byeollog_weflab_trial.campaigns set enabled=false,stopped_reason='event_capacity' where workspace_id=p_workspace_id;
     return jsonb_build_object('status','capacity_stop');
   end if;
   insert into byeollog_weflab_trial.events(workspace_id,event_key,campaign_id,message,context,rules,sources)
     values(p_workspace_id,k,c.campaign_id,p_request->'message',p_request->'context',p_request->'rules',jsonb_build_array(worker))
     on conflict(workspace_id,event_key) do update set last_at=vnow,
       sources=case when byeollog_weflab_trial.events.sources @> jsonb_build_array(worker) then byeollog_weflab_trial.events.sources else byeollog_weflab_trial.events.sources||jsonb_build_array(worker) end;
   return jsonb_build_object('status','recorded');
 elsif action='pending_events' and server then
   select coalesce(jsonb_agg(to_jsonb(e)),'[]') into result from (select event_key,message,context,rules,first_at from byeollog_weflab_trial.events where workspace_id=p_workspace_id and processing='pending' order by first_at limit 25) e;
   return jsonb_build_object('events',result);
 elsif action='plan' and server then
   if p_request->'plan' is not null and p_request->'plan'<>'null'::jsonb then
     if p_request->'plan'->>'workspaceId' is distinct from p_workspace_id::text or p_request->'plan'->>'owner' is distinct from c.config->>'owner'
       or coalesce(p_request->'plan'->>'key','')!~'^[a-f0-9]{64}$' then raise exception 'trial_plan_scope'; end if;
     k:=p_request->'plan'->>'key';
     select * into j from byeollog_weflab_trial.jobs where workspace_id=p_workspace_id and job_key=k;
     if found and j.plan->>'requestHash' is distinct from p_request->'plan'->>'requestHash' then
       update byeollog_weflab_trial.campaigns set enabled=false,stopped_reason='same_donation_changed_request' where workspace_id=p_workspace_id;
       return jsonb_build_object('status','needs_review');
     end if;
     insert into byeollog_weflab_trial.jobs(workspace_id,job_key,campaign_id,event_key,plan,due_at)
       select p_workspace_id,k,c.campaign_id,event_key,p_request->'plan',first_at+make_interval(secs=>c.delay_seconds)
       from byeollog_weflab_trial.events where workspace_id=p_workspace_id and event_key=p_request->>'eventKey'
       on conflict(workspace_id,job_key) do nothing;
   end if;
   update byeollog_weflab_trial.events set processing='processed',reason=left(p_request->>'reason',100) where workspace_id=p_workspace_id and event_key=p_request->>'eventKey';
   return jsonb_build_object('status','planned');
 elsif action in ('due','reserve') then
   if c.lease_worker is distinct from worker or c.lease_token::text is distinct from p_request->>'token' or c.lease_until<=vnow
      or (server and c.preferred_until>vnow) then raise exception 'trial_stale_lease'; end if;
   if action='due' then
     select coalesce(jsonb_agg(job_key),'[]') into result from (select job_key from byeollog_weflab_trial.jobs
       where workspace_id=p_workspace_id and status='pending' and due_at<=vnow and (c.policy='delayed_automatic' or c.approved_keys ? job_key) order by due_at limit 5) j;
     return jsonb_build_object('keys',result);
   end if;
   select * into j from byeollog_weflab_trial.jobs where workspace_id=p_workspace_id and job_key=p_request->>'key' for update;
   if not found or j.status<>'pending' then return jsonb_build_object('status','already_reserved'); end if;
   if j.due_at>vnow or (c.policy<>'delayed_automatic' and not c.approved_keys ? j.job_key) then raise exception 'trial_not_approved'; end if;
   a:=gen_random_uuid();
   update byeollog_weflab_trial.jobs set status='reserved',request_worker=worker,attempt=a,requested_at=vnow where workspace_id=p_workspace_id and job_key=j.job_key;
   return jsonb_build_object('status','reserved','attempt',a,'plan',j.plan);
 elsif action='complete' then
   select * into j from byeollog_weflab_trial.jobs where workspace_id=p_workspace_id and job_key=p_request->>'key' for update;
   if not found or j.request_worker is distinct from worker or j.attempt::text is distinct from p_request->>'attempt' then raise exception 'trial_attempt'; end if;
   if j.response is not null then
     if j.response is distinct from p_request->'response' then raise exception 'trial_response_conflict'; end if;
     return jsonb_build_object('status','already_recorded');
   end if;
   if jsonb_typeof(p_request->'response') is distinct from 'object' then raise exception 'trial_response'; end if;
   update byeollog_weflab_trial.jobs set response=p_request->'response',completed_at=vnow,
     status=case when p_request->'response'->'assessment'->>'status'='stored_result_observed' then 'stored' else 'needs_review' end
     where workspace_id=p_workspace_id and job_key=j.job_key;
   if p_request->'response'->'assessment'->>'reason'='possible_result_generation' then
     update byeollog_weflab_trial.campaigns set enabled=false,stopped_reason='possible_result_generation' where workspace_id=p_workspace_id;
   end if;
   return jsonb_build_object('status','recorded');
 end if;
 raise exception 'trial_action';
end;
$$;
revoke all on function byeollog_weflab_trial.rpc(uuid,jsonb) from public;
grant usage on schema byeollog_weflab_trial to anon,authenticated;
grant execute on function byeollog_weflab_trial.rpc(uuid,jsonb) to anon,authenticated;
