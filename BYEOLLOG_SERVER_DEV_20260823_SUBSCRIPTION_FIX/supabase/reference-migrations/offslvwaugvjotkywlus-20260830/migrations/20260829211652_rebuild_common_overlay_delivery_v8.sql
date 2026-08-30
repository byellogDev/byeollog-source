-- Common overlay v8 keeps a donation series contiguous, lets the browser peek
-- at its captured follow-up text without consuming the TTS command, and makes
-- delivery recovery idempotent.  This migration is intentionally
-- self-contained because the v3 claim/follow-up migrations were deployed
-- outside the recorded migration history during the production trial.

alter table byeollog_automation.native_roulette_overlay_outbox_v2
  alter column expires_at set default (clock_timestamp()+interval '6 hours');

update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
set expires_at=greatest(outbox.expires_at,outbox.created_at+interval '6 hours')
where outbox.status in ('pending','processing')
  and outbox.expires_at>clock_timestamp();

create index if not exists native_roulette_overlay_outbox_v2_event_delivery_idx
  on byeollog_automation.native_roulette_overlay_outbox_v2(
    workspace_id,event_id,status,available_at,created_at)
  where status in ('pending','processing');

create index if not exists native_roulette_overlay_outbox_v2_processing_client_idx
  on byeollog_automation.native_roulette_overlay_outbox_v2(
    workspace_id,client_id,lease_expires_at,created_at)
  where status='processing';

create or replace function byeollog_automation.enqueue_native_roulette_chat_tts_v2(
  p_event byeollog_automation.native_roulette_events_v2,
  p_message text,p_chat_id text,p_elapsed_seconds integer,p_source_kind text,
  p_tts_volume integer)
returns uuid
language plpgsql
set search_path=''
as $function$
declare v_id uuid;
begin
  insert into byeollog_automation.native_roulette_overlay_outbox_v2(
    workspace_id,event_id,command_kind,payload,expires_at)
  values(p_event.workspace_id,p_event.id,'donation_chat_tts',jsonb_build_object(
    'schemaVersion',2,'kind','donation_chat_tts',
    'donationEventId',p_event.provider_event_id,'chatEventId',p_chat_id,
    'sourceKind',p_source_kind,'actor',jsonb_build_object('name',p_event.actor_name),
    'amount',p_event.amount,'message',p_message,
    'displayText',case when p_source_kind='followup_chat'
      then '['||p_elapsed_seconds::text||'초 전] '||p_event.actor_name||' : '||p_message
      else p_message end,
    'ttsText',p_message,'elapsedSeconds',p_elapsed_seconds,
    'ttsVolumePercent',p_tts_volume,'playAfterDonationResults',true),
    clock_timestamp()+interval '6 hours') returning id into v_id;
  return v_id;
end
$function$;

revoke all on function byeollog_automation.enqueue_native_roulette_chat_tts_v2(
  byeollog_automation.native_roulette_events_v2,text,text,integer,text,integer)
  from public,anon,authenticated,service_role;

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
        'duplicate',true,'matched',true,'eventId',v_consumed_event_id);
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'native-roulette-v2-chat:'||p_workspace_id::text||':'||lower(btrim(p_actor_id)),8272));

  update byeollog_automation.native_roulette_chat_waits_v2 wait set status='expired'
  where wait.workspace_id=p_workspace_id
    and wait.actor_id=lower(btrim(p_actor_id))
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

  select * into v_wait
  from byeollog_automation.native_roulette_chat_waits_v2 wait
  where wait.workspace_id=p_workspace_id
    and wait.actor_id=lower(btrim(p_actor_id))
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
  order by wait.opens_at desc
  limit 1
  for update;

  if not found then
    return jsonb_build_object('duplicate',v_inserted=0,'matched',false);
  end if;

  select * into strict v_event
  from byeollog_automation.native_roulette_events_v2
  where id=v_wait.event_id and workspace_id=p_workspace_id;

  select * into strict v_service
  from public.byeollog_native_roulette_services
  where workspace_id=p_workspace_id;

  v_elapsed:=round(extract(epoch from(p_occurred_at-v_event.occurred_at)))::integer;

  update byeollog_automation.native_roulette_chat_waits_v2 set status='superseded'
  where workspace_id=p_workspace_id
    and actor_id=lower(btrim(p_actor_id))
    and status='pending'
    and event_id<>v_wait.event_id
    and opens_at<=v_wait.opens_at;

  update byeollog_automation.native_roulette_chat_waits_v2 set
    status='captured',captured_chat_id=btrim(p_chat_event_id),captured_at=clock_timestamp()
  where event_id=v_wait.event_id;

  update byeollog_automation.native_roulette_chat_buffer_v2 set
    consumed_event_id=v_event.id
  where workspace_id=p_workspace_id
    and provider_chat_id=btrim(p_chat_event_id);

  v_dispatch:=byeollog_automation.enqueue_native_roulette_chat_tts_v2(
    v_event,btrim(p_message),btrim(p_chat_event_id),v_elapsed,
    'followup_chat',v_service.tts_volume_percent);

  return jsonb_build_object(
    'duplicate',v_inserted=0,'matched',true,'eventId',v_event.id,
    'dispatchId',v_dispatch,'elapsedSeconds',v_elapsed);
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
  'Captures the donor first chat during a donation roulette series or its final-card grace period.';

create or replace function public.claim_native_roulette_overlay_v4(
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
declare
  v_service public.byeollog_native_roulette_services%rowtype;
begin
  if p_workspace_id is null or p_token_version is null
     or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
     or p_limit not between 1 and 10
     or p_lease_seconds not between 15 and 600
  then
    raise exception 'native roulette overlay claim is invalid' using errcode='22023';
  end if;

  select * into v_service
  from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id
    and service.state='active'
    and service.overlay_token_version=p_token_version
  for update;

  if not found then
    raise exception 'native roulette is not active' using errcode='55000';
  end if;

  if v_service.overlay_client_id is not null
     and v_service.overlay_client_id<>btrim(p_client_id)
     and v_service.overlay_client_seen_at>clock_timestamp()-interval '15 seconds'
  then
    raise exception 'native roulette overlay client is already active' using errcode='55P03';
  end if;

  if v_service.overlay_client_id is distinct from btrim(p_client_id)
     or v_service.overlay_client_seen_at is null
     or v_service.overlay_client_seen_at<=clock_timestamp()-interval '5 seconds'
  then
    update public.byeollog_native_roulette_services set
      overlay_client_id=btrim(p_client_id),
      overlay_client_seen_at=clock_timestamp()
    where workspace_id=p_workspace_id;
  end if;

  update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
    status='failed',client_id=null,lease_expires_at=null,
    processed_at=clock_timestamp(),last_error='overlay command expired before delivery'
  where outbox.workspace_id=p_workspace_id
    and outbox.status in ('pending','processing')
    and outbox.expires_at<=clock_timestamp();

  update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
    status='failed',client_id=null,lease_expires_at=null,
    processed_at=clock_timestamp(),last_error='overlay retry limit exhausted'
  where outbox.workspace_id=p_workspace_id
    and outbox.status='processing'
    and outbox.attempt_count>=20
    and outbox.lease_expires_at<=clock_timestamp();

  -- A browser may reload after playback but before acknowledgement. Redeliver
  -- its live lease first without consuming another attempt or moving on.
  return query
  with leased as (
    select outbox.id
    from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.workspace_id=p_workspace_id
      and outbox.status='processing'
      and outbox.client_id=btrim(p_client_id)
      and outbox.lease_expires_at>clock_timestamp()
      and outbox.expires_at>clock_timestamp()
    order by outbox.created_at,outbox.id
    for update skip locked
    limit p_limit
  ),renewed as (
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
      lease_expires_at=clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds)
    from leased
    where outbox.id=leased.id
    returning outbox.*
  )
  select renewed.id,renewed.command_kind,
    case when renewed.command_kind='roulette_spin' then renewed.payload||jsonb_build_object(
      'presentationIndex',(
        select count(*) from byeollog_automation.native_roulette_overlay_outbox_v2 sibling
        where sibling.workspace_id=renewed.workspace_id
          and sibling.event_id=renewed.event_id
          and sibling.command_kind='roulette_spin'
          and (sibling.created_at,sibling.id)<(renewed.created_at,renewed.id)
      ),
      'presentationCount',(
        select count(*) from byeollog_automation.native_roulette_overlay_outbox_v2 sibling
        where sibling.workspace_id=renewed.workspace_id
          and sibling.event_id=renewed.event_id
          and sibling.command_kind='roulette_spin'
      )
    ) else renewed.payload end,
    renewed.attempt_count,
    renewed.lease_expires_at,renewed.event_id,event.occurred_at,
    v_service.activation_snapshot
  from renewed
  join byeollog_automation.native_roulette_events_v2 event
    on event.id=renewed.event_id and event.workspace_id=renewed.workspace_id
  order by renewed.created_at,renewed.id;

  if found then return; end if;

  -- While the browser presents a series it asks strictly for that event. An
  -- empty result deliberately means "wait" rather than claim another donor.
  return query
  with candidates as (
    select outbox.id
    from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.workspace_id=p_workspace_id
      and outbox.attempt_count<20
      and outbox.available_at<=clock_timestamp()
      and outbox.expires_at>clock_timestamp()
      and (p_preferred_event_id is null or outbox.event_id=p_preferred_event_id)
      and (
        outbox.status='pending'
        or (outbox.status='processing' and outbox.lease_expires_at<=clock_timestamp())
      )
    order by outbox.created_at,outbox.id
    for update skip locked
    limit p_limit
  ),claimed as (
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
      status='processing',
      attempt_count=outbox.attempt_count+1,
      client_id=btrim(p_client_id),
      lease_expires_at=clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds),
      last_error=null
    from candidates
    where outbox.id=candidates.id
    returning outbox.*
  )
  select claimed.id,claimed.command_kind,
    case when claimed.command_kind='roulette_spin' then claimed.payload||jsonb_build_object(
      'presentationIndex',(
        select count(*) from byeollog_automation.native_roulette_overlay_outbox_v2 sibling
        where sibling.workspace_id=claimed.workspace_id
          and sibling.event_id=claimed.event_id
          and sibling.command_kind='roulette_spin'
          and (sibling.created_at,sibling.id)<(claimed.created_at,claimed.id)
      ),
      'presentationCount',(
        select count(*) from byeollog_automation.native_roulette_overlay_outbox_v2 sibling
        where sibling.workspace_id=claimed.workspace_id
          and sibling.event_id=claimed.event_id
          and sibling.command_kind='roulette_spin'
      )
    ) else claimed.payload end,
    claimed.attempt_count,
    claimed.lease_expires_at,claimed.event_id,event.occurred_at,
    v_service.activation_snapshot
  from claimed
  join byeollog_automation.native_roulette_events_v2 event
    on event.id=claimed.event_id and event.workspace_id=claimed.workspace_id
  order by claimed.created_at,claimed.id;
end
$function$;

revoke all on function public.claim_native_roulette_overlay_v4(
  uuid,uuid,text,uuid,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_overlay_v4(
  uuid,uuid,text,uuid,integer,integer)
  to service_role;

comment on function public.claim_native_roulette_overlay_v4(
  uuid,uuid,text,uuid,integer,integer) is
  'Restart-safe overlay leasing with strict active-event delivery for uninterrupted roulette series.';

create or replace function public.peek_native_roulette_followup_v1(
  p_workspace_id uuid,
  p_token_version uuid,
  p_client_id text,
  p_event_id uuid)
returns table(
  command_id uuid,
  event_id uuid,
  message text,
  source_kind text,
  captured_at timestamptz)
language plpgsql
security definer
set search_path=''
set statement_timeout='3s'
as $function$
declare v_service public.byeollog_native_roulette_services%rowtype;
begin
  if p_workspace_id is null or p_token_version is null or p_event_id is null
     or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
  then
    raise exception 'native roulette follow-up peek is invalid' using errcode='22023';
  end if;

  select * into v_service
  from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id
    and service.state='active'
    and service.overlay_token_version=p_token_version;

  if not found
     or v_service.overlay_client_id is distinct from btrim(p_client_id)
     or v_service.overlay_client_seen_at is null
     or v_service.overlay_client_seen_at<=clock_timestamp()-interval '15 seconds'
  then
    raise exception 'native roulette overlay client is unavailable' using errcode='55000';
  end if;

  return query
  select outbox.id,outbox.event_id,
    coalesce(nullif(btrim(outbox.payload->>'message'),''),
      nullif(btrim(outbox.payload->>'ttsText'),'')) as message,
    nullif(btrim(outbox.payload->>'sourceKind'),'') as source_kind,
    outbox.created_at as captured_at
  from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
  where outbox.workspace_id=p_workspace_id
    and outbox.event_id=p_event_id
    and outbox.command_kind='donation_chat_tts'
    and outbox.status in ('pending','processing')
    and outbox.expires_at>clock_timestamp()
    and (outbox.status='pending' or outbox.client_id=btrim(p_client_id))
  order by outbox.created_at,outbox.id
  limit 1;
end
$function$;

revoke all on function public.peek_native_roulette_followup_v1(uuid,uuid,text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.peek_native_roulette_followup_v1(uuid,uuid,text,uuid)
  to service_role;

comment on function public.peek_native_roulette_followup_v1(uuid,uuid,text,uuid) is
  'Returns only the active donation follow-up display text; it does not claim, authorize, or execute TTS.';

create or replace function public.touch_native_roulette_overlay_client_v2(
  p_workspace_id uuid,
  p_token_version uuid,
  p_client_id text)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='3s'
as $function$
declare v_updated integer;
begin
  if p_workspace_id is null or p_token_version is null
     or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
  then
    raise exception 'overlay client heartbeat is invalid' using errcode='22023';
  end if;

  update public.byeollog_native_roulette_services service set
    overlay_client_seen_at=clock_timestamp()
  where service.workspace_id=p_workspace_id
    and service.state='active'
    and service.overlay_token_version=p_token_version
    and service.overlay_client_id=btrim(p_client_id);
  get diagnostics v_updated=row_count;
  return v_updated=1;
end
$function$;

revoke all on function public.touch_native_roulette_overlay_client_v2(uuid,uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.touch_native_roulette_overlay_client_v2(uuid,uuid,text)
  to service_role;

create or replace function public.finish_native_roulette_overlay_v4(
  p_workspace_id uuid,
  p_token_version uuid,
  p_command_id uuid,
  p_client_id text,
  p_succeeded boolean,
  p_error text default null)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_command byeollog_automation.native_roulette_overlay_outbox_v2%rowtype;
begin
  if p_workspace_id is null or p_token_version is null or p_command_id is null
     or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
     or p_succeeded is null
     or (p_succeeded and p_error is not null)
     or (not p_succeeded and (p_error is null or char_length(p_error) not between 1 and 1000))
  then
    raise exception 'native roulette overlay acknowledgement is invalid' using errcode='22023';
  end if;

  if not exists(
    select 1 from public.byeollog_native_roulette_services service
    where service.workspace_id=p_workspace_id
      and service.state='active'
      and service.overlay_token_version=p_token_version
      and service.overlay_client_id=btrim(p_client_id)
  )
  then
    raise exception 'native roulette overlay client is unavailable' using errcode='55000';
  end if;

  select * into v_command
  from byeollog_automation.native_roulette_overlay_outbox_v2
  where id=p_command_id and workspace_id=p_workspace_id
  for update;

  if not found then
    raise exception 'native roulette overlay command is unavailable' using errcode='55000';
  end if;

  if v_command.status='succeeded'
     and v_command.client_id=btrim(p_client_id)
     and p_succeeded
  then
    return jsonb_build_object(
      'commandId',v_command.id,'status',v_command.status,
      'attemptCount',v_command.attempt_count,'idempotent',true);
  end if;

  -- A response can be lost after the browser has completed playback. Accept
  -- its late ACK until another client actually reclaims the row; client_id is
  -- the ownership boundary, not the transport lease timestamp by itself.
  if v_command.status<>'processing'
     or v_command.client_id<>btrim(p_client_id)
     or v_command.expires_at<=clock_timestamp()
  then
    raise exception 'native roulette overlay lease is unavailable' using errcode='55000';
  end if;

  update byeollog_automation.native_roulette_overlay_outbox_v2 set
    status=case when p_succeeded then 'succeeded'
      when attempt_count<20 then 'pending' else 'failed' end,
    client_id=case when p_succeeded or attempt_count>=20
      then btrim(p_client_id) else null end,
    lease_expires_at=null,
    last_error=p_error,
    processed_at=case when p_succeeded or attempt_count>=20
      then clock_timestamp() else null end
  where id=p_command_id
  returning * into v_command;

  if p_succeeded and not exists(
    select 1
    from byeollog_automation.native_roulette_overlay_outbox_v2 pending
    where pending.event_id=v_command.event_id
      and pending.status in ('pending','processing')
  )
  then
    update byeollog_automation.native_roulette_events_v2 set status='completed'
    where id=v_command.event_id and status='queued';
  end if;

  return jsonb_build_object(
    'commandId',v_command.id,'status',v_command.status,
    'attemptCount',v_command.attempt_count,'idempotent',false);
end
$function$;

revoke all on function public.finish_native_roulette_overlay_v4(
  uuid,uuid,uuid,text,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_native_roulette_overlay_v4(
  uuid,uuid,uuid,text,boolean,text)
  to service_role;

comment on function public.finish_native_roulette_overlay_v4(
  uuid,uuid,uuid,text,boolean,text) is
  'Idempotent overlay acknowledgement; a succeeded command retains its delivery client id for safe retries.';

;
