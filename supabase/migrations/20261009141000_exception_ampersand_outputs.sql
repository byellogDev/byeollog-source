-- Fail closed if another deployment changed either RPC after review.
DO $guard$
begin
  if (select md5(replace(btrim(prosrc,E'\n\r\t '),E'\r','')) from pg_proc where oid='public.resolve_soop_roulette_exception_v1(uuid,uuid,uuid,jsonb)'::regprocedure) is distinct from 'ee870527e8f97a24dd9ed7bf059bf15e' then
    raise exception 'unexpected baseline: resolve_soop_roulette_exception_v1';
  end if;
  if (select md5(replace(btrim(prosrc,E'\n\r\t '),E'\r','')) from pg_proc where oid='public.resolve_soop_roulette_exception_v2(uuid,uuid,uuid,jsonb)'::regprocedure) is distinct from '2ff723574a37d21315254770a2b378a9' then
    raise exception 'unexpected baseline: resolve_soop_roulette_exception_v2';
  end if;
end $guard$;

-- Split manual exception outputs atomically; do not rewrite historical customer data.
-- Fix service-role invocation without granting private schema access or changing caller privileges.
set lock_timeout='2s';
set statement_timeout='15s';
create or replace function public.resolve_soop_roulette_exception_v1(
  p_workspace_id uuid,p_authorized_user_id uuid,p_result_id uuid,p_decision jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='8s'
as $$
declare
  v_member_role text;
  v_row public.byeollog_soop_core_roulette_results%rowtype;
  v_fan public.bangsel_fans%rowtype;
  v_action text:=p_decision->>'action';
  v_quantity integer;
  v_keys jsonb;
  v_receipt jsonb;
  v_details jsonb;
  v_types text[];
  v_output record;
  v_outputs jsonb := '[]'::jsonb;
begin
  -- Keep the same membership predicate without entering the private automation schema.
  if p_workspace_id is null or p_authorized_user_id is null then
    raise exception 'native roulette authorization is invalid' using errcode='28000';
  end if;
  select lower(btrim(member.role::text)) into v_member_role
  from public.byeollog_workspace_members member
  join public.byeollog_workspaces workspace on workspace.id=member.workspace_id
  where member.workspace_id=p_workspace_id
    and member.user_id=p_authorized_user_id
    and workspace.status='active';
  if v_member_role is null or v_member_role not in ('owner','editor','manager') then
    raise exception 'native roulette authorization failed' using errcode='42501';
  end if;
  if jsonb_typeof(p_decision) is distinct from 'object' or v_action is null
    or v_action not in ('excluded','registered') then
    raise exception 'invalid exception decision' using errcode='22023';
  end if;
  -- Match the live ledger lock order: workspace, result row, then output/task.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
  select * into v_row from public.byeollog_soop_core_roulette_results
  where workspace_id=p_workspace_id and id=p_result_id for update;
  if not found or v_row.match_state='matched' or v_row.donation_id is not null then
    raise exception 'unassigned result not found' using errcode='PT404';
  end if;
  if v_row.review_status<>'pending' then
    if v_row.review_details->'decision'=p_decision then
      return jsonb_build_object('status',v_row.review_status,'details',v_row.review_details,'duplicate',true);
    end if;
    raise exception 'result already reviewed' using errcode='PT409';
  end if;
  if v_action='registered' then
    if length(coalesce(p_decision->>'soopId','')) not between 1 and 180
      or length(btrim(coalesce(p_decision->>'event',''))) not between 1 and 120
      or length(btrim(coalesce(p_decision->>'type',''))) not between 1 and 120
      or jsonb_typeof(p_decision->'quantity') is distinct from 'number'
      or coalesce(p_decision->>'quantity','') !~ '^[0-9]{1,4}$' then
      raise exception 'invalid manual upbo' using errcode='22023';
    end if;
    v_quantity:=(p_decision->>'quantity')::integer;
    if v_quantity not between 1 and 1000 then raise exception 'invalid quantity' using errcode='22023'; end if;
    -- Match the ordinary output parser: trim each segment and ignore empty ones.
    -- Repeated output names still contribute once per occurrence.
    select array_agg(output order by position) into v_types
      from (select regexp_replace(value, '^[[:space:]]+|[[:space:]]+$', '', 'g') as output, position
        from unnest(string_to_array(p_decision->>'type','&')) with ordinality as parts(value,position)) parsed
      where output<>'';
    if coalesce(cardinality(v_types),0) not between 1 and 20
      or cardinality(v_types)*v_quantity>10000 then
      raise exception 'invalid output count' using errcode='22023';
    end if;
    select * into v_fan from public.bangsel_fans
      where workspace_id=p_workspace_id and soop_id=p_decision->>'soopId' for share;
    if not found then raise exception 'fan not found' using errcode='PT404'; end if;
    -- A user may have taught the result as non-upbo since the list was opened.
    if exists(select 1 from public.bangsel_roulette_rules r where r.workspace_id=p_workspace_id
      and r.result_text=v_row.result_text and r.action='exclude') then
      v_action:='auto_excluded';
      v_details:=jsonb_build_object('reason','known_non_upbo','ruleAction','exclude');
    else
      -- Acquire per-output locks in a deterministic order across registration/undo.
      for v_output in select output, count(*)::integer as occurrences
        from unnest(v_types) as types(output) group by output order by output collate "C"
      loop
        select jsonb_agg('soop-exception:'||p_result_id::text||':output:'||position||':'||i order by position,i)
          into v_keys from unnest(v_types) with ordinality as parts(output,position)
          cross join generate_series(1,v_quantity) i where output=v_output.output;
        v_receipt:=public.byeollog_commit_upbo_group_v1(p_workspace_id,jsonb_build_object(
          'soop_id',v_fan.soop_id,'fan',coalesce(nullif(v_fan.alias,''),nullif(v_fan.current_nickname,''),v_fan.soop_id),
          'event',p_decision->>'event','type',v_output.output,'keys',v_keys,
          'added_date',(v_row.occurred_at at time zone 'Asia/Seoul')::date,
          'source','soop_roulette_exception','taskSource','soop_roulette_exception'));
        if (v_receipt->>'added')::integer is distinct from v_quantity*v_output.occurrences then
          raise exception 'exception ledger conflict' using errcode='PT409';
        end if;
        v_outputs:=v_outputs||jsonb_build_array(jsonb_build_object('type',v_output.output,
          'quantity',v_quantity*v_output.occurrences,'receipt',v_receipt));
      end loop;
      v_details:=jsonb_build_object('fan',coalesce(nullif(v_fan.alias,''),v_fan.soop_id),
        'outputVersion',1,'outputs',v_outputs);
      if jsonb_array_length(v_outputs)=1 then v_details:=v_details||jsonb_build_object('receipt',v_receipt); end if;
    end if;
  end if;
  v_details:=coalesce(v_details,'{}'::jsonb)||jsonb_build_object('decision',p_decision);
  update public.byeollog_soop_core_roulette_results set review_status=v_action,
    reviewed_at=clock_timestamp(),reviewed_by=p_authorized_user_id,review_details=v_details
  where workspace_id=p_workspace_id and id=p_result_id;
  return jsonb_build_object('status',v_action,'details',v_details,'duplicate',false);
end $$;
revoke all on function public.resolve_soop_roulette_exception_v1(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.resolve_soop_roulette_exception_v1(uuid,uuid,uuid,jsonb) to service_role;



set lock_timeout='2s';
set statement_timeout='15s';
create or replace function public.resolve_soop_roulette_exception_v2(
  p_workspace_id uuid,p_authorized_user_id uuid,p_result_id uuid,p_decision jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='2s' set statement_timeout='8s'
as $$
declare v public.byeollog_soop_core_roulette_results%rowtype; t public.bangsel_tasks%rowtype;
  outputs jsonb; output jsonb;
  quantity integer; tracked integer; other_tracked integer; result jsonb; action text:=p_decision->>'action';
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_authorized_user_id and w.status='active'
      and lower(m.role::text) in ('owner','editor','manager')) then
    raise exception 'exception authorization failed' using errcode='42501';
  end if;
  -- Match the live ledger lock order: workspace, result row, then output/task.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('byeollog:roulette-write:'||p_workspace_id::text,0));
  select * into v from public.byeollog_soop_core_roulette_results where workspace_id=p_workspace_id and id=p_result_id for update;
  if not found or v.match_state='matched' or v.donation_id is not null then raise exception 'exception not found' using errcode='PT404';end if;
  if action='undo' then
    if v.review_status='pending' then return jsonb_build_object('status','pending','duplicate',true);end if;
    if v.review_status not in ('excluded','registered') then raise exception 'automatic exclusion cannot be undone' using errcode='PT409';end if;
    if v.review_status='registered' then
      -- Old registrations retain their one-task receipt, even when the old type contains &.
      outputs:=case when v.review_details->>'outputVersion'='1' then v.review_details->'outputs'
        else jsonb_build_array(jsonb_build_object('type',v.review_details->'decision'->>'type',
          'quantity',v.review_details->'decision'->'quantity','receipt',v.review_details->'receipt')) end;
      if jsonb_typeof(outputs) is distinct from 'array' then raise exception 'missing registration receipt' using errcode='PT409';end if;
      if jsonb_array_length(outputs) not between 1 and 20 then raise exception 'missing registration receipt' using errcode='PT409';end if;
      for output in select value from jsonb_array_elements(outputs) order by (value->>'type') collate "C"
      loop
      quantity:=(output->>'quantity')::integer;
      if quantity is null or quantity<1 then raise exception 'missing registration receipt' using errcode='PT409';end if;
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(jsonb_build_array(p_workspace_id,
        v.review_details->'decision'->>'soopId',v.review_details->'decision'->>'event',output->>'type')::text,1701));
      select * into t from public.bangsel_tasks where workspace_id=p_workspace_id and id=(output->'receipt'->>'taskId')::uuid for update;
      if not found or t.done_qty<>0 or t.total_qty<quantity
        or t.fan_soop_id is distinct from v.review_details->'decision'->>'soopId'
        or t.event is distinct from v.review_details->'decision'->>'event'
        or t.type is distinct from output->>'type' then raise exception 'upbo changed since registration' using errcode='PT409';end if;
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
      end loop;
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
