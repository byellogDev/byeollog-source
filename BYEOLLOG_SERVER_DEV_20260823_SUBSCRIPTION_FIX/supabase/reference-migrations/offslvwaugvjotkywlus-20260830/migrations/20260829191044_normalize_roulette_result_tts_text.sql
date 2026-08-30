-- Roulette result speech is the exact product name.  The display already
-- communicates that the item won, so suffixing every result with "당첨" is
-- repetitive and also makes Korean custom names harder to pronounce.

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
    and command.command_kind in ('roulette_spin','donation_chat_tts')
  for update;
  if not found then
    raise exception 'managed overlay tts command lease is unavailable' using errcode='55000';
  end if;

  v_expected_text:=case v_command.command_kind
    when 'roulette_spin' then nullif(btrim(v_command.payload->>'resultText'),'')
    when 'donation_chat_tts' then coalesce(
      nullif(btrim(v_command.payload->>'ttsText'),''),
      nullif(btrim(v_command.payload->>'message'),'')
    )
  end;
  if v_expected_text is null or char_length(v_expected_text) not between 1 and 240 then
    raise exception 'managed overlay tts text is unavailable' using errcode='22023';
  end if;
  v_expected_hash:=encode(extensions.digest(pg_catalog.convert_to(v_expected_text,'UTF8'),'sha256'),'hex');
  if v_expected_hash<>p_text_sha256 then
    raise exception 'managed overlay tts text does not match command' using errcode='22023';
  end if;

  select * into v_attempt
  from byeollog_automation.native_roulette_tts_attempts_v1 attempt
  where attempt.command_id=p_command_id and attempt.overlay_attempt_count=p_overlay_attempt_count
  for update;
  if found then
    if v_attempt.status='succeeded'
       or (v_attempt.status='synthesizing' and v_attempt.started_at>clock_timestamp()-interval '45 seconds')
       or v_attempt.synthesis_try_count>=3
    then return query select v_attempt.request_id,false; return; end if;
    update byeollog_automation.native_roulette_tts_attempts_v1 set
      request_id=v_request_id,status='synthesizing',
      synthesis_try_count=synthesis_try_count+1,provider=null,
      first_audio_ms=null,total_ms=null,audio_bytes=null,last_error_code=null,
      started_at=clock_timestamp(),completed_at=null
    where command_id=p_command_id and overlay_attempt_count=p_overlay_attempt_count;
  else
    insert into byeollog_automation.native_roulette_tts_attempts_v1(
      command_id,workspace_id,overlay_attempt_count,request_id,text_sha256
    ) values(p_command_id,p_workspace_id,p_overlay_attempt_count,v_request_id,p_text_sha256);
  end if;
  return query select v_request_id,true;
end
$function$;

revoke all on function public.claim_native_roulette_tts_v1(uuid,uuid,text,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.claim_native_roulette_tts_v1(uuid,uuid,text,integer,text)
  to service_role;

comment on function public.claim_native_roulette_tts_v1(uuid,uuid,text,integer,text) is
  'Authorizes managed TTS for a leased overlay command. Roulette speech must exactly match resultText; donation chat uses its dedicated ttsText.';

;
