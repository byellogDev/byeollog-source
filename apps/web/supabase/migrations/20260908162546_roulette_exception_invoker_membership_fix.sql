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
    select * into v_fan from public.bangsel_fans
      where workspace_id=p_workspace_id and soop_id=p_decision->>'soopId' for share;
    if not found then raise exception 'fan not found' using errcode='PT404'; end if;
    -- A user may have taught the result as non-upbo since the list was opened.
    if exists(select 1 from public.bangsel_roulette_rules r where r.workspace_id=p_workspace_id
      and r.result_text=v_row.result_text and r.action='exclude') then
      v_action:='auto_excluded';
      v_details:=jsonb_build_object('reason','known_non_upbo','ruleAction','exclude');
    else
      select jsonb_agg('soop-exception:'||p_result_id::text||':'||i order by i)
        into v_keys from generate_series(1,v_quantity) i;
      v_receipt:=public.byeollog_commit_upbo_group_v1(p_workspace_id,jsonb_build_object(
        'soop_id',v_fan.soop_id,'fan',coalesce(nullif(v_fan.alias,''),nullif(v_fan.current_nickname,''),v_fan.soop_id),
        'event',p_decision->>'event','type',p_decision->>'type','keys',v_keys,
        'added_date',(v_row.occurred_at at time zone 'Asia/Seoul')::date,
        'source','soop_roulette_exception','taskSource','soop_roulette_exception'));
      if (v_receipt->>'added')::integer is distinct from v_quantity then
        raise exception 'exception ledger conflict' using errcode='PT409';
      end if;
      v_details:=jsonb_build_object('fan',coalesce(nullif(v_fan.alias,''),v_fan.soop_id),'receipt',v_receipt);
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
