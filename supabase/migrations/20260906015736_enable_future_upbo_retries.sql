-- POST-DEPLOY ONLY: verify all ingress/processor code uses the atomic RPC and
-- wait past the previous deployment's maximum in-flight duration first.
-- This changes future INSERTs only. Existing rows/failed history remain NULL.

set local lock_timeout='2s';
do $$ begin
  if not exists(select 1 from pg_catalog.pg_index i
    join pg_catalog.pg_class c on c.oid=i.indexrelid
    join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relname='byeollog_upbo_retry_due_idx' and i.indisvalid and i.indisready) then
    raise exception 'Valid concurrent retry index is required before activation';
  end if;
end $$;
alter table public.bangsel_collector_staging alter column upbo_retry_protocol set default 1;

-- To stop enrolling new rows: ALTER COLUMN upbo_retry_protocol DROP DEFAULT.
-- To pause the worker entirely, use BYEOLLOG_UPBO_RETRY_ENABLED=false.


