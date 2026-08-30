-- SOOP emits ordinary balloons, battle missions and challenge missions as
-- distinct official Chat SDK actions. Preserve the explicit provider kind in
-- presentation payloads without changing the isolated roulette event model.

create or replace function public.ingest_native_overlay_soop_donation_v4(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_ceremony_image_url text,p_occurred_at timestamptz,
  p_donation_type_label text)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_result jsonb;v_event_id uuid;v_label text;
begin
  v_label:=btrim(coalesce(p_donation_type_label,''));
  if v_label not in ('별풍선','대결미션','도전미션') then
    raise exception 'SOOP donation type is invalid' using errcode='22023';
  end if;

  v_result:=public.ingest_native_overlay_soop_donation_v3(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,
    p_ceremony_image_url,p_occurred_at);
  v_event_id:=nullif(v_result->>'eventId','')::uuid;

  if v_event_id is not null then
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      set payload=outbox.payload||jsonb_build_object('donationTypeLabel',v_label)
    where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event_id
      and outbox.command_kind in ('roulette_spin','donation_ceremony');
  end if;

  return v_result||jsonb_build_object('donationTypeLabel',v_label);
end
$function$;

revoke all on function public.ingest_native_overlay_soop_donation_v4(
  uuid,text,text,text,bigint,text,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_overlay_soop_donation_v4(
  uuid,text,text,text,bigint,text,text,timestamptz,text) to service_role;

comment on function public.ingest_native_overlay_soop_donation_v4(
  uuid,text,text,text,bigint,text,text,timestamptz,text) is
  'Service-only SOOP ingestion wrapper that preserves the official donation action label in common-overlay payloads.';;
