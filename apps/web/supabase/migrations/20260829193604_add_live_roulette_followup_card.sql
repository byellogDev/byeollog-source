-- The common overlay needs a stable donation identity across every spin in a
-- series.  Returning the internal event id keeps donor/chat correlation out of
-- URLs and lets the browser preserve one card until the event's final message.
create or replace function public.claim_native_roulette_overlay_v3(
  p_workspace_id uuid,p_client_id text,p_limit integer default 1,p_lease_seconds integer default 90)
returns table(
  command_id uuid,command_kind text,payload jsonb,attempt_count integer,
  lease_expires_at timestamptz,event_id uuid,event_occurred_at timestamptz)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_service public.byeollog_native_roulette_services%rowtype;
begin
  if p_workspace_id is null or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]' or p_limit not between 1 and 10
     or p_lease_seconds not between 15 and 600
  then raise exception 'native roulette overlay claim is invalid' using errcode='22023'; end if;

  select * into v_service from public.byeollog_native_roulette_services service
  where service.workspace_id=p_workspace_id and service.state='active' for update;
  if not found then raise exception 'native roulette is not active' using errcode='55000'; end if;
  if v_service.overlay_client_id is not null
     and v_service.overlay_client_id<>btrim(p_client_id)
     and v_service.overlay_client_seen_at>clock_timestamp()-interval '15 seconds'
  then raise exception 'native roulette overlay client is already active' using errcode='55P03'; end if;
  if v_service.overlay_client_id is distinct from btrim(p_client_id)
     or v_service.overlay_client_seen_at is null
     or v_service.overlay_client_seen_at<=clock_timestamp()-interval '5 seconds'
  then
    update public.byeollog_native_roulette_services set
      overlay_client_id=btrim(p_client_id),overlay_client_seen_at=clock_timestamp()
    where workspace_id=p_workspace_id;
  end if;

  update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
    status='failed',client_id=null,lease_expires_at=null,processed_at=clock_timestamp(),
    last_error='overlay command expired before delivery'
  where outbox.workspace_id=p_workspace_id and outbox.status in ('pending','processing')
    and outbox.expires_at<=clock_timestamp();

  return query with candidates as (
    select outbox.id from byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    where outbox.workspace_id=p_workspace_id and outbox.attempt_count<20
      and outbox.available_at<=clock_timestamp() and outbox.expires_at>clock_timestamp()
      and (outbox.status='pending'
        or (outbox.status='processing' and outbox.lease_expires_at<=clock_timestamp()))
    order by outbox.created_at,outbox.id for update skip locked limit p_limit
  ),claimed as (
    update byeollog_automation.native_roulette_overlay_outbox_v2 outbox set
      status='processing',attempt_count=outbox.attempt_count+1,client_id=btrim(p_client_id),
      lease_expires_at=clock_timestamp()+pg_catalog.make_interval(secs=>p_lease_seconds),last_error=null
    from candidates where outbox.id=candidates.id returning outbox.*
  )
  select claimed.id,claimed.command_kind,claimed.payload,claimed.attempt_count,
    claimed.lease_expires_at,claimed.event_id,event.occurred_at
  from claimed
  join byeollog_automation.native_roulette_events_v2 event
    on event.id=claimed.event_id and event.workspace_id=claimed.workspace_id
  order by claimed.created_at,claimed.id;
end
$function$;

revoke all on function public.claim_native_roulette_overlay_v3(uuid,text,integer,integer)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_overlay_v3(uuid,text,integer,integer)
  to service_role;
