begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
do $guard$
begin
 if to_regprocedure('extensions.pg_stat_statements(boolean)') is null then raise exception 'Expected query statistics function is missing'; end if;
 if exists(select 1 from pg_proc where oid='extensions.pg_stat_statements(boolean)'::regprocedure and prosecdef) then raise exception 'Unexpected SECURITY DEFINER query statistics function'; end if;
end $guard$;
alter function extensions.pg_stat_statements(boolean) set work_mem='8MB';
commit;
