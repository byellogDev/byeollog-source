-- Stage 6N8: 가입 승인 복구, 공유 rate limit, 운영 데이터 보존 정책.

-- 1) 가입 승인 상태와 메일 전송 결과를 명시적으로 기록한다.
alter table public.byeollog_signup_applications
  add column if not exists provisioning_state text not null default 'pending',
  add column if not exists setup_email_sent_at timestamptz,
  add column if not exists setup_email_last_attempt_at timestamptz,
  add column if not exists setup_email_last_error text,
  add column if not exists setup_email_attempts integer not null default 0,
  add column if not exists status_token_issued_at timestamptz;

alter table public.byeollog_signup_applications
  drop constraint if exists byeollog_signup_applications_provisioning_state_check;
alter table public.byeollog_signup_applications
  add constraint byeollog_signup_applications_provisioning_state_check
  check (provisioning_state in ('pending','auth_created','approved','email_sent','email_failed'));

update public.byeollog_signup_applications
set provisioning_state = case
  when status = 'approved' then 'approved'
  when auth_user_id is not null then 'auth_created'
  else 'pending'
end
where provisioning_state = 'pending';

update public.byeollog_signup_applications
set status_token_issued_at = coalesce(status_token_issued_at, created_at)
where status_token_hash is not null;

-- 보상 삭제 시 신청서가 함께 사라지지 않도록 Auth FK를 SET NULL로 바꾼다.
alter table public.byeollog_signup_applications
  drop constraint if exists byeollog_signup_applications_auth_user_id_fkey;
alter table public.byeollog_signup_applications
  add constraint byeollog_signup_applications_auth_user_id_fkey
  foreign key (auth_user_id) references auth.users(id) on delete set null;

create index if not exists byeollog_signup_applications_reviewed_by_idx
  on public.byeollog_signup_applications(reviewed_by);
create index if not exists byeollog_signup_applications_workspace_id_idx
  on public.byeollog_signup_applications(workspace_id);

create or replace function public.byeollog_record_setup_email(
  p_application_id uuid,
  p_ok boolean,
  p_error text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempts integer;
begin
  update public.byeollog_signup_applications
  set provisioning_state=case when p_ok then 'email_sent' else 'email_failed' end,
      setup_email_sent_at=case when p_ok then now() else setup_email_sent_at end,
      setup_email_last_attempt_at=now(),
      setup_email_last_error=case when p_ok then '' else left(coalesce(p_error,''),500) end,
      setup_email_attempts=setup_email_attempts+1,
      updated_at=now()
  where id=p_application_id
  returning setup_email_attempts into v_attempts;
  if not found then raise exception 'signup application not found'; end if;
  return jsonb_build_object('ok',true,'attempts',v_attempts);
end;
$$;
revoke all on function public.byeollog_record_setup_email(uuid,boolean,text) from public, anon, authenticated;
grant execute on function public.byeollog_record_setup_email(uuid,boolean,text) to service_role;

-- 2) 모든 서버리스 인스턴스가 공유하는 fixed-window rate limit.
create table if not exists public.byeollog_rate_limits (
  key_hash text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  hits integer not null default 0 check (hits >= 0),
  window_started_at timestamptz not null default now(),
  expires_at timestamptz not null
);
alter table public.byeollog_rate_limits enable row level security;
revoke all on table public.byeollog_rate_limits from public, anon, authenticated;
grant select, insert, update, delete on table public.byeollog_rate_limits to service_role;
create index if not exists byeollog_rate_limits_expires_at_idx
  on public.byeollog_rate_limits(expires_at);

create or replace function public.byeollog_take_rate_limit(
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table(limited boolean, current_hits integer, retry_after_seconds integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_row public.byeollog_rate_limits%rowtype;
begin
  if p_key_hash !~ '^[0-9a-f]{64}$' then raise exception 'invalid key hash'; end if;
  if p_limit < 1 or p_limit > 1000 then raise exception 'invalid limit'; end if;
  if p_window_seconds < 1 or p_window_seconds > 86400 then raise exception 'invalid window'; end if;

  insert into public.byeollog_rate_limits(key_hash,hits,window_started_at,expires_at)
  values(p_key_hash,1,v_now,v_now + make_interval(secs => p_window_seconds))
  on conflict(key_hash) do update set
    hits = case when byeollog_rate_limits.expires_at <= v_now then 1 else byeollog_rate_limits.hits + 1 end,
    window_started_at = case when byeollog_rate_limits.expires_at <= v_now then v_now else byeollog_rate_limits.window_started_at end,
    expires_at = case when byeollog_rate_limits.expires_at <= v_now then v_now + make_interval(secs => p_window_seconds) else byeollog_rate_limits.expires_at end
  returning * into v_row;

  return query select
    v_row.hits > p_limit,
    v_row.hits,
    greatest(0,ceil(extract(epoch from (v_row.expires_at-v_now))))::integer;
end;
$$;
revoke all on function public.byeollog_take_rate_limit(text,integer,integer) from public, anon, authenticated;
grant execute on function public.byeollog_take_rate_limit(text,integer,integer) to service_role;

-- 3) Collector 진단 로그에 테넌트 귀속과 명시적 보존기한을 추가한다.
alter table public.bangsel_collector_logs
  add column if not exists workspace_id uuid,
  add column if not exists device_id uuid,
  add column if not exists retained_until timestamptz not null default (now() + interval '30 days');

alter table public.bangsel_collector_logs
  drop constraint if exists bangsel_collector_logs_workspace_id_fkey;
alter table public.bangsel_collector_logs
  add constraint bangsel_collector_logs_workspace_id_fkey
  foreign key (workspace_id) references public.byeollog_workspaces(id) on delete cascade;
alter table public.bangsel_collector_logs
  drop constraint if exists bangsel_collector_logs_device_id_fkey;
alter table public.bangsel_collector_logs
  add constraint bangsel_collector_logs_device_id_fkey
  foreign key (device_id) references public.byeollog_collector_devices(id) on delete cascade;
create index if not exists bangsel_collector_logs_workspace_id_idx
  on public.bangsel_collector_logs(workspace_id);
create index if not exists bangsel_collector_logs_retained_until_idx
  on public.bangsel_collector_logs(retained_until);
comment on table public.bangsel_collector_logs is
  'Collector 서버 진단 로그. workspace/device에 귀속하며 최대 30일 보관 후 자동 삭제한다.';

-- 기존 14건은 workspace를 신뢰성 있게 복원할 수 없어 개인정보 최소화 원칙에 따라 제거한다.
delete from public.bangsel_collector_logs where workspace_id is null;

alter table public.bangsel_collector_logs
  alter column workspace_id set not null;

-- 4) 일일 cron에서 호출할 운영 데이터 정리 함수.
create or replace function public.byeollog_cleanup_operational_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_rate integer := 0;
  v_handoffs integer := 0;
  v_pending_devices integer := 0;
  v_revoked_devices integer := 0;
  v_expired_devices integer := 0;
  v_logs integer := 0;
begin
  delete from public.byeollog_rate_limits where expires_at < now() - interval '1 day';
  get diagnostics v_rate = row_count;

  delete from public.byeollog_dashboard_handoffs
  where expires_at < now() - interval '7 days' or used_at < now() - interval '7 days';
  get diagnostics v_handoffs = row_count;

  update public.byeollog_collector_devices
  set status='revoked',token_hash=null,revoked_at=coalesce(revoked_at,now())
  where status='active' and token_expires_at < now();
  get diagnostics v_expired_devices = row_count;

  delete from public.byeollog_collector_devices
  where status='pending'
    and coalesce(pairing_expires_at,created_at) < now() - interval '7 days';
  get diagnostics v_pending_devices = row_count;

  delete from public.byeollog_collector_devices
  where status='revoked'
    and coalesce(revoked_at,created_at) < now() - interval '30 days';
  get diagnostics v_revoked_devices = row_count;

  delete from public.bangsel_collector_logs where retained_until < now();
  get diagnostics v_logs = row_count;

  return jsonb_build_object(
    'ok',true,
    'rate_limits_deleted',v_rate,
    'handoffs_deleted',v_handoffs,
    'active_devices_expired',v_expired_devices,
    'pending_devices_deleted',v_pending_devices,
    'revoked_devices_deleted',v_revoked_devices,
    'collector_logs_deleted',v_logs
  );
end;
$$;
revoke all on function public.byeollog_cleanup_operational_data() from public, anon, authenticated;
grant execute on function public.byeollog_cleanup_operational_data() to service_role;

-- 5) 공개 SECURITY DEFINER RPC의 의도와 최소 반환 필드를 migration에 고정한다.
do $$
begin
  if to_regprocedure('public.get_public_bangsel(text,text)') is null
     or to_regprocedure('public.get_public_workspace(text)') is null then
    raise exception 'required public RPC is missing';
  end if;
  if pg_get_function_result('public.get_public_bangsel(text,text)'::regprocedure)
       <> 'TABLE(fan text, event text, type text, remaining integer, comment text)' then
    raise exception 'get_public_bangsel exposes an unexpected result shape';
  end if;
  if pg_get_function_result('public.get_public_workspace(text)'::regprocedure)
       <> 'TABLE(slug text, display_name text, public_page_enabled boolean)' then
    raise exception 'get_public_workspace exposes an unexpected result shape';
  end if;
end;
$$;

revoke all on function public.get_public_bangsel(text,text) from public;
grant execute on function public.get_public_bangsel(text,text) to anon, authenticated;
comment on function public.get_public_bangsel(text,text) is
  '시청자 공개 페이지 전용. 공개·활성 workspace의 fan/event/type/remaining/comment만 반환하며 식별 SOOP ID와 관리자 memo는 반환하지 않는다.';

revoke all on function public.get_public_workspace(text) from public;
grant execute on function public.get_public_workspace(text) to anon, authenticated;
comment on function public.get_public_workspace(text) is
  '시청자 공개 페이지 존재 확인 전용. slug/display_name/public_page_enabled만 반환한다.';

-- 6) workspace 인자 없는 구형 함수는 오호출 위험이 있으므로 제거한다.
drop function if exists public.bangsel_void_roulette(text,text);

