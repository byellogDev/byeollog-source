begin;

grant select on table public.rules to service_role;
grant select on table public.rule_conditions to service_role;
grant select on table public.rule_actions to service_role;

commit;;
