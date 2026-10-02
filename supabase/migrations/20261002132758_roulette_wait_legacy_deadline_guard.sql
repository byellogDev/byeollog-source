begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
-- The bounded cleanup can leave more than 1,000 expired rows for the next tick.
-- Apply the deadline to every legacy candidate query as well as cleanup.
do $patch$
declare f text; signature regprocedure; marker text; replacement text;
begin
 select p.oid::regprocedure into strict signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='ingest_soop_external_roulette_result_v1';
 f:=pg_get_functiondef(signature);
 marker:='and donation.status';
 replacement:=$new$and greatest(donation.occurred_at,donation.last_result_at)>clock_timestamp()-interval '3 minutes'
    and greatest(donation.occurred_at,donation.last_result_at)>p_occurred_at-interval '3 minutes'
    and donation.status$new$;
 if (length(f)-length(replace(f,marker,'')))/length(marker)<>6 then
  raise exception 'unexpected legacy roulette candidate queries';
 end if;
 execute replace(f,marker,replacement);
end $patch$;
commit;
