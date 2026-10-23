-- Run with an explicitly selected private workspace substitution; always rollback.
begin;
do $$
declare
 w uuid:='__WORKSPACE_ID__'; c jsonb; h jsonb; r jsonb; token text; attempt text;
 k text:=repeat('a',64); ek text; p jsonb;
begin
 if exists(select 1 from byeollog_weflab_trial.campaigns where workspace_id=w) then raise exception 'fixture_requires_unenrolled_workspace';end if;
 c:=jsonb_build_object('workspaceId',w,'owner','fixture-owner','idx','1','preset','0','url','https://weflab.com/page/fixture');
 insert into byeollog_weflab_trial.campaigns(workspace_id,enabled,config,server_secret_hash,policy,delay_seconds)
 values(w,true,c,encode(extensions.digest('fixture-secret','sha256'),'hex'),'delayed_automatic',60);
 insert into byeollog_weflab_trial.settings(workspace_id,url) values(w,c->>'url');
 begin
  perform public.byeollog_weflab_trial_rpc_v1(w,'{"action":"heartbeat","serverSecret":"wrong"}');
  raise exception 'bad_secret_was_accepted';
 exception when insufficient_privilege then null;end;
 begin
  perform public.byeollog_weflab_trial_rpc_v1(w,'{"action":"heartbeat","workerId":"00000000-0000-0000-0000-000000000001"}');
  raise exception 'unauthenticated_was_accepted';
 exception when insufficient_privilege then null;end;
 h:=public.byeollog_weflab_trial_rpc_v1(w,'{"action":"heartbeat","serverSecret":"fixture-secret","ready":true}');
 if h->>'status'<>'owner' then raise exception 'server_not_owner';end if;token:=h->>'token';
 p:=jsonb_build_object('action','ingest','serverSecret','fixture-secret','context',jsonb_build_object('type','page','pageid','alert','idx','1','preset','0','platform',jsonb_build_object('afreeca',jsonb_build_object('id','fixture-owner'))),'rules','{}'::jsonb,'message','{"type":"alert","data":{"uid":"fixture"}}'::jsonb);
 perform public.byeollog_weflab_trial_rpc_v1(w,p);perform public.byeollog_weflab_trial_rpc_v1(w,p);
 if (select count(*) from byeollog_weflab_trial.events where workspace_id=w)<>1 then raise exception 'duplicate_event';end if;
 select event_key into ek from byeollog_weflab_trial.events where workspace_id=w;
 perform public.byeollog_weflab_trial_rpc_v1(w,jsonb_build_object('action','plan','serverSecret','fixture-secret','eventKey',ek,'plan',jsonb_build_object('key',k,'workspaceId',w,'owner','fixture-owner','requestHash',repeat('b',64))));
 r:=public.byeollog_weflab_trial_rpc_v1(w,jsonb_build_object('action','due','serverSecret','fixture-secret','token',token));
 if jsonb_array_length(r->'keys')<>0 then raise exception 'delay_not_enforced';end if;
 update byeollog_weflab_trial.jobs set due_at=now()-interval '1 second' where workspace_id=w;
 r:=public.byeollog_weflab_trial_rpc_v1(w,jsonb_build_object('action','reserve','serverSecret','fixture-secret','token',token,'key',k));
 if r->>'status'<>'reserved' then raise exception 'reserve_failed';end if;attempt:=r->>'attempt';
 update byeollog_weflab_trial.campaigns set lease_until=now()-interval '1 second' where workspace_id=w;
 h:=public.byeollog_weflab_trial_rpc_v1(w,'{"action":"heartbeat","serverSecret":"fixture-secret","ready":true}');
 if h->>'token'=token then raise exception 'token_not_rotated';end if;
 r:=public.byeollog_weflab_trial_rpc_v1(w,jsonb_build_object('action','reserve','serverSecret','fixture-secret','token',h->>'token','key',k));
 if r->>'status'<>'already_reserved' then raise exception 'uncertain_request_repeated';end if;
 p:=jsonb_build_object('action','complete','serverSecret','fixture-secret','key',k,'attempt',attempt,'response',jsonb_build_object('raw','fixture-original-response','assessment',jsonb_build_object('status','needs_review','reason','possible_result_generation')));
 perform public.byeollog_weflab_trial_rpc_v1(w,p);
 if (select enabled from byeollog_weflab_trial.campaigns where workspace_id=w) then raise exception 'save_did_not_stop';end if;
 r:=public.byeollog_weflab_trial_rpc_v1(w,p);
 if r->>'status'<>'already_recorded' then raise exception 'completion_not_idempotent';end if;
 if (select response->>'raw' from byeollog_weflab_trial.jobs where workspace_id=w and job_key=k)<>'fixture-original-response' then raise exception 'raw_lost';end if;
 if has_table_privilege('authenticated','byeollog_weflab_trial.campaigns','select') or has_table_privilege('anon','byeollog_weflab_trial.events','select') then raise exception 'direct_table_access';end if;
end;
$$;
select 'passed: authentication, lease, delay, dedup, restart fencing, save stop, idempotent completion, raw retention, table isolation' as fixture_result;
rollback;
