begin;
set local lock_timeout='1s';
set local statement_timeout='10s';

-- A retry reservation is not a technical failure when processing explicitly
-- reports a user/result wait. No new status or broader database role is needed.
create or replace function public.byeollog_finish_upbo_retry_v1(
  p_workspace_id uuid,p_source_uid text,p_uploaded_at timestamptz,
  p_retry_attempt integer,p_outcome text,p_reason text)
returns boolean language plpgsql security invoker set search_path='' set statement_timeout='5s'
as $function$
declare v_updated integer;
begin
  if p_workspace_id is null or p_source_uid is null or p_uploaded_at is null
    or p_retry_attempt is null or p_retry_attempt<1 or p_retry_attempt>5
    or p_outcome is null or p_reason is null
    or not ((p_outcome='waiting' and p_reason in ('unknown_rule','validation_review','no_roulette_result'))
      or (p_outcome='failed' and p_reason in ('processor_exception','processor_failed','invalid_special_roulette_decision')))
  then raise exception 'Invalid retry outcome' using errcode='22023'; end if;

  update public.bangsel_collector_staging s set
    process_status=case when p_outcome='waiting' then 'needs_review' else 'failed' end,
    upbo_retry_attempts=case when p_outcome='waiting' then s.upbo_retry_attempts-1 else s.upbo_retry_attempts end,
    upbo_retry_after=case when p_outcome='waiting' then null else s.upbo_retry_after end,
    processing_started_at=null,
    process_error=case when p_outcome='waiting' then null else 'retry_processing_failed: '||p_reason end
  where s.workspace_id=p_workspace_id and s.source_uid=p_source_uid
    and s.uploaded_at=p_uploaded_at and s.upbo_retry_protocol=1
    and s.upbo_retry_attempts=p_retry_attempt
    and (s.process_status='pending' or (p_outcome='waiting' and s.process_status='needs_review' and s.process_error is null));
  get diagnostics v_updated=row_count;
  return v_updated=1;
end $function$;
revoke all on function public.byeollog_finish_upbo_retry_v1(uuid,text,timestamptz,integer,text,text) from public,anon,authenticated;
grant execute on function public.byeollog_finish_upbo_retry_v1(uuid,text,timestamptz,integer,text,text) to service_role;

create or replace function public.byeollog_upbo_retry_schedule_v1()
returns trigger language plpgsql security invoker set search_path=''
as $function$
begin
  new.upbo_retry_protocol:=old.upbo_retry_protocol;
  if new.upbo_retry_protocol=1 and new.process_status is distinct from old.process_status then
    if new.process_status in ('processed','ignored','needs_review') then new.upbo_retry_after:=null;
    elsif new.process_status='failed' then
      if new.upbo_retry_attempts>=5 then
        new.process_status:='needs_review';new.processing_started_at:=null;new.upbo_retry_after:=null;
        new.process_error:=left('자동 처리 재시도 한도에 도달했습니다. 처리 내역을 확인해주세요. '||coalesce(new.process_error,''),2000);
      else
        new.upbo_retry_after:=now()+make_interval(secs=>least(960,60*(2^new.upbo_retry_attempts)::integer));
      end if;
    elsif new.process_status='processing' then new.upbo_retry_after:=now()+interval '11 minutes';
    elsif new.process_status='pending' and old.process_status='needs_review' then
      -- A new result/upload may make a waiting row processable. Keep the
      -- remaining technical budget and restore crash recovery for that update.
      new.upbo_retry_after:=now()+interval '2 minutes';
    end if;
  end if;
  return new;
end $function$;

notify pgrst,'reload schema';
commit;
