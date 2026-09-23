set lock_timeout='2s';
set statement_timeout='15s';
create or replace function public.resolve_soop_roulette_exception_v2(
  p_workspace_id uuid,p_authorized_user_id uuid,p_result_id uuid,p_decision jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='8s'
as $$
declare v public.byeollog_soop_core_roulette_results%rowtype; t public.bangsel_tasks%rowtype;
  quantity integer; tracked integer; other_tracked integer; result jsonb; action text:=p_decision->>'action';
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_authorized_user_id and w.status='active'
      and lower(m.role::text) in ('owner','editor','manager')) then
    raise exception 'exception authorization failed' using errcode='42501';
  end if;
  select * into v from public.byeollog_soop_core_roulette_results where workspace_id=p_workspace_id and id=p_result_id for update;
  if not found or v.match_state='matched' or v.donation_id is not null then raise exception 'exception not found' using errcode='PT404';end if;
  if action='undo' then
    if v.review_status='pending' then return jsonb_build_object('status','pending','duplicate',true);end if;
    if v.review_status not in ('excluded','registered') then raise exception 'automatic exclusion cannot be undone' using errcode='PT409';end if;
    if v.review_status='registered' then
      quantity:=(v.review_details->'decision'->>'quantity')::integer;
      if quantity is null or quantity<1 then raise exception 'missing registration receipt' using errcode='PT409';end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array(p_workspace_id,
        v.review_details->'decision'->>'soopId',v.review_details->'decision'->>'event',v.review_details->'decision'->>'type')::text,1701));
      select * into t from public.bangsel_tasks where workspace_id=p_workspace_id and id=(v.review_details->'receipt'->>'taskId')::uuid for update;
      if not found or t.done_qty<>0 or t.total_qty<quantity
        or t.fan_soop_id is distinct from v.review_details->'decision'->>'soopId'
        or t.event is distinct from v.review_details->'decision'->>'event'
        or t.type is distinct from v.review_details->'decision'->>'type' then raise exception 'upbo changed since registration' using errcode='PT409';end if;
      select count(*) into tracked from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id
        and i.task_id=t.id and i.source_event_key like 'soop-exception:'||p_result_id::text||':%';
      select count(*) into other_tracked from public.bangsel_task_import_items i where i.workspace_id=p_workspace_id
        and i.task_id=t.id and i.source_event_key not like 'soop-exception:'||p_result_id::text||':%';
      if tracked<>quantity or t.total_qty<tracked+other_tracked or (t.total_qty=quantity and other_tracked<>0) then raise exception 'upbo ledger changed' using errcode='PT409';end if;
      delete from public.bangsel_task_import_items where workspace_id=p_workspace_id and task_id=t.id
        and source_event_key like 'soop-exception:'||p_result_id::text||':%';
      if t.total_qty=quantity then delete from public.bangsel_tasks where workspace_id=p_workspace_id and id=t.id;
      else
        -- A merged row can retain the first exception's unique creation key.
        -- Release that key when its contribution is removed, so re-registration
        -- still works after the other contributions have been completed.
        update public.bangsel_tasks set total_qty=total_qty-quantity,
          source_event_key=case when source_event_key like p_workspace_id::text||':soop-exception:'||p_result_id::text||':%'
            then p_workspace_id::text||':'||coalesce((select min(i.source_event_key) from public.bangsel_task_import_items i
              where i.workspace_id=p_workspace_id and i.task_id=t.id),'exception-undo:'||pg_catalog.gen_random_uuid()::text)
            else source_event_key end
          where workspace_id=p_workspace_id and id=t.id;
      end if;
    end if;
    update public.byeollog_soop_core_roulette_results set review_status='pending',reviewed_at=null,reviewed_by=null,review_details=case when v.review_details ? 'fifoHead' then jsonb_build_object('fifoHead',v.review_details->'fifoHead') else '{}'::jsonb end
      where workspace_id=p_workspace_id and id=p_result_id;
    result:=jsonb_build_object('status','pending','duplicate',false);
  else
    if action='registered' and p_decision->'createFan'='true'::jsonb and v.review_status='pending' then
      if coalesce(p_decision->>'soopId','')!~'^[a-z0-9_.-]{2,80}$'
        or char_length(btrim(coalesce(p_decision->>'fanName',''))) not between 1 and 120
        or p_decision->>'fanName' ~ '[[:cntrl:]]' then raise exception 'invalid new fan' using errcode='22023';end if;
      insert into public.bangsel_fans(workspace_id,soop_id,alias,current_nickname)
        values(p_workspace_id,p_decision->>'soopId',btrim(p_decision->>'fanName'),btrim(p_decision->>'fanName'))
        on conflict(workspace_id,soop_id) do nothing;
    end if;
    result:=public.resolve_soop_roulette_exception_v1(p_workspace_id,p_authorized_user_id,p_result_id,p_decision);
    if v.review_details ? 'fifoHead' then
      update public.byeollog_soop_core_roulette_results set review_details=review_details||jsonb_build_object('fifoHead',v.review_details->'fifoHead') where workspace_id=p_workspace_id and id=p_result_id;
    end if;
  end if;
  if coalesce((result->>'duplicate')::boolean,false)=false then
    insert into public.byeollog_roulette_exception_reviews(workspace_id,result_id,user_id,action,previous_status,previous_details)
      values(p_workspace_id,p_result_id,p_authorized_user_id,action,v.review_status,coalesce(v.review_details,'{}'::jsonb));
  end if;
  return result;
end $$;
revoke all on function public.resolve_soop_roulette_exception_v2(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_soop_roulette_exception_v2(uuid,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
