-- SOOP can emit the BALLOON_GIFTED event and its visible donation message with
-- different user-id representations even though the nickname is identical.
-- Keep provider id as the primary identity, but allow an exact normalized
-- nickname match inside the donation's bounded follow-up window.

alter table byeollog_automation.native_roulette_chat_waits_v2
  add column if not exists actor_name text;

update byeollog_automation.native_roulette_chat_waits_v2 wait
set actor_name=event.actor_name
from byeollog_automation.native_roulette_events_v2 event
where event.id=wait.event_id and wait.actor_name is null;

do $block$
begin
  if not exists(
    select 1 from pg_catalog.pg_constraint
    where conname='native_roulette_chat_waits_v2_actor_name_check'
      and conrelid='byeollog_automation.native_roulette_chat_waits_v2'::regclass
  ) then
    alter table byeollog_automation.native_roulette_chat_waits_v2
      add constraint native_roulette_chat_waits_v2_actor_name_check
      check (
        actor_name is null
        or (char_length(actor_name) between 1 and 120 and actor_name!~'[[:cntrl:]]')
      ) not valid;
  end if;
end
$block$;

alter table byeollog_automation.native_roulette_chat_waits_v2
  validate constraint native_roulette_chat_waits_v2_actor_name_check;

create index if not exists native_roulette_chat_waits_v2_name_match_idx
  on byeollog_automation.native_roulette_chat_waits_v2(
    workspace_id,lower(actor_name),opens_at desc)
  where status='pending' and actor_name is not null;

create index if not exists native_roulette_chat_buffer_v2_name_match_idx
  on byeollog_automation.native_roulette_chat_buffer_v2(
    workspace_id,lower(actor_name),occurred_at)
  where consumed_event_id is null;

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
  v_buffer byeollog_automation.native_roulette_chat_buffer_v2%rowtype;
  v_message text;
  v_window integer;
  v_elapsed integer;
  v_tts_queued boolean:=false;
  v_followup_armed boolean:=false;
  v_match_kind text;
begin
  v_result:=public.ingest_native_overlay_soop_donation_v4(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,
    p_ceremony_image_url,p_occurred_at,p_donation_type_label);

  if coalesce((v_result->>'duplicate')::boolean,false) then
    return v_result||jsonb_build_object(
      'ttsQueued',false,'followupArmed',false,'messageMatchKind',null);
  end if;

  v_event_id:=nullif(v_result->>'eventId','')::uuid;
  v_message:=nullif(left(btrim(p_message),300),'');

  if v_event_id is not null then
    select event.* into strict v_event
    from byeollog_automation.native_roulette_events_v2 event
    where event.workspace_id=p_workspace_id and event.id=v_event_id;

    select service.* into strict v_service
    from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id and service.state='active';

    v_window:=greatest(0,least(120,coalesce(
      (v_service.activation_snapshot->>'followupChatTtsWindowSeconds')::integer,10)));

    -- The roulette ingest may already have created an id-only wait. Attach the
    -- provider nickname before a chat tries the fallback identity.
    update byeollog_automation.native_roulette_chat_waits_v2 wait
    set actor_name=btrim(p_actor_name)
    where wait.event_id=v_event_id and wait.actor_name is null;

    if v_message is not null and not exists(
      select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      where outbox.workspace_id=p_workspace_id
        and outbox.event_id=v_event_id
        and outbox.command_kind='donation_chat_tts'
    ) then
      perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
        v_event,v_message,null,0,'donation_message',v_service.tts_volume_percent);
      v_tts_queued:=true;
      v_match_kind:='donation_message';
    elsif v_message is null and v_window>0 and not exists(
      select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      where outbox.workspace_id=p_workspace_id
        and outbox.event_id=v_event_id
        and outbox.command_kind='donation_chat_tts'
    ) then
      perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        'native-roulette-v2-chat-name:'||p_workspace_id::text||':'||lower(btrim(p_actor_name)),8272));

      -- Recheck after taking the name lock: a concurrent chat may have matched
      -- the id-only wait while this donation was being normalized.
      if not exists(
        select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
        where outbox.workspace_id=p_workspace_id
          and outbox.event_id=v_event_id
          and outbox.command_kind='donation_chat_tts'
      ) then
        select buffer.* into v_buffer
        from byeollog_automation.native_roulette_chat_buffer_v2 buffer
        where buffer.workspace_id=p_workspace_id
          and buffer.consumed_event_id is null
          and buffer.occurred_at between p_occurred_at
            and p_occurred_at+pg_catalog.make_interval(secs=>v_window)
          and (
            buffer.actor_id=lower(btrim(p_actor_id))
            or lower(buffer.actor_name)=lower(btrim(p_actor_name))
          )
        order by
          (buffer.actor_id=lower(btrim(p_actor_id))) desc,
          buffer.occurred_at,buffer.received_at
        limit 1
        for update;

        if found then
          update byeollog_automation.native_roulette_chat_buffer_v2 buffer
          set consumed_event_id=v_event_id
          where buffer.workspace_id=p_workspace_id
            and buffer.provider_chat_id=v_buffer.provider_chat_id
            and buffer.consumed_event_id is null;

          v_elapsed:=greatest(0,round(extract(epoch from(
            v_buffer.occurred_at-p_occurred_at)))::integer);
          v_match_kind:=case
            when v_buffer.actor_id=lower(btrim(p_actor_id)) then 'actor_id'
            else 'actor_name'
          end;
          perform byeollog_automation.enqueue_native_roulette_chat_tts_v2(
            v_event,v_buffer.message,v_buffer.provider_chat_id,v_elapsed,
            'followup_chat',v_service.tts_volume_percent);
          update byeollog_automation.native_roulette_chat_waits_v2 wait
          set status='captured',captured_chat_id=v_buffer.provider_chat_id,
            captured_at=clock_timestamp()
          where wait.event_id=v_event_id and wait.status='pending';
          v_tts_queued:=true;
        else
          insert into byeollog_automation.native_roulette_chat_waits_v2(
            event_id,workspace_id,actor_id,actor_name,opens_at,expires_at)
          values(v_event_id,p_workspace_id,lower(btrim(p_actor_id)),btrim(p_actor_name),
            p_occurred_at,p_occurred_at+pg_catalog.make_interval(secs=>v_window))
          on conflict(event_id) do update set
            actor_name=excluded.actor_name,
            expires_at=greatest(
              byeollog_automation.native_roulette_chat_waits_v2.expires_at,
              excluded.expires_at)
          where byeollog_automation.native_roulette_chat_waits_v2.status='pending';
          v_followup_armed:=true;
        end if;
      else
        v_tts_queued:=true;
        v_match_kind:='actor_id';
      end if;
    end if;
  end if;

  return v_result||jsonb_build_object(
    'ttsQueued',v_tts_queued,
    'followupArmed',v_followup_armed,
    'messageMatchKind',v_match_kind,
    'status',case
      when v_tts_queued
        or v_followup_armed
        or coalesce((v_result->>'ceremonyQueued')::boolean,false)
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
  'Service-only common-overlay ingestion. Donation text is correlated by provider id first and exact nickname second inside the bounded SOOP follow-up window.';

create or replace function public.ingest_native_roulette_soop_chat_v2(
  p_workspace_id uuid,p_chat_event_id text,p_actor_id text,p_actor_name text,
  p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_wait byeollog_automation.native_roulette_chat_waits_v2%rowtype;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_service public.byeollog_native_roulette_services%rowtype;
  v_elapsed integer;
  v_dispatch uuid;
  v_inserted integer;
  v_consumed_event_id uuid;
  v_match_kind text;
begin
  if p_workspace_id is null
     or char_length(btrim(p_chat_event_id)) not between 1 and 200
     or p_chat_event_id~'[[:cntrl:]]'
     or char_length(btrim(p_actor_id)) not between 1 and 180
     or p_actor_id~'[[:cntrl:]]'
     or char_length(btrim(p_actor_name)) not between 1 and 120
     or p_actor_name~'[[:cntrl:]]'
     or char_length(btrim(p_message)) not between 1 and 300
     or p_message~'[[:cntrl:]]'
     or p_occurred_at is null
     or p_occurred_at>clock_timestamp()+interval '2 minutes'
     or p_occurred_at<clock_timestamp()-interval '2 minutes'
  then
    raise exception 'native roulette SOOP chat is invalid' using errcode='22023';
  end if;

  insert into byeollog_automation.native_roulette_chat_buffer_v2(
    workspace_id,provider_chat_id,actor_id,actor_name,message,occurred_at)
  values(p_workspace_id,btrim(p_chat_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),
    btrim(p_message),p_occurred_at)
  on conflict(workspace_id,provider_chat_id) do nothing;

  get diagnostics v_inserted=row_count;

  if v_inserted=0 then
    select buffer.consumed_event_id into v_consumed_event_id
    from byeollog_automation.native_roulette_chat_buffer_v2 buffer
    where buffer.workspace_id=p_workspace_id
      and buffer.provider_chat_id=btrim(p_chat_event_id);

    if v_consumed_event_id is not null then
      return jsonb_build_object(
        'duplicate',true,'matched',true,'eventId',v_consumed_event_id,
        'ttsQueued',true);
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'native-roulette-v2-chat-name:'||p_workspace_id::text||':'||lower(btrim(p_actor_name)),8272));

  update byeollog_automation.native_roulette_chat_waits_v2 wait set status='expired'
  where wait.workspace_id=p_workspace_id
    and (
      wait.actor_id=lower(btrim(p_actor_id))
      or lower(wait.actor_name)=lower(btrim(p_actor_name))
    )
    and wait.status='pending'
    and wait.expires_at<p_occurred_at
    and not exists(
      select 1
      from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
      where outbox.workspace_id=p_workspace_id
        and outbox.event_id=wait.event_id
        and outbox.command_kind='roulette_spin'
        and (
          outbox.status in ('pending','processing')
          or (outbox.status='succeeded'
            and outbox.processed_at>=p_occurred_at-interval '3 seconds')
        )
    );

  select wait.* into v_wait
  from byeollog_automation.native_roulette_chat_waits_v2 wait
  where wait.workspace_id=p_workspace_id
    and (
      wait.actor_id=lower(btrim(p_actor_id))
      or lower(wait.actor_name)=lower(btrim(p_actor_name))
    )
    and wait.status='pending'
    and p_occurred_at>=wait.opens_at
    and (
      p_occurred_at<=wait.expires_at
      or exists(
        select 1
        from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
        where outbox.workspace_id=p_workspace_id
          and outbox.event_id=wait.event_id
          and outbox.command_kind='roulette_spin'
          and (
            outbox.status in ('pending','processing')
            or (outbox.status='succeeded'
              and outbox.processed_at>=p_occurred_at-interval '3 seconds')
          )
      )
    )
  order by
    (wait.actor_id=lower(btrim(p_actor_id))) desc,
    wait.opens_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'duplicate',v_inserted=0,'matched',false,'ttsQueued',false);
  end if;

  select event.* into strict v_event
  from byeollog_automation.native_roulette_events_v2 event
  where event.id=v_wait.event_id and event.workspace_id=p_workspace_id;

  select service.* into strict v_service
  from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id;

  v_elapsed:=greatest(0,round(extract(epoch from(
    p_occurred_at-v_event.occurred_at)))::integer);
  v_match_kind:=case
    when v_wait.actor_id=lower(btrim(p_actor_id)) then 'actor_id'
    else 'actor_name'
  end;

  update byeollog_automation.native_roulette_chat_waits_v2 wait set status='superseded'
  where wait.workspace_id=p_workspace_id
    and (
      wait.actor_id=lower(btrim(p_actor_id))
      or lower(wait.actor_name)=lower(btrim(p_actor_name))
    )
    and wait.status='pending'
    and wait.event_id<>v_wait.event_id
    and wait.opens_at<=v_wait.opens_at;

  update byeollog_automation.native_roulette_chat_waits_v2 wait set
    status='captured',captured_chat_id=btrim(p_chat_event_id),captured_at=clock_timestamp()
  where wait.event_id=v_wait.event_id;

  update byeollog_automation.native_roulette_chat_buffer_v2 buffer set
    consumed_event_id=v_event.id
  where buffer.workspace_id=p_workspace_id
    and buffer.provider_chat_id=btrim(p_chat_event_id);

  v_dispatch:=byeollog_automation.enqueue_native_roulette_chat_tts_v2(
    v_event,btrim(p_message),btrim(p_chat_event_id),v_elapsed,
    'followup_chat',v_service.tts_volume_percent);

  return jsonb_build_object(
    'duplicate',v_inserted=0,'matched',true,'eventId',v_event.id,
    'dispatchId',v_dispatch,'elapsedSeconds',v_elapsed,
    'matchKind',v_match_kind,'ttsQueued',true);
end
$function$;

revoke all on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz)
  from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz)
  to service_role;

comment on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz) is
  'Captures donor text by provider id first and exact nickname second while its donation card or roulette series remains eligible.';


