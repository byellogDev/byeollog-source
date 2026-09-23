begin;
set local statement_timeout='10s';
set local lock_timeout='1s';
create temporary table retry_fixture (like public.bangsel_collector_staging including defaults);
create temporary table workspaces(id uuid,status text);
insert into workspaces values('00000000-0000-4000-8000-000000000001','active');
-- INJECT FUNCTIONS
create trigger test_retry_schedule before update on retry_fixture
  for each row execute function pg_temp.schedule_retry();
do $test$
declare
  w uuid:='00000000-0000-4000-8000-000000000001';
  v timestamptz:='2026-09-23T00:00:00Z';
  r record; n integer;
begin
  insert into retry_fixture(workspace_id,source_uid,session_id,uploaded_at,upbo_retry_protocol,upbo_retry_attempts,upbo_retry_after,process_status)
    values(w,'fixture','retry-fixture',v,1,0,now()-interval '1 minute','pending');
  select * into r from pg_temp.claim_retry(1);
  if r.upbo_retry_attempts<>1 then raise exception 'first reservation missing'; end if;
  if pg_temp.finish_retry(w,'fixture',v+interval '1 second',1,'waiting','unknown_rule') then raise exception 'stale version overwritten'; end if;
  if pg_temp.finish_retry('00000000-0000-4000-8000-000000000002','fixture',v,1,'waiting','unknown_rule') then raise exception 'cross-workspace overwrite'; end if;
  if not pg_temp.finish_retry(w,'fixture',v,1,'waiting','unknown_rule') then raise exception 'wait not saved'; end if;
  if pg_temp.finish_retry(w,'fixture',v,1,'waiting','unknown_rule') then raise exception 'duplicate refund'; end if;
  select * into r from retry_fixture;
  if r.upbo_retry_attempts<>0 or r.process_status<>'needs_review' or r.upbo_retry_after is not null or r.process_error is not null then raise exception 'human wait consumes budget'; end if;
  select count(*) into n from pg_temp.claim_retry(1);
  if n<>0 then raise exception 'human wait reclaimed'; end if;

  -- Existing errors retain their consumed budget, even when review is needed.
  update retry_fixture set process_status='failed',process_error='earlier technical error',upbo_retry_attempts=3;
  update retry_fixture set upbo_retry_after=now()-interval '1 second';
  select * into r from pg_temp.claim_retry(1);
  if r.upbo_retry_attempts<>4 then raise exception 'technical retry not reserved'; end if;
  perform pg_temp.finish_retry(w,'fixture',v,4,'waiting','validation_review');
  select * into r from retry_fixture;
  if r.upbo_retry_attempts<>3 or r.process_status<>'needs_review' then raise exception 'earlier failures reset'; end if;

  -- Late data reopens processing, without resetting real failures.
  update retry_fixture set process_status='pending',uploaded_at=v+interval '1 second';
  select * into r from retry_fixture;
  if r.upbo_retry_after is null or r.upbo_retry_after<>now()+interval '2 minutes' or r.upbo_retry_attempts<>3 then raise exception 'late result recovery not armed'; end if;
  if pg_temp.finish_retry(w,'fixture',v,3,'waiting','unknown_rule') then raise exception 'late result overwritten'; end if;
  update retry_fixture set process_status='processing',processing_started_at=now();
  if pg_temp.finish_retry(w,'fixture',v+interval '1 second',3,'waiting','unknown_rule') then raise exception 'in-flight work overwritten'; end if;
  update retry_fixture set process_status='processed';
  if pg_temp.finish_retry(w,'fixture',v+interval '1 second',3,'waiting','unknown_rule') then raise exception 'completed work overwritten'; end if;

  -- Five real failures still exhaust, including failures before row claiming.
  update retry_fixture set process_status='pending',uploaded_at=v,upbo_retry_attempts=5,process_error=null;
  if not pg_temp.finish_retry(w,'fixture',v,5,'failed','processor_exception') then raise exception 'failure not persisted'; end if;
  select * into r from retry_fixture;
  if r.process_status<>'needs_review' or r.upbo_retry_attempts<>5 or r.process_error not like '%processor_exception%' then raise exception 'technical exhaustion lost'; end if;
  if pg_temp.finish_retry(w,'fixture',v,5,'waiting','unknown_rule') then raise exception 'technical exhaustion erased'; end if;

  update retry_fixture set process_status='pending',upbo_retry_attempts=1,process_error=null;
  perform pg_temp.finish_retry(w,'fixture',v,1,'failed','invalid_special_roulette_decision');
  select * into r from retry_fixture;
  if r.process_status<>'failed' or r.upbo_retry_after is null then raise exception 'invalid stored data treated as human wait'; end if;

  -- A dead worker still reaches the old bounded exhaustion path.
  update retry_fixture set process_status='pending',upbo_retry_attempts=5,upbo_retry_after=now()-interval '1 minute';
  perform pg_temp.claim_retry(1);
  select * into r from retry_fixture;
  if r.process_status<>'needs_review' or r.upbo_retry_attempts<>5 then raise exception 'crash budget disabled'; end if;

  begin
    perform pg_temp.finish_retry(w,'fixture',v,1,'waiting','not_a_wait_reason');
    raise exception 'invalid reason accepted';
  exception when invalid_parameter_value then null; end;

  -- Missing-result waits stop retrying but can accept subsequent uploads.
  update retry_fixture set process_status='pending',upbo_retry_attempts=1,process_error=null;
  perform pg_temp.finish_retry(w,'fixture',v,1,'waiting','no_roulette_result');
  select * into r from retry_fixture;
  if r.upbo_retry_attempts<>0 or r.upbo_retry_after is not null then raise exception 'missing-result wait not stopped'; end if;
end $test$;
select 'passed: temporary DB state transitions, identity/version guards, retry budgets and crash recovery' as result;
rollback;
