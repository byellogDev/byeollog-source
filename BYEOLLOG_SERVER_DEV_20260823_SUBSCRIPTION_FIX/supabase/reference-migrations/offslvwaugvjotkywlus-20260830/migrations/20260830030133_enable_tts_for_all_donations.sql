-- Donation messages belong to the common overlay, not only to roulette spins.
-- Queue one TTS command after the visual presentation for ordinary balloons,
-- registered signature balloons, and roulette-triggering donations alike.

create or replace function public.ingest_native_overlay_soop_donation_v5(
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
  v_result jsonb;
  v_event_id uuid;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_service public.byeollog_native_roulette_services%rowtype;
  v_message text;
  v_tts_queued boolean:=false;
begin
  v_result:=public.ingest_native_overlay_soop_donation_v4(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,
    p_ceremony_image_url,p_occurred_at,p_donation_type_label);

  if coalesce((v_result->>'duplicate')::boolean,false) then
    return v_result||jsonb_build_object('ttsQueued',false);
  end if;

  v_event_id:=nullif(v_result->>'eventId','')::uuid;
  v_message:=nullif(left(btrim(p_message),300),'');
  if v_event_id is not null and v_message is not null and not exists(
    select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.workspace_id=p_workspace_id
      and outbox.event_id=v_event_id
      and outbox.command_kind='donation_chat_tts'
  ) then
    select event.* into strict v_event
    from byeollog_automation.native_roulette_events_v2 event
    where event.workspace_id=p_workspace_id and event.id=v_event_id;

    select service.* into strict v_service
    from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id and service.state='active';

    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
    v_tts_queued:=true;
  end if;

  return v_result||jsonb_build_object(
    'ttsQueued',v_tts_queued,
    'status',case
      when v_tts_queued or coalesce((v_result->>'ceremonyQueued')::boolean,false)
        then 'queued'
      else coalesce(v_result->>'status','ignored')
    end);
end
$function$;

revoke all on function public.ingest_native_overlay_soop_donation_v5(
  uuid,text,text,text,bigint,text,text,timestamptz,text)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_overlay_soop_donation_v5(
  uuid,text,text,text,bigint,text,text,timestamptz,text) to service_role;

comment on function public.ingest_native_overlay_soop_donation_v5(
  uuid,text,text,text,bigint,text,text,timestamptz,text) is
  'Service-only common-overlay ingestion. Every non-empty donation message is queued exactly once after its ordinary, signature, or roulette presentation.';

create or replace function public.enqueue_native_overlay_donation_test_v2(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_result jsonb;
  v_event_id uuid;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_service public.byeollog_native_roulette_services%rowtype;
  v_message text;
  v_tts_queued boolean:=false;
  v_presentation_count integer:=0;
begin
  v_result:=public.enqueue_native_overlay_donation_test_v1(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,p_occurred_at);

  if coalesce((v_result->>'duplicate')::boolean,false) then
    return v_result||jsonb_build_object('ttsQueued',false,'queued',false);
  end if;

  v_event_id:=nullif(v_result->>'eventId','')::uuid;
  v_message:=nullif(btrim(p_message),'');
  v_presentation_count:=greatest(0,coalesce((v_result->>'presentationCount')::integer,0));

  if v_event_id is not null and v_message is not null and not exists(
    select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.workspace_id=p_workspace_id
      and outbox.event_id=v_event_id
      and outbox.command_kind='donation_chat_tts'
  ) then
    select event.* into strict v_event
    from byeollog_automation.native_roulette_events_v2 event
    where event.workspace_id=p_workspace_id and event.id=v_event_id and event.is_test;

    select service.* into strict v_service
    from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id and service.state='active';

    perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
      v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      set is_test=true,payload=outbox.payload||jsonb_build_object(
        'testMode',true,'dataIsolation','manual_overlay_test')
    where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event_id
      and outbox.command_kind='donation_chat_tts';
    update byeollog_automation.native_roulette_events_v2 event
      set status='queued'
    where event.workspace_id=p_workspace_id and event.id=v_event_id and event.is_test;
    v_tts_queued:=true;
  end if;

  return v_result||jsonb_build_object(
    'ttsQueued',v_tts_queued,
    'queued',v_presentation_count>0 or v_tts_queued,
    'status',case when v_presentation_count>0 or v_tts_queued then 'queued' else 'ignored' end,
    'dataIsolation','manual_overlay_test','upboWrites',0,'statisticsWrites',0);
end
$function$;

revoke all on function public.enqueue_native_overlay_donation_test_v2(
  uuid,text,text,text,bigint,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_native_overlay_donation_test_v2(
  uuid,text,text,text,bigint,text,timestamptz) to service_role;

comment on function public.enqueue_native_overlay_donation_test_v2(
  uuid,text,text,text,bigint,text,timestamptz) is
  'Queues isolated ordinary, signature, or roulette donation presentation tests and reads every non-empty message without statistics, upbo, action, or wallpaper writes.';

;
