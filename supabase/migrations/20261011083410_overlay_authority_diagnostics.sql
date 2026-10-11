begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
do $$declare f text; marker text;begin
 f:=pg_get_functiondef('public.byeollog_overlay_runtime_v1(text,jsonb)'::regprocedure);
 marker:='-- Plan failures are explicit terminal diagnostics, not endlessly waiting rows.';
 if strpos(f,marker)=0 then raise exception 'overlay publication definition drift';end if;
 f:=replace(f,marker,$new$-- A durable completion may arrive after the reservation warning. It is
   -- the same reserved request, never a second provider request.
   update byeollog_weflab_trial.events e set production_state='accepted'
     where e.production_eligible and e.production_state='needs_review' and e.reason is null
       and exists(select 1 from byeollog_weflab_trial.jobs j where j.workspace_id=e.workspace_id and j.event_key=e.event_key
         and j.status='stored' and j.published_at is null and j.publish_error is null);
   -- Plan failures are explicit terminal diagnostics, not endlessly waiting rows.$new$);
 execute f;
 f:=pg_get_functiondef('public.byeollog_upbo_collection_settings_v1(uuid,uuid,jsonb)'::regprocedure);
 marker:='''needsReviewCount'',(select count(*) from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and upbo_collection_issue is not null)';
 if strpos(f,marker)=0 then raise exception 'overlay diagnostics definition drift';end if;
 f:=replace(f,marker,$new$'needsReviewCount',(
   (select count(*) from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and upbo_collection_issue is not null)
   +(select count(*) from byeollog_weflab_trial.events e where e.workspace_id=p_workspace_id
      and (e.production_state in ('needs_review','identity_conflict','invalid_donation','invalid_time')
       or exists(select 1 from byeollog_weflab_trial.jobs j where j.workspace_id=e.workspace_id and j.event_key=e.event_key and j.publish_error is not null)))
   +(select count(*) from byeollog_weflab_trial.campaigns where workspace_id=p_workspace_id and production_since is not null and stopped_reason is not null)
 )$new$);
 execute f;
end $$;
notify pgrst,'reload schema';
commit;
