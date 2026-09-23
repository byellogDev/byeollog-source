-- Extend the existing exactly-once outbox with one common donation ceremony.
-- The RPC resolves only metadata. Private signature assets receive short-lived
-- signed URLs later, at authenticated overlay claim time.

alter table byeollog_automation.native_roulette_overlay_outbox_v2
  drop constraint if exists native_roulette_overlay_outbox_v2_command_kind_check

alter table byeollog_automation.native_roulette_overlay_outbox_v2
  add constraint native_roulette_overlay_outbox_v2_command_kind_check
  check (command_kind in ('roulette_spin','donation_chat_tts','donation_ceremony'))

create or replace function public.ingest_native_overlay_soop_donation_v3(
  p_workspace_id uuid,p_event_id text,p_actor_id text,p_actor_name text,
  p_amount bigint,p_message text,p_ceremony_image_url text,p_occurred_at timestamptz)
returns jsonb
language plpgsql
security definer
set search_path=''
set statement_timeout='10s'
as $function$
declare
  v_result jsonb;v_event_id uuid;v_signature jsonb;v_ceremony jsonb;
  v_roulette_count integer:=0;
begin
  if p_ceremony_image_url is not null and (
    char_length(p_ceremony_image_url)>2048
    or p_ceremony_image_url~'[[:cntrl:]]'
    or lower(p_ceremony_image_url)!~'^https://([a-z0-9-]+\.)*(sooplive\.com|afreecatv\.com|afreecatvcdn\.com)(/|$)'
  ) then
    raise exception 'SOOP ceremony image URL is invalid' using errcode='22023';
  end if;

  v_result:=public.ingest_native_roulette_soop_donation_v2(
    p_workspace_id,p_event_id,p_actor_id,p_actor_name,p_amount,p_message,p_occurred_at);
  if coalesce((v_result->>'duplicate')::boolean,false) then return v_result; end if;
  v_event_id:=(v_result->>'eventId')::uuid;

  if p_amount between 1 and 30000 then
    select row.pc_image into v_signature
    from public.byeollog_signature_balloons row
    where row.workspace_id=p_workspace_id and row.balloon_count=p_amount::integer;
  end if;

  v_ceremony:=case
    when v_signature is not null then jsonb_build_object(
      'source','signature','asset',v_signature,'fallbackUrl','/assets/soop-default-balloon.svg')
    when p_ceremony_image_url is not null then jsonb_build_object(
      'source','soop','url',p_ceremony_image_url,'fallbackUrl','/assets/soop-default-balloon.svg')
    else jsonb_build_object('source','fallback','url','/assets/soop-default-balloon.svg')
  end;

  update byeollog_automation.native_roulette_overlay_outbox_v2 outbox
    set payload=jsonb_set(outbox.payload,'{ceremony}',v_ceremony,true)
  where outbox.workspace_id=p_workspace_id and outbox.event_id=v_event_id
    and outbox.command_kind='roulette_spin';
  get diagnostics v_roulette_count=row_count;

  if v_roulette_count=0 then
    insert into byeollog_automation.native_roulette_overlay_outbox_v2(
      workspace_id,event_id,command_kind,payload,expires_at)
    values(p_workspace_id,v_event_id,'donation_ceremony',jsonb_build_object(
      'schemaVersion',3,'kind','donation_ceremony','donationEventId',btrim(p_event_id),
      'actor',jsonb_build_object('name',btrim(p_actor_name)),
      'amount',p_amount,'ceremony',v_ceremony),clock_timestamp()+interval '2 minutes');
  end if;
  return v_result||jsonb_build_object('ceremonyQueued',true,'ceremonySource',v_ceremony->>'source');
end
$function$

revoke all on function public.ingest_native_overlay_soop_donation_v3(
  uuid,text,text,text,bigint,text,text,timestamptz) from public,anon,authenticated,service_role

grant execute on function public.ingest_native_overlay_soop_donation_v3(
  uuid,text,text,text,bigint,text,text,timestamptz) to service_role

comment on function public.ingest_native_overlay_soop_donation_v3(
  uuid,text,text,text,bigint,text,text,timestamptz) is
  'Queues common-overlay donation presentation with priority: workspace signature, SOOP imageUrl, local fallback.'
