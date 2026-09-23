-- Fix PostgreSQL 42702 while saving a raffle rule.
--
-- save_guided_rule_v10_impl returns an OUT column named rule_id. PL/pgSQL
-- places that name in the function variable namespace, so the four bare
-- rule_id references added by the raffle refinement are ambiguous. Patch only
-- those references and fail closed if the live baseline is not the expected
-- function. CREATE OR REPLACE preserves the function owner and ACL; the final
-- checks also prove that its security boundary and runtime settings did not
-- drift.

do $migration$
declare
  v_signature constant regprocedure :=
    'byeollog_automation.save_guided_rule_v10_impl(uuid,text,boolean,integer,text,text,text,text,bigint,text,text,text[],integer,integer,uuid,text,integer,integer,integer,integer,boolean,integer,boolean,integer,integer,integer,integer,integer,integer,uuid,integer)'::regprocedure;
  v_owner oid;
  v_acl aclitem[];
  v_security_definer boolean;
  v_config text[];
  v_definition text;
  v_patched text;
  v_verified text;
begin
  select p.proowner, p.proacl, p.prosecdef, p.proconfig,
         pg_catalog.pg_get_functiondef(p.oid)
    into strict v_owner, v_acl, v_security_definer, v_config, v_definition
  from pg_catalog.pg_proc as p
  where p.oid = v_signature;

  if not v_security_definer
     or v_config is distinct from array['search_path=""', 'statement_timeout=10s']::text[]
  then
    raise exception 'save guided rule v10 security baseline changed'
      using errcode = '55000';
  end if;

  if pg_catalog.strpos(v_definition,
       'update public.rule_conditions'||chr(10)||
       '     set operator=v_amount_operator'||chr(10)||
       '   where rule_id=v_rule_id and path=''amount'';') = 0
     or pg_catalog.strpos(v_definition,
       'update byeollog_automation.rule_conditions'||chr(10)||
       '     set operator=v_amount_operator'||chr(10)||
       '   where rule_id=v_rule_id and path=''amount'';') = 0
     or pg_catalog.strpos(v_definition,
       'update public.rule_actions set params=v_params where rule_id=v_rule_id and position=0;') = 0
     or pg_catalog.strpos(v_definition,
       'update byeollog_automation.rule_actions set params=v_params where rule_id=v_rule_id and position=0;') = 0
  then
    raise exception 'save guided rule v10 ambiguity baseline changed'
      using errcode = '55000';
  end if;

  v_patched := pg_catalog.replace(
    v_definition,
    'update public.rule_conditions'||chr(10)||
    '     set operator=v_amount_operator'||chr(10)||
    '   where rule_id=v_rule_id and path=''amount'';',
    'update public.rule_conditions as public_condition'||chr(10)||
    '     set operator=v_amount_operator'||chr(10)||
    '   where public_condition.rule_id=v_rule_id and public_condition.path=''amount'';'
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'update byeollog_automation.rule_conditions'||chr(10)||
    '     set operator=v_amount_operator'||chr(10)||
    '   where rule_id=v_rule_id and path=''amount'';',
    'update byeollog_automation.rule_conditions as runtime_condition'||chr(10)||
    '     set operator=v_amount_operator'||chr(10)||
    '   where runtime_condition.rule_id=v_rule_id and runtime_condition.path=''amount'';'
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'update public.rule_actions set params=v_params where rule_id=v_rule_id and position=0;',
    'update public.rule_actions as public_action set params=v_params where public_action.rule_id=v_rule_id and public_action.position=0;'
  );
  v_patched := pg_catalog.replace(
    v_patched,
    'update byeollog_automation.rule_actions set params=v_params where rule_id=v_rule_id and position=0;',
    'update byeollog_automation.rule_actions as runtime_action set params=v_params where runtime_action.rule_id=v_rule_id and runtime_action.position=0;'
  );

  if v_patched = v_definition then
    raise exception 'save guided rule v10 ambiguity patch made no change'
      using errcode = '55000';
  end if;

  execute v_patched;

  select pg_catalog.pg_get_functiondef(p.oid)
    into strict v_verified
  from pg_catalog.pg_proc as p
  where p.oid = v_signature
    and p.proowner = v_owner
    and p.proacl is not distinct from v_acl
    and p.prosecdef = v_security_definer
    and p.proconfig is not distinct from v_config;

  if pg_catalog.strpos(v_verified, 'where rule_id=v_rule_id') > 0
     or pg_catalog.strpos(v_verified, 'public_condition.rule_id=v_rule_id') = 0
     or pg_catalog.strpos(v_verified, 'runtime_condition.rule_id=v_rule_id') = 0
     or pg_catalog.strpos(v_verified, 'public_action.rule_id=v_rule_id') = 0
     or pg_catalog.strpos(v_verified, 'runtime_action.rule_id=v_rule_id') = 0
  then
    raise exception 'save guided rule v10 ambiguity patch verification failed'
      using errcode = '55000';
  end if;
end
$migration$;


