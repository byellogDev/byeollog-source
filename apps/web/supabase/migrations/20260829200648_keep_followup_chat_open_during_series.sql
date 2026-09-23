-- A configured follow-up window is enough for a single spin, but a series can
-- remain visible much longer. Accept the donor's first chat while any spin for
-- that donation is still queued/playing, plus a short final-card grace period.
create or replace function public.ingest_native_roulette_soop_chat_v2(
  p_workspace_id uuid,p_chat_event_id text,p_actor_id text,p_actor_name text,
  p_message text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_wait byeollog_automation.native_roulette_chat_waits_v2%rowtype;
  v_event byeollog_automation.native_roulette_events_v2%rowtype;
  v_service public.byeollog_native_roulette_services%rowtype;v_elapsed integer;v_dispatch uuid;
begin
  if p_workspace_id is null or char_length(btrim(p_chat_event_id)) not between 1 and 200
     or p_chat_event_id~'[[:cntrl:]]' or char_length(btrim(p_actor_id)) not between 1 and 180
     or p_actor_id~'[[:cntrl:]]' or char_length(btrim(p_actor_name)) not between 1 and 120
     or p_actor_name~'[[:cntrl:]]' or char_length(btrim(p_message)) not between 1 and 300
     or p_message~'[[:cntrl:]]' or p_occurred_at is null
     or p_occurred_at>clock_timestamp()+interval '2 minutes'
     or p_occurred_at<clock_timestamp()-interval '2 minutes'
  then raise exception 'native roulette SOOP chat is invalid' using errcode='22023'; end if;

  insert into byeollog_automation.native_roulette_chat_buffer_v2(
    workspace_id,provider_chat_id,actor_id,actor_name,message,occurred_at)
  values(p_workspace_id,btrim(p_chat_event_id),lower(btrim(p_actor_id)),btrim(p_actor_name),
    btrim(p_message),p_occurred_at) on conflict(workspace_id,provider_chat_id) do nothing;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'native-roulette-v2-chat:'||p_workspace_id::text||':'||lower(btrim(p_actor_id)),8272));

  update byeollog_automation.native_roulette_chat_waits_v2 wait set status='expired'
    where wait.workspace_id=p_workspace_id and wait.actor_id=lower(btrim(p_actor_id))
      and wait.status='pending' and wait.expires_at<p_occurred_at
      and not exists(
        select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
        where outbox.workspace_id=p_workspace_id and outbox.event_id=wait.event_id
          and outbox.command_kind='roulette_spin'
          and (
            outbox.status in ('pending','processing')
            or (outbox.status='succeeded'
              and outbox.processed_at>=p_occurred_at-interval '3 seconds')
          )
      );

  select * into v_wait from byeollog_automation.native_roulette_chat_waits_v2 wait
    where wait.workspace_id=p_workspace_id and wait.actor_id=lower(btrim(p_actor_id))
      and wait.status='pending' and p_occurred_at>=wait.opens_at
      and (
        p_occurred_at<=wait.expires_at
        or exists(
          select 1 from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
          where outbox.workspace_id=p_workspace_id and outbox.event_id=wait.event_id
            and outbox.command_kind='roulette_spin'
            and (
              outbox.status in ('pending','processing')
              or (outbox.status='succeeded'
                and outbox.processed_at>=p_occurred_at-interval '3 seconds')
            )
        )
      )
    order by wait.opens_at desc limit 1 for update;
  if not found then return jsonb_build_object('duplicate',false,'matched',false); end if;

  select * into strict v_event from byeollog_automation.native_roulette_events_v2
    where id=v_wait.event_id and workspace_id=p_workspace_id;
  select * into strict v_service from public.byeollog_native_roulette_services
    where workspace_id=p_workspace_id;
  v_elapsed:=round(extract(epoch from(p_occurred_at-v_event.occurred_at)))::integer;
  update byeollog_automation.native_roulette_chat_waits_v2 set status='superseded'
    where workspace_id=p_workspace_id and actor_id=lower(btrim(p_actor_id))
      and status='pending' and event_id<>v_wait.event_id and opens_at<=v_wait.opens_at;
  update byeollog_automation.native_roulette_chat_waits_v2 set status='captured',
    captured_chat_id=btrim(p_chat_event_id),captured_at=clock_timestamp()
    where event_id=v_wait.event_id;
  update byeollog_automation.native_roulette_chat_buffer_v2 set consumed_event_id=v_event.id
    where workspace_id=p_workspace_id and provider_chat_id=btrim(p_chat_event_id);
  v_dispatch:=byeollog_automation.enqueue_native_roulette_chat_tts_v2(
    v_event,btrim(p_message),btrim(p_chat_event_id),v_elapsed,'followup_chat',v_service.tts_volume_percent);
  return jsonb_build_object('duplicate',false,'matched',true,'eventId',v_event.id,
    'dispatchId',v_dispatch,'elapsedSeconds',v_elapsed);
end
$function$;

revoke all on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz) from public,anon,authenticated,service_role;
grant execute on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz) to service_role;

comment on function public.ingest_native_roulette_soop_chat_v2(
  uuid,text,text,text,text,timestamptz) is
  'Captures the donor first chat during the configured follow-up window or while that donation roulette series is still being presented.';
