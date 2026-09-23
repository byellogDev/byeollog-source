-- Match the established Weflab donation-alert contract: donors have thirty
-- seconds to provide their first message, while the visual may close earlier
-- and be restored by the OBS client when that message is spoken.

update public.byeollog_native_roulette_services service
set activation_snapshot=jsonb_set(
  service.activation_snapshot,'{followupChatTtsWindowSeconds}','30'::jsonb,true)
where service.activation_snapshot is not null
  and service.activation_snapshot->>'followupChatTtsWindowSeconds' is distinct from '30';

update public.byeollog_roulette_drafts draft
set draft=jsonb_set(draft.draft,'{followupChatTtsWindowSeconds}','30'::jsonb,true)
where draft.draft->>'followupChatTtsWindowSeconds' is distinct from '30';

update byeollog_automation.native_roulette_chat_waits_v2 wait
set expires_at=wait.opens_at+interval '30 seconds'
where wait.status='pending'
  and wait.expires_at is distinct from wait.opens_at+interval '30 seconds';

create or replace function public.claim_native_roulette_tts_v1(
  p_workspace_id uuid,
  p_command_id uuid,
  p_client_id text,
  p_overlay_attempt_count integer,
  p_text_sha256 text
)
returns table(request_id uuid,allowed boolean)
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare
  v_command byeollog_automation.native_roulette_overlay_outbox_v2%rowtype;
  v_expected_text text;
  v_expected_hash text;
  v_attempt byeollog_automation.native_roulette_tts_attempts_v1%rowtype;
  v_request_id uuid:=extensions.gen_random_uuid();
  v_actor_name text;
  v_donation_type text;
  v_amount bigint;
begin
  if p_workspace_id is null or p_command_id is null
     or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
     or p_overlay_attempt_count not between 1 and 20
     or p_text_sha256!~'^[0-9a-f]{64}$'
  then raise exception 'managed overlay tts claim is invalid' using errcode='22023'; end if;

  select * into v_command
  from byeollog_automation.native_roulette_overlay_outbox_v2 command
  where command.id=p_command_id
    and command.workspace_id=p_workspace_id
    and command.status='processing'
    and command.client_id=btrim(p_client_id)
    and command.attempt_count=p_overlay_attempt_count
    and command.lease_expires_at>clock_timestamp()
    and command.command_kind in ('roulette_spin','donation_chat_tts','donation_ceremony')
  for update;
  if not found then
    raise exception 'managed overlay tts command lease is unavailable' using errcode='55000';
  end if;

  if v_command.command_kind='donation_ceremony' then
    v_actor_name:=coalesce(nullif(btrim(v_command.payload#>>'{actor,name}'),''),'시청자');
    v_donation_type:=coalesce(
      nullif(btrim(v_command.payload->>'donationTypeLabel'),''),
      nullif(btrim(v_command.payload->>'balloonTypeLabel'),''),'별풍선');
    v_amount:=case when coalesce(v_command.payload->>'amount','')~'^\d+$'
      then greatest(1,(v_command.payload->>'amount')::bigint) else 1 end;
  end if;

  v_expected_text:=case v_command.command_kind
    when 'roulette_spin' then nullif(btrim(v_command.payload->>'resultText'),'')
    when 'donation_chat_tts' then coalesce(
      nullif(btrim(v_command.payload->>'ttsText'),''),
      nullif(btrim(v_command.payload->>'message'),'')
    )
    when 'donation_ceremony' then
      v_actor_name||'님 '||v_donation_type||' '||v_amount::text||'개 감사합니다!'
  end;
  if v_expected_text is null or char_length(v_expected_text) not between 1 and 240 then
    raise exception 'managed overlay tts text is unavailable' using errcode='22023';
  end if;
  v_expected_hash:=encode(extensions.digest(
    pg_catalog.convert_to(v_expected_text,'UTF8'),'sha256'),'hex');
  if v_expected_hash<>p_text_sha256 then
    raise exception 'managed overlay tts text does not match command' using errcode='22023';
  end if;

  select * into v_attempt
  from byeollog_automation.native_roulette_tts_attempts_v1 attempt
  where attempt.command_id=p_command_id
    and attempt.overlay_attempt_count=p_overlay_attempt_count
  for update;
  if found then
    if v_attempt.status='succeeded'
       or (v_attempt.status='synthesizing'
         and v_attempt.started_at>clock_timestamp()-interval '45 seconds')
       or v_attempt.synthesis_try_count>=3
    then return query select v_attempt.request_id,false; return; end if;
    update byeollog_automation.native_roulette_tts_attempts_v1 set
      request_id=v_request_id,status='synthesizing',
      synthesis_try_count=synthesis_try_count+1,provider=null,
      first_audio_ms=null,total_ms=null,audio_bytes=null,last_error_code=null,
      started_at=clock_timestamp(),completed_at=null
    where command_id=p_command_id
      and overlay_attempt_count=p_overlay_attempt_count;
  else
    insert into byeollog_automation.native_roulette_tts_attempts_v1(
      command_id,workspace_id,overlay_attempt_count,request_id,text_sha256)
    values(p_command_id,p_workspace_id,p_overlay_attempt_count,v_request_id,p_text_sha256);
  end if;
  return query select v_request_id,true;
end
$function$;

revoke all on function public.claim_native_roulette_tts_v1(
  uuid,uuid,text,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_tts_v1(
  uuid,uuid,text,integer,text) to service_role;

comment on function public.claim_native_roulette_tts_v1(
  uuid,uuid,text,integer,text) is
  'Authorizes exact managed TTS for roulette results, donation summaries, and donor messages on a live leased overlay command.';
