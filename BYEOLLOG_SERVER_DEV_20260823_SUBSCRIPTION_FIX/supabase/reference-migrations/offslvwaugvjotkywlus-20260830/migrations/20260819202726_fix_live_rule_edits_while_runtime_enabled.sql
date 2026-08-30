begin;

-- Public release keeps the runtime gate enabled during normal operation.
-- Rule authoring is separately authorized by the compatibility RPCs, so the
-- mutation trigger must serialize plan changes without requiring an outage.
create or replace function byeollog_automation.guard_rule_mutation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
as $function$
declare
  v_workspace_id uuid;
  v_rule_id uuid;
begin
  if tg_table_name = 'rules' then
    if tg_op = 'UPDATE' and new.workspace_id is distinct from old.workspace_id then
      raise exception 'rule workspace identity is immutable' using errcode = '22023';
    end if;
    v_workspace_id := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  else
    if tg_op = 'UPDATE' and new.rule_id is distinct from old.rule_id then
      raise exception 'rule child identity is immutable' using errcode = '22023';
    end if;
    v_rule_id := case when tg_op = 'DELETE' then old.rule_id else new.rule_id end;
    select r.workspace_id into v_workspace_id
    from byeollog_automation.rules r
    where r.id = v_rule_id;
    -- A cascaded child delete already holds the parent rule's advisory lock.
    if not found and tg_op <> 'DELETE' then
      raise exception 'rule parent is missing' using errcode = '23503';
    end if;
  end if;

  if v_workspace_id is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('g3a-rule-plan:' || v_workspace_id::text, 3200)
    );
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

alter function byeollog_automation.guard_rule_mutation_v1() owner to postgres;
revoke all on function byeollog_automation.guard_rule_mutation_v1()
  from public, anon, authenticated, service_role;

do $verify$
declare
  v_definition text;
  v_trigger_count integer;
begin
  select pg_catalog.pg_get_functiondef(
    'byeollog_automation.guard_rule_mutation_v1()'::regprocedure
  ) into v_definition;

  if v_definition ilike '%release_gate%'
     or v_definition ilike '%global runtime gate is disabled%' then
    raise exception 'live rule edit guard replacement did not take effect';
  end if;

  if v_definition not ilike '%pg_advisory_xact_lock%'
     or v_definition not ilike '%rule workspace identity is immutable%'
     or v_definition not ilike '%rule child identity is immutable%' then
    raise exception 'rule mutation integrity checks are incomplete';
  end if;

  select count(*) into v_trigger_count
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where not t.tgisinternal
    and n.nspname = 'byeollog_automation'
    and c.relname in ('rules', 'rule_conditions', 'rule_actions')
    and t.tgfoid = 'byeollog_automation.guard_rule_mutation_v1()'::regprocedure;

  if v_trigger_count <> 3 then
    raise exception 'expected three rule mutation guards, found %', v_trigger_count;
  end if;
end;
$verify$;

commit;
;
