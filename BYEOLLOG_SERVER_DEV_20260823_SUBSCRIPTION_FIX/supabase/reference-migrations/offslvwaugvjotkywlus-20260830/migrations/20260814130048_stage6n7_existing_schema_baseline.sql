-- Stage 6N7 운영 스키마 채택 기준선.
-- 기존 운영 DB는 수동 SQL로 만들어졌으므로 DDL을 재실행하지 않고, 핵심 객체와
-- 접근 경계가 기대한 상태인지 검증한 뒤 이 시점을 migration 이력의 baseline으로 기록한다.
-- 빈 DB용 bootstrap 파일이 아니며, 이후 변경은 모두 별도 migration으로 적용한다.

do $$
declare
  v_name text;
  v_expected_tables text[] := array[
    'bangsel_collector_logs','bangsel_collector_staging','bangsel_donations',
    'bangsel_fan_stations','bangsel_fans','bangsel_roulette_invalidations',
    'bangsel_roulette_rules','bangsel_task_import_items','bangsel_tasks',
    'byeollog_audit_log','byeollog_collector_devices','byeollog_dashboard_handoffs',
    'byeollog_inquiries','byeollog_signup_applications','byeollog_workspace_members',
    'byeollog_workspace_settings','byeollog_workspaces'
  ];
begin
  foreach v_name in array v_expected_tables loop
    if to_regclass('public.' || v_name) is null then
      raise exception 'Stage 6N7 baseline mismatch: missing table public.%', v_name;
    end if;
  end loop;

  if exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname=any(v_expected_tables)
      and c.relkind='r' and not c.relrowsecurity
  ) then
    raise exception 'Stage 6N7 baseline mismatch: expected public table without RLS';
  end if;

  if to_regprocedure('public.get_public_bangsel(text,text)') is null
     or to_regprocedure('public.get_public_workspace(text)') is null
     or to_regprocedure('public.byeollog_approve_signup_application(uuid,uuid)') is null
     or to_regprocedure('public.byeollog_withdraw_account(uuid,uuid)') is null then
    raise exception 'Stage 6N7 baseline mismatch: required RPC is missing';
  end if;

  if pg_get_function_result('public.get_public_bangsel(text,text)'::regprocedure)
       <> 'TABLE(fan text, event text, type text, remaining integer, comment text)' then
    raise exception 'Stage 6N7 baseline mismatch: public donation result shape changed';
  end if;

  if pg_get_function_result('public.get_public_workspace(text)'::regprocedure)
       <> 'TABLE(slug text, display_name text, public_page_enabled boolean)' then
    raise exception 'Stage 6N7 baseline mismatch: public workspace result shape changed';
  end if;
end;
$$;
;
