-- Run inside a transaction and ROLLBACK. Only the approved test workspace is touched.
-- Harness substitutes __REGISTER_SCHEMA__ with pg_temp (candidate) or public (deployed).
create temp table reauth_context as
select w.id as workspace_id,m.user_id,s.id as session_id,g.agent_runtime_revision,g.db_revision
from public.byeollog_workspaces w
join public.byeollog_workspace_members m on m.workspace_id=w.id and m.role='owner'
join auth.sessions s on s.user_id=m.user_id and (s.not_after is null or s.not_after>now())
cross join byeollog_automation.release_gate g
where w.display_name='테스트 스트리머' and w.status='active' and g.gate_id=1
and not exists(select 1 from byeollog_automation.agent_devices d where d.registration_session_id=s.id)
order by s.created_at desc limit 1;
create temp table reauth_checks(name text, passed boolean);
create or replace function pg_temp.check_registration(label text,device uuid,age_seconds int,expected text,
  secret text default repeat('a',64),actor_ok boolean default true,session_ok boolean default true,
  method text default 'password',runtime_ok boolean default true)
returns void language plpgsql as $$
declare c record; actual text; was_created boolean;
begin
  select * into strict c from reauth_context;
  begin
    select r.created into strict was_created from __REGISTER_SCHEMA__.g3a_register_agent_device_v1(
      c.workspace_id,device,'Reauthentication rollback fixture',secret,
      case when actor_ok then c.user_id else gen_random_uuid() end,
      case when session_ok then c.session_id else gen_random_uuid() end,
      floor(extract(epoch from clock_timestamp()))::bigint-age_seconds,method,'agent_runtime',
      case when runtime_ok then c.agent_runtime_revision else 'invalid-fixture' end,c.db_revision) r;
    actual:=case when was_created then 'created' else 'existing' end;
  exception when others then actual:=sqlstate;
  end;
  if actual is distinct from expected then
    raise exception 'reauth test % expected %, got %',label,expected,actual;
  end if;
  insert into reauth_checks values(label,true);
end;
$$;
do $$
declare device uuid:=gen_random_uuid(); fresh uuid:=gen_random_uuid(); c record; n int;
begin
 select * into strict c from reauth_context;
 perform pg_temp.check_registration('new device stale login denied',device,86400,'BL101');
 perform pg_temp.check_registration('new device missing login denied',device,null,'BL101');
 perform pg_temp.check_registration('new device future login denied',device,-120,'BL101');
 perform pg_temp.check_registration('new device noninteractive login denied',device,0,'BL101',method=>'token_refresh');
 perform pg_temp.check_registration('new device recent login accepted',device,0,'created');
 perform pg_temp.check_registration('existing device day-old login accepted',device,86400,'existing');
 perform pg_temp.check_registration('existing device no AMR accepted with secret',device,null,'existing',method=>null);
 perform pg_temp.check_registration('existing wrong secret denied',device,86400,'28000',repeat('b',64));
 perform pg_temp.check_registration('malformed secret denied',device,86400,'BL101','bad');
 perform pg_temp.check_registration('wrong workspace actor denied',device,86400,'BLR03',actor_ok=>false);
 perform pg_temp.check_registration('invalid session denied',device,86400,'BLR03',session_ok=>false);
 perform pg_temp.check_registration('wrong runtime denied',device,86400,'BLR03',runtime_ok=>false);
 update byeollog_automation.agent_devices set revoked_at=now() where workspace_id=c.workspace_id and device_id=device;
 perform pg_temp.check_registration('revoked device denied',device,86400,'28000');
 perform pg_temp.check_registration('one enrollment per session retained',fresh,0,'BL102');
 -- Select another unused, valid test-owner session; fill only temporary fixture rows.
 update reauth_context set session_id=(select s.id from auth.sessions s where s.user_id=c.user_id
   and (s.not_after is null or s.not_after>now())
   and not exists(select 1 from byeollog_automation.agent_devices d where d.registration_session_id=s.id)
   order by s.created_at desc limit 1);
 select count(*) into n from byeollog_automation.agent_devices where workspace_id=c.workspace_id and revoked_at is null;
 while n<5 loop
   insert into byeollog_automation.agent_devices(workspace_id,device_id,secret_hash,created_by_user_id,registration_session_id)
   values(c.workspace_id,gen_random_uuid(),decode(repeat('c',64),'hex'),c.user_id,gen_random_uuid());
   n:=n+1;
 end loop;
 perform pg_temp.check_registration('five active device limit retained',fresh,0,'BL103');
end $$;
select count(*) as passed, bool_and(passed) as all_passed from reauth_checks;
