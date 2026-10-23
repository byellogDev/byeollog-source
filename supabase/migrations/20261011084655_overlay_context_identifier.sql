begin;
set local lock_timeout='2s';
do $$declare f text;marker text;begin
 f:=pg_get_functiondef('private.enroll_overlay_v1(uuid,jsonb)'::regprocedure);
 marker:='coalesce(cfg->>''idx'','''')!~''^[0-9]+$''';
 if strpos(f,marker)=0 then raise exception 'overlay enrollment definition drift';end if;
 execute replace(f,marker,'coalesce(cfg->>''idx'','''')!~''^[A-Za-z0-9_-]{1,128}$''');
end $$;
commit;
