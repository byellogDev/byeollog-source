-- Apply only after the lease-aware gateway and API are both deployed. Keeping
-- this as a separate finalization step permits a no-loss rolling deployment.
revoke all on function public.ingest_soop_core_donation_v1(
  uuid,text,text,text,bigint,text,text,timestamptz,text,text) from service_role;

revoke all on function public.ingest_soop_external_roulette_result_v2(
  uuid,text,text,text,text,text,text,text,timestamptz,text) from service_role;
