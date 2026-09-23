begin;

-- The Vercel Collector processor runs with the server-only service role and
-- needs read-only access to active automation rules.  Keep write privileges
-- revoked and do not widen access for anon/authenticated clients.
grant select on table public.rules to service_role;
grant select on table public.rule_conditions to service_role;
grant select on table public.rule_actions to service_role;

commit;
