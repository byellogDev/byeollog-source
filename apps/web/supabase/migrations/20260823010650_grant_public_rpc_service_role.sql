-- Phase 1 of the zero-downtime public viewer migration. service_role already
-- bypasses RLS; this only lets the existing server credential call two fixed RPCs.
grant execute on function public.get_public_workspace(text) to service_role;
grant execute on function public.get_public_bangsel(text, text) to service_role;
