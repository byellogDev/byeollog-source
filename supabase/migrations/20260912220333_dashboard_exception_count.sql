begin;
set local lock_timeout='3s';
-- Small counters, never return donor identity or the full staging payload to polling clients.
create or replace function public.byeollog_dashboard_counts_v1(p_workspace_id uuid,p_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s'
as $$
begin
  if not exists(select 1 from public.byeollog_workspace_members m join public.byeollog_workspaces w on w.id=m.workspace_id
    where m.workspace_id=p_workspace_id and m.user_id=p_user_id and w.status='active') then
    raise exception 'workspace authorization failed' using errcode='42501';
  end if;
  return jsonb_build_object(
    'reviewCount',(select count(*) from public.bangsel_collector_staging where workspace_id=p_workspace_id and process_status in ('pending','needs_review','failed')),
    'pendingCount',(select count(*) from public.byeollog_soop_core_donations where workspace_id=p_workspace_id and status in ('pending','collecting') and expected_spins is not null and result_count<expected_spins),
    'exceptionCount',(select count(*) from public.byeollog_soop_core_roulette_results where workspace_id=p_workspace_id and match_state<>'matched' and review_status='pending'),
    'checkedAt',clock_timestamp());
end $$;
revoke all on function public.byeollog_dashboard_counts_v1(uuid,uuid) from public,anon,authenticated;
grant execute on function public.byeollog_dashboard_counts_v1(uuid,uuid) to service_role;
commit;


