-- Fix PostgreSQL 42702 when an existing guided rule is replaced.
--
-- save_guided_rule_compat_v1 returns a column named rule_id. In PL/pgSQL that
-- output parameter shares the function variable namespace, so the legacy
-- replacement branch's four unqualified `where rule_id = v_rule_id` clauses
-- are ambiguous. Patch only those clauses while preserving the complete live
-- function body, owner, ACL, SECURITY DEFINER, search_path, and timeout.

do $migration$
declare
  v_signature constant regprocedure :=
    'byeollog_automation.save_guided_rule_compat_v1(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,uuid,uuid,integer)'::regprocedure;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_definition text;
  v_patched text;
  v_verified text;
begin
  select p.oid, p.proowner, p.proacl, pg_catalog.pg_get_functiondef(p.oid)
    into strict v_oid, v_owner, v_acl, v_definition
  from pg_catalog.pg_proc as p
  where p.oid = v_signature;

  if pg_catalog.strpos(v_definition,
       'delete from public.rule_conditions where rule_id=v_rule_id;') = 0
     or pg_catalog.strpos(v_definition,
       'delete from public.rule_actions where rule_id=v_rule_id;') = 0
     or pg_catalog.strpos(v_definition,
       'delete from byeollog_automation.rule_conditions where rule_id=v_rule_id;') = 0
     or pg_catalog.strpos(v_definition,
       'delete from byeollog_automation.rule_actions where rule_id=v_rule_id;') = 0
  then
    raise exception 'save rule compatibility function baseline changed'
      using errcode = '55000';
  end if;

  v_patched := pg_catalog.replace(
    v_definition,
    'delete from public.rule_conditions where rule_id=v_rule_id;',
    'delete from public.rule_conditions as public_condition where public_condition.rule_id=v_rule_id;'
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'delete from public.rule_actions where rule_id=v_rule_id;',
    'delete from public.rule_actions as public_action where public_action.rule_id=v_rule_id;'
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'delete from byeollog_automation.rule_conditions where rule_id=v_rule_id;',
    'delete from byeollog_automation.rule_conditions as runtime_condition where runtime_condition.rule_id=v_rule_id;'
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'delete from byeollog_automation.rule_actions where rule_id=v_rule_id;',
    'delete from byeollog_automation.rule_actions as runtime_action where runtime_action.rule_id=v_rule_id;'
  );

  if v_patched = v_definition then
    raise exception 'save rule ambiguity patch made no change'
      using errcode = '55000';
  end if;

  execute v_patched;

  select pg_catalog.pg_get_functiondef(p.oid)
    into strict v_verified
  from pg_catalog.pg_proc as p
  where p.oid = v_signature
    and p.proowner = v_owner
    and p.proacl is not distinct from v_acl;

  if pg_catalog.strpos(v_verified, 'where rule_id=v_rule_id;') > 0
     or pg_catalog.strpos(v_verified,
       'public_condition.rule_id=v_rule_id') = 0
     or pg_catalog.strpos(v_verified,
       'public_action.rule_id=v_rule_id') = 0
     or pg_catalog.strpos(v_verified,
       'runtime_condition.rule_id=v_rule_id') = 0
     or pg_catalog.strpos(v_verified,
       'runtime_action.rule_id=v_rule_id') = 0
  then
    raise exception 'save rule ambiguity patch verification failed'
      using errcode = '55000';
  end if;
end
$migration$;;
