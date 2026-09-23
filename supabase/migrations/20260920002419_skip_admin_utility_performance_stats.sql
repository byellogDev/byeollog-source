begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
alter role postgres set pg_stat_statements.track_utility='off';
commit;
