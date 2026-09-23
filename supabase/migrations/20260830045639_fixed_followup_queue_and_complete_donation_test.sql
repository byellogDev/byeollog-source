-- Follow-up chat is a fixed playback grace period. A queued donation may
-- preempt an idle final card, while the preferred event still keeps every
-- already-enqueued series spin and donation message contiguous.

update public.byeollog_native_roulette_services service
set activation_snapshot=jsonb_set(
  service.activation_snapshot,'{followupChatTtsWindowSeconds}','15'::jsonb,true)
where service.activation_snapshot is not null
  and service.activation_snapshot->>'followupChatTtsWindowSeconds' is distinct from '15';

update public.byeollog_roulette_drafts draft
set draft=jsonb_set(draft.draft,'{followupChatTtsWindowSeconds}','15'::jsonb,true)
where draft.draft->>'followupChatTtsWindowSeconds' is distinct from '15';

update byeollog_automation.native_roulette_chat_waits_v2 wait
set expires_at=wait.opens_at+interval '15 seconds'
where wait.status='pending'
  and wait.expires_at is distinct from wait.opens_at+interval '15 seconds';

create or replace function public.claim_native_roulette_overlay_v5(
  p_workspace_id uuid,
  p_token_version uuid,
  p_client_id text,
  p_preferred_event_id uuid default null,
  p_limit integer default 1,
  p_lease_seconds integer default 90)
returns table(
  command_id uuid,
  command_kind text,
  payload jsonb,
  attempt_count integer,
  lease_expires_at timestamptz,
  event_id uuid,
  event_occurred_at timestamptz,
  activation_snapshot jsonb)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
begin
  return query
  select claimed.*
  from public.claim_native_roulette_overlay_v4(
    p_workspace_id,p_token_version,p_client_id,p_preferred_event_id,
    p_limit,p_lease_seconds) claimed;
  if found or p_preferred_event_id is null then return; end if;

  -- No command remains for the visible event. Claim the oldest ready command
  -- from the shared OBS queue so an idle chat grace period never blocks the
  -- next donation. The browser defensively suppresses any late old-event chat.
  return query
  select claimed.*
  from public.claim_native_roulette_overlay_v4(
    p_workspace_id,p_token_version,p_client_id,null,p_limit,p_lease_seconds) claimed;
end
$function$;

revoke all on function public.claim_native_roulette_overlay_v5(
  uuid,uuid,text,uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_overlay_v5(
  uuid,uuid,text,uuid,integer,integer)
  to service_role;

comment on function public.claim_native_roulette_overlay_v5(
  uuid,uuid,text,uuid,integer,integer) is
  'Claims the preferred donation contiguously, then immediately advances to the shared OBS queue when that event has no ready command.';

create or replace function public.enqueue_native_overlay_donation_test_v3(
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

  if v_event_id is not null then
    select event.* into strict v_event
    from byeollog_automation.native_roulette_events_v2 event
    where event.workspace_id=p_workspace_id and event.id=v_event_id and event.is_test;

    select service.* into strict v_service
    from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id and service.state='active';

    -- An ordinary test amount may have neither a signature image nor a
    -- roulette trigger. It still needs the same donor/type/amount card. The
    -- application resolves source=none to SOOP's official default image.
    if v_presentation_count=0 then
      insert into byeollog_automation.native_roulette_overlay_outbox_v2(
        workspace_id,event_id,command_kind,payload,expires_at,is_test)
      values(p_workspace_id,v_event_id,'donation_ceremony',jsonb_build_object(
        'schemaVersion',6,'kind','donation_ceremony','donationEventId',btrim(p_event_id),
        'actor',jsonb_build_object('name',p_actor_name),'amount',p_amount,
        'donationTypeLabel','별풍선','ceremony',jsonb_build_object('source','none'),
        'testMode',true,'dataIsolation','manual_overlay_test'),
        clock_timestamp()+interval '2 minutes',true);
      v_presentation_count:=1;
    end if;

    if v_message is not null and not exists(
      select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event_id
        and outbox.command_kind='donation_chat_tts'
    ) then
      perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
        v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
      update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      set is_test=true,payload=outbox.payload||jsonb_build_object(
        'testMode',true,'dataIsolation','manual_overlay_test')
      where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event_id
        and outbox.command_kind='donation_chat_tts';
      v_tts_queued:=true;
    end if;

    update byeollog_automation.native_roulette_events_v2 event
    set status='queued'
    where event.workspace_id=p_workspace_id and event.id=v_event_id and event.is_test;
  end if;

  return v_result||jsonb_build_object(
    'presentationCount',v_presentation_count,'ttsQueued',v_tts_queued,
    'queued',v_presentation_count>0 or v_tts_queued,'status','queued',
    'dataIsolation','manual_overlay_test','upboWrites',0,'statisticsWrites',0);
end
$function$;

revoke all on function public.enqueue_native_overlay_donation_test_v3(
  uuid,text,text,text,bigint,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.enqueue_native_overlay_donation_test_v3(
  uuid,text,text,text,bigint,text,timestamptz)
  to service_role;

comment on function public.enqueue_native_overlay_donation_test_v3(
  uuid,text,text,text,bigint,text,timestamptz) is
  'Queues a complete isolated donation card for every test amount, followed by its optional message TTS, without statistics, upbo, action, or wallpaper writes.';


