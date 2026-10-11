begin;
set local lock_timeout='2s';
set local statement_timeout='20s';

-- Activation is a separate, verified cutover. Historical trial rows stay evidence.
create table byeollog_weflab_trial.production_control (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false, activated_at timestamptz,
 server_secret_hash text not null check(server_secret_hash ~ '^[a-f0-9]{64}$')
);
alter table byeollog_weflab_trial.production_control enable row level security;
revoke all on byeollog_weflab_trial.production_control from public,anon,authenticated,service_role;
alter table byeollog_weflab_trial.campaigns add column production_since timestamptz;
alter table byeollog_weflab_trial.events add column production_eligible boolean not null default false;
alter table byeollog_weflab_trial.events add column production_state text not null default 'historical';
alter table byeollog_weflab_trial.events add column event_name text;
alter table byeollog_weflab_trial.events add column broadcast_instance_id uuid;
alter table byeollog_weflab_trial.events add column source_at timestamptz;
alter table byeollog_weflab_trial.jobs add column published_at timestamptz;
alter table byeollog_weflab_trial.jobs add column publish_error text;

create function private.overlay_authoritative_v1() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce((select enabled from byeollog_weflab_trial.production_control where singleton),false);
$$;
revoke all on function private.overlay_authoritative_v1() from public,anon,authenticated,service_role;

create function private.snapshot_overlay_event_v1() returns trigger language plpgsql security definer set search_path='' as $$
declare c byeollog_weflab_trial.campaigns%rowtype; d jsonb:=new.message->'data'; stamp numeric; start_at timestamptz;
begin
 select * into c from byeollog_weflab_trial.campaigns where workspace_id=new.workspace_id;
 select activated_at into start_at from byeollog_weflab_trial.production_control where singleton and enabled;
 if start_at is null or c.production_since is null then return new; end if;
 new.production_state:='ignored';
 if not exists(select 1 from public.byeollog_upbo_collection_settings s join byeollog_weflab_trial.settings u using(workspace_id)
    where s.workspace_id=new.workspace_id and s.enabled and u.url=c.config->>'url' and u.url<>'') then return new; end if;
 if new.message->>'type' is distinct from 'alert' or new.message->>'platform' is distinct from 'afreeca'
   or new.message->>'id' is distinct from c.config->>'owner' or d->>'subtype' is distinct from 'SENDBALLOON'
   or coalesce(d->>'test','false') not in ('false','0','') or coalesce(d->>'replay','false') not in ('false','0','') then return new; end if;
 if jsonb_typeof(d->'time') is distinct from 'number' or jsonb_typeof(d->'value') not in ('number','string')
   or coalesce(d->>'value','')!~'^[0-9]{1,10}$' or (d->>'value')::bigint not between 1 and 1000000000
   or coalesce(d->>'uid','')='' or length(d->>'uid')>512
   or length(coalesce(d->>'id','')) not between 1 and 180 or length(coalesce(d->>'name','')) not between 1 and 120
   or (d->>'id')~'[[:cntrl:]]' or (d->>'name')~'[[:cntrl:]]' then
   new.production_state:='invalid_donation';return new;
 end if;
 stamp:=(d->>'time')::numeric;
 if stamp>100000000000 then stamp:=stamp/1000;end if;
 if stamp<0 or stamp>32503680000 then new.production_state:='invalid_time';return new;end if;
 new.source_at:=to_timestamp(stamp::double precision);
 -- Never import pre-cutover history or replays as fresh work.
 if new.source_at<greatest(start_at,c.production_since) or new.source_at>clock_timestamp()+interval '60 seconds'
   or new.source_at<clock_timestamp()-interval '10 minutes' then new.production_state:='outside_live_window';return new;end if;
 if exists(select 1 from byeollog_weflab_trial.events prior where prior.workspace_id=new.workspace_id and prior.production_eligible and prior.message->'data'->>'uid'=d->>'uid') then
   new.production_state:='duplicate_uid';
   if exists(select 1 from byeollog_weflab_trial.events prior where prior.workspace_id=new.workspace_id and prior.production_eligible and prior.message->'data'->>'uid'=d->>'uid'
      and (prior.message->'data'->>'id',prior.message->'data'->>'value',prior.source_at) is distinct from (d->>'id',d->>'value',new.source_at)) then
     new.production_state:='identity_conflict';
     update byeollog_weflab_trial.campaigns set enabled=false,stopped_reason='donation_identity_conflict' where workspace_id=new.workspace_id;
   end if;
   return new;
 end if;
 new.production_eligible:=true;new.production_state:='accepted';
 select n.event_name into new.event_name from public.byeollog_upbo_event_names n
   where n.workspace_id=new.workspace_id and (d->>'value')::bigint between n.amount and n.amount_max;
 select g.broadcast_instance_id into new.broadcast_instance_id from public.byeollog_soop_gateway_sessions g
   where g.workspace_id=new.workspace_id and (g.broadcast_offline_since is null or g.broadcast_offline_since>new.source_at-interval '20 minutes');
 return new;
end $$;
revoke all on function private.snapshot_overlay_event_v1() from public,anon,authenticated,service_role;
create trigger snapshot_overlay_event before insert on byeollog_weflab_trial.events for each row execute function private.snapshot_overlay_event_v1();

-- Registration uses only the context verified by the authenticated backend.
create function private.enroll_overlay_v1(w uuid,cfg jsonb) returns void language plpgsql security definer set search_path='' as $$
declare secret_hash text;owner_id text;
begin
 select soop_id into owner_id from public.byeollog_workspaces where id=w and status='active';
 select server_secret_hash into secret_hash from byeollog_weflab_trial.production_control where singleton;
 if secret_hash is null then raise exception 'overlay_runtime_not_ready';end if;
 if cfg->>'owner' is distinct from lower(owner_id) or coalesce(cfg->>'idx','')!~'^[0-9]+$'
   or coalesce(cfg->>'preset','')!~'^[0-9]+$' or not exists(select 1 from byeollog_weflab_trial.settings s where s.workspace_id=w and s.url=cfg->>'url' and s.url<>'') then
   raise exception 'overlay_verified_context_required' using errcode='22023';
 end if;
 if exists(select 1 from byeollog_weflab_trial.campaigns c where c.workspace_id=w and c.production_since is not null and c.config->>'url'<>cfg->>'url')
   and exists(select 1 from byeollog_weflab_trial.events e where e.workspace_id=w and e.production_eligible and e.production_state='accepted') then
   raise exception 'overlay_change_wait_for_pending' using errcode='22023';
 end if;
 insert into byeollog_weflab_trial.campaigns(workspace_id,enabled,config,server_secret_hash,policy,delay_seconds,production_since)
 values(w,true,cfg||jsonb_build_object('workspaceId',w),secret_hash,'delayed_automatic',180,clock_timestamp())
 on conflict(workspace_id) do update set
   config=excluded.config,server_secret_hash=excluded.server_secret_hash,
   production_since=coalesce(byeollog_weflab_trial.campaigns.production_since,excluded.production_since),
   enabled=case when byeollog_weflab_trial.campaigns.stopped_reason is null then true else byeollog_weflab_trial.campaigns.enabled end;
end $$;
revoke all on function private.enroll_overlay_v1(uuid,jsonb) from public,anon,authenticated,service_role;

-- Preserve all existing settings permissions and overlap checks.
do $$declare f text;marker text;begin
 f:=pg_get_functiondef('public.byeollog_upbo_collection_settings_v1(uuid,uuid,jsonb)'::regprocedure);
 marker:='if e then';
 if strpos(f,marker)=0 then raise exception 'settings definition drift';end if;
 f:=replace(f,marker,$new$if e then
     perform private.enroll_overlay_v1(p_workspace_id,p_request->'overlayConfig');$new$);
 execute f;
 f:=pg_get_functiondef('public.apply_roulette_amount_mapping_to_staging_v1()'::regprocedure);
 f:=regexp_replace(f,'\m[Bb][Ee][Gg][Ii][Nn]\M',$new$begin
  if new.raw_payload->>'source_provider'='overlay_result' then return new;end if;$new$);execute f;
 -- No new chat result, including a direct call bypassing v4, can create upbo.
 f:=pg_get_functiondef('public.ingest_soop_external_roulette_result_v2(uuid,text,text,text,text,text,text,text,timestamptz,text)'::regprocedure);
 f:=regexp_replace(f,'\m[Bb][Ee][Gg][Ii][Nn]\M',$new$begin
  if private.overlay_authoritative_v1() then return jsonb_build_object('matched',false,'status','overlay_authoritative');end if;$new$);
 execute f;
 f:=pg_get_functiondef('public.ingest_soop_external_roulette_result_v4(uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text)'::regprocedure);
 f:=regexp_replace(f,'\m[Bb][Ee][Gg][Ii][Nn]\M',$new$begin
  if private.overlay_authoritative_v1() then return jsonb_build_object('matched',false,'status','overlay_authoritative');end if;$new$);
 execute f;
 f:=pg_get_functiondef('private.snapshot_upbo_collection_v1()'::regprocedure);
 marker:='return new;';
 if strpos(f,marker)=0 then raise exception 'snapshot definition drift';end if;
 f:=replace(f,marker,$new$if private.overlay_authoritative_v1() then
   new.roulette_enabled:=false;new.expected_spins:=null;new.status:='complete';new.upbo_collection_issue:=null;
 end if;
 return new;$new$);execute f;
end $$;

-- OFF stops accepting new events. Already accepted jobs can drain even after
-- clearing the URL; the immutable job plan still pins the original identity.
do $$declare f text;marker text;begin
 f:=pg_get_functiondef('byeollog_weflab_trial.rpc(uuid,jsonb)'::regprocedure);
 marker:=$old$if (not c.enabled or not exists(select 1 from byeollog_weflab_trial.settings s where s.workspace_id=p_workspace_id and s.url=c.config->>'url' and s.url<>'')) and action<>'complete' then return jsonb_build_object('status','disabled'); end if;$old$;
 if strpos(f,marker)=0 then raise exception 'trial gate definition drift';end if;
 f:=replace(f,marker,$new$if c.production_since is not null then
   if not c.enabled and action<>'complete' then return jsonb_build_object('status','disabled');end if;
   if not exists(select 1 from public.byeollog_upbo_collection_settings s join byeollog_weflab_trial.settings u using(workspace_id)
     where s.workspace_id=p_workspace_id and s.enabled and u.url=c.config->>'url' and u.url<>'') then
     if action='ingest' then return jsonb_build_object('status','ignored');end if;
     if action<>'complete' and not exists(select 1 from byeollog_weflab_trial.events e where e.workspace_id=p_workspace_id and e.production_eligible and e.production_state='accepted') then return jsonb_build_object('status','disabled');end if;
   end if;
 else
   if (not c.enabled or not exists(select 1 from byeollog_weflab_trial.settings s where s.workspace_id=p_workspace_id and s.url=c.config->>'url' and s.url<>'')) and action<>'complete' then return jsonb_build_object('status','disabled');end if;
 end if;$new$);
 f:=replace(f,'and processing=''pending'' order by first_at limit 25','and processing=''pending'' and (c.production_since is null or production_eligible) order by first_at limit 25');
 f:=replace(f,'where workspace_id=p_workspace_id)>=10000','where workspace_id=p_workspace_id and (c.production_since is null or (production_eligible and production_state=''accepted'')))>=10000');
 -- Permanent request reservation remains the fence across PC/server handoffs.
 execute f;
end $$;

create table byeollog_weflab_trial.production_receipts (
 workspace_id uuid not null,job_key text not null,ordinal integer not null,
 result_text text not null,decision jsonb not null,
 primary key(workspace_id,job_key,ordinal)
);
alter table byeollog_weflab_trial.production_receipts enable row level security;
revoke all on byeollog_weflab_trial.production_receipts from public,anon,authenticated,service_role;

create function private.resolve_overlay_special_v1(w uuid,k text,i integer,result text,e byeollog_weflab_trial.events)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor text:=lower(e.message->'data'->>'id');instance uuid:=e.broadcast_instance_id;
 control boolean:=false;stacking boolean:=false;pending integer;applied integer:=1;decision jsonb;source_key text:='soop_result:overlay:'||k||':'||i;
begin
 select r.decision into decision from byeollog_weflab_trial.production_receipts r where r.workspace_id=w and r.job_key=k and r.ordinal=i;
 if found then return decision;end if;
 select true,r.allow_stacking into control,stacking from public.byeollog_special_roulette_rules r
   where r.workspace_id=w and r.enabled and r.result_text=normalize(btrim(result),NFC);
 control:=coalesce(control,false);stacking:=coalesce(stacking,false);
 if instance is null and (control or exists(select 1 from public.byeollog_special_roulette_rules where workspace_id=w and enabled)) then raise exception 'overlay_broadcast_identity_missing';end if;
 if instance is not null then
   perform pg_advisory_xact_lock(hashtextextended('byeollog:special-roulette:'||w::text||':'||instance::text||':'||actor,4102));
   delete from private.special_roulette_state s where s.workspace_id=w and s.broadcast_instance_id=instance and s.actor_key=actor and s.expires_at<=clock_timestamp();
   select multiplier into pending from private.special_roulette_state s where s.workspace_id=w and s.broadcast_instance_id=instance and s.actor_key=actor for update;
   if control then
     pending:=case when stacking then least(100,coalesce(pending,1)*2) else 2 end;
     insert into private.special_roulette_state(workspace_id,broadcast_instance_id,actor_key,multiplier,source_event_key,expires_at,updated_at)
     values(w,instance,actor,pending,source_key,clock_timestamp()+interval '12 hours',clock_timestamp())
     on conflict(workspace_id,broadcast_instance_id,actor_key) do update set multiplier=excluded.multiplier,source_event_key=excluded.source_event_key,expires_at=excluded.expires_at,updated_at=excluded.updated_at;
   else
     applied:=coalesce(pending,1);pending:=null;
     delete from private.special_roulette_state s where s.workspace_id=w and s.broadcast_instance_id=instance and s.actor_key=actor;
   end if;
 end if;
 decision:=jsonb_build_object('version',1,'sourceEventKey',source_key,'appliedMultiplier',applied,'controlEvent',control,'pendingMultiplier',pending);
 insert into byeollog_weflab_trial.production_receipts values(w,k,i,result,decision);
 return decision;
end $$;
revoke all on function private.resolve_overlay_special_v1(uuid,text,integer,text,byeollog_weflab_trial.events) from public,anon,authenticated,service_role;

create function private.publish_overlay_job_v1(w uuid,k text) returns text language plpgsql security definer set search_path='' as $$
declare j byeollog_weflab_trial.jobs%rowtype;e byeollog_weflab_trial.events%rowtype;raw jsonb;list jsonb;results jsonb:='[]';item jsonb;value text;n integer;i integer:=0;name text;v_source_uid text:='overlay:'||k;
begin
 perform pg_advisory_xact_lock(hashtextextended('byeollog:roulette-write:'||w::text,0));
 select * into j from byeollog_weflab_trial.jobs where workspace_id=w and job_key=k for update;
 if j.published_at is not null then return 'already_published';end if;
 select * into e from byeollog_weflab_trial.events where workspace_id=w and event_key=j.event_key for update;
 if not e.production_eligible or e.production_state<>'accepted' then return 'not_eligible';end if;
 if j.status<>'stored' then return 'not_ready';end if;
 if j.plan->>'test' is distinct from 'false' or j.plan->>'uid' is distinct from e.message->'data'->>'uid'
   or j.plan->'body'->>'value' is distinct from e.message->'data'->>'value' then raise exception 'overlay_plan_identity';end if;
 raw:=(j.response->>'raw')::jsonb;
 if raw->>'result' is distinct from 'success' or not coalesce(raw->>'api' in ('sql','mem'),false) then raise exception 'overlay_response_unconfirmed';end if;
 list:=raw->'list';if jsonb_typeof(list)='string' and list#>>'{}'<>'' then list:=(list#>>'{}')::jsonb;end if;
 if jsonb_typeof(list) is distinct from 'array' or jsonb_array_length(list)=0 then list:=jsonb_build_array(jsonb_build_array(raw->'data'));end if;
 n:=jsonb_array_length(list);
 if n not between 1 and 100 or n<>(j.plan->>'count')::integer then raise exception 'overlay_result_count';end if;
 if exists(select 1 from jsonb_array_elements(list) x where jsonb_typeof(x) is distinct from 'array' or jsonb_typeof(x->0) is distinct from 'string'
   or length(btrim(x->>0)) not between 1 and 2048 or (x->>0)~'[[:cntrl:]]') then raise exception 'overlay_result_shape';end if;
 -- Do not consume a later donor multiplier ahead of an unresolved earlier draw.
 if e.broadcast_instance_id is not null and exists(select 1 from public.byeollog_special_roulette_rules where workspace_id=w and enabled)
   and exists(select 1 from byeollog_weflab_trial.events earlier where earlier.workspace_id=w and earlier.production_eligible
     and earlier.production_state in ('accepted','needs_review') and earlier.message->'data'->>'id'=e.message->'data'->>'id'
     and earlier.broadcast_instance_id=e.broadcast_instance_id and (earlier.source_at,earlier.first_at,earlier.event_key)<(e.source_at,e.first_at,e.event_key)) then return 'waiting_for_earlier_result';end if;
 for item in select x from jsonb_array_elements(list) x loop
   i:=i+1;value:=btrim(item->>0);
   results:=results||jsonb_build_array(jsonb_build_object('result',value,'probability',coalesce(item->>1,''),'receipt_identity','overlay:'||k||':'||i,
     'special_roulette',private.resolve_overlay_special_v1(w,k,i,value,e)));
 end loop;
 name:=coalesce(e.event_name,extract(month from e.source_at at time zone 'Asia/Seoul')::integer::text||'월 '||(e.message->'data'->>'value')||'개');
 insert into public.bangsel_collector_staging(workspace_id,source_uid,source_scope,session_id,donated_time_text,nickname,soop_id,balloons,
   roulette,collector_version,raw_payload,event_name,expected_spins,actual_spins,validation,roulette_results,process_status,upbo_retry_after)
 values(w,v_source_uid,'soop',coalesce(e.broadcast_instance_id::text,e.campaign_id::text),to_char(e.source_at at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS'),
   e.message->'data'->>'name',e.message->'data'->>'id',(e.message->'data'->>'value')::integer,results->0->>'result','overlay-authority-v1',
   jsonb_build_object('type','SENDBALLOON','source_provider','overlay_result','result_authority','overlay','job_key',k,'roulette_enabled',true,'correlation_complete',true),
   name,n,n,'matched',results,'pending',clock_timestamp())
 on conflict(workspace_id,source_scope,source_uid) do nothing;
 update byeollog_weflab_trial.jobs set published_at=clock_timestamp(),publish_error=null where workspace_id=w and job_key=k;
 update byeollog_weflab_trial.events set production_state='published',event_name=name where workspace_id=w and event_key=e.event_key;
 return 'published';
end $$;
revoke all on function private.publish_overlay_job_v1(uuid,text) from public,anon,authenticated,service_role;

create function public.byeollog_overlay_runtime_v1(p_secret text,p_request jsonb) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='8s' as $$
declare result jsonb;v_job record;outcome text;done integer:=0;review integer:=0;
begin
 if coalesce(length(p_secret),0)<32 or not exists(select 1 from byeollog_weflab_trial.production_control where singleton
   and server_secret_hash=encode(extensions.digest(p_secret,'sha256'),'hex')) then raise exception 'overlay_forbidden' using errcode='42501';end if;
 if p_request->>'action'='discover' then
   select coalesce(jsonb_agg(jsonb_build_object('workspaceId',c.workspace_id,'config',c.config)),'[]') into result
   from byeollog_weflab_trial.campaigns c where c.production_since is not null and c.enabled and (
     exists(select 1 from public.byeollog_upbo_collection_settings s join byeollog_weflab_trial.settings u using(workspace_id) where s.workspace_id=c.workspace_id and s.enabled and u.url=c.config->>'url' and u.url<>'')
     or exists(select 1 from byeollog_weflab_trial.events e where e.workspace_id=c.workspace_id and e.production_eligible and e.production_state='accepted'));
   return jsonb_build_object('campaigns',result,'active',private.overlay_authoritative_v1());
 elsif p_request->>'action'='publish' then
   if not private.overlay_authoritative_v1() then return jsonb_build_object('paused',true);end if;
   -- Plan failures are explicit terminal diagnostics, not endlessly waiting rows.
   update byeollog_weflab_trial.events set production_state=case when reason in ('no_roulette_rule','roulette_disabled') then 'not_roulette' else 'needs_review' end
     where production_eligible and production_state='accepted' and processing='processed' and reason is not null;
   update byeollog_weflab_trial.events e set production_state='needs_review'
     where e.production_eligible and e.production_state='accepted' and exists(select 1 from byeollog_weflab_trial.jobs j where j.workspace_id=e.workspace_id and j.event_key=e.event_key and (j.status='needs_review' or (j.status='reserved' and j.requested_at<clock_timestamp()-interval '2 minutes')));
   for v_job in select j.workspace_id,j.job_key from byeollog_weflab_trial.jobs j join byeollog_weflab_trial.events e on e.workspace_id=j.workspace_id and e.event_key=j.event_key
     where e.production_eligible and e.production_state='accepted' and j.status='stored' and j.published_at is null and j.publish_error is null
     order by e.source_at,e.first_at,e.event_key limit 25 loop
     begin
       outcome:=private.publish_overlay_job_v1(v_job.workspace_id,v_job.job_key);
       if outcome='published' then done:=done+1;end if;
     exception when others then
       update byeollog_weflab_trial.jobs set publish_error=case when sqlerrm~'^overlay_[a-z_]+$' then sqlerrm else 'overlay_publish_failed' end where workspace_id=v_job.workspace_id and job_key=v_job.job_key;
       review:=review+1;
     end;
   end loop;
   return jsonb_build_object('published',done,'needsReview',review);
 end if;
 raise exception 'overlay_action';
end $$;
revoke all on function public.byeollog_overlay_runtime_v1(text,jsonb) from public;
grant execute on function public.byeollog_overlay_runtime_v1(text,jsonb) to anon;
notify pgrst,'reload schema';
commit;
