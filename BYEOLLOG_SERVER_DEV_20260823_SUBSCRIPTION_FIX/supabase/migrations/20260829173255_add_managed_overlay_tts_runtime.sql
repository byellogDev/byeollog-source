create table if not exists byeollog_automation.native_roulette_tts_attempts_v1 (
  command_id uuid not null references byeollog_automation.native_roulette_overlay_outbox_v2(id) on delete cascade,
  workspace_id uuid not null references public.byeollog_workspaces(id) on delete cascade,
  overlay_attempt_count integer not null check (overlay_attempt_count between 1 and 20),
  request_id uuid not null default extensions.gen_random_uuid(),
  text_sha256 text not null check (text_sha256~'^[0-9a-f]{64}$'),
  status text not null default 'synthesizing' check (status in ('synthesizing','succeeded','failed')),
  synthesis_try_count integer not null default 1 check (synthesis_try_count between 1 and 3),
  provider text check (provider is null or provider in ('inworld','cartesia')),
  first_audio_ms integer check (first_audio_ms is null or first_audio_ms between 0 and 30000),
  total_ms integer check (total_ms is null or total_ms between 0 and 120000),
  audio_bytes integer check (audio_bytes is null or audio_bytes between 0 and 16777216),
  last_error_code text check (last_error_code is null or (char_length(last_error_code) between 1 and 80 and last_error_code!~'[[:cntrl:]]')),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  primary key(command_id,overlay_attempt_count)
);

create index if not exists native_roulette_tts_attempts_v1_workspace_started_idx
  on byeollog_automation.native_roulette_tts_attempts_v1(workspace_id,started_at desc);

alter table byeollog_automation.native_roulette_tts_attempts_v1 enable row level security;
revoke all on table byeollog_automation.native_roulette_tts_attempts_v1
  from public,anon,authenticated,service_role;
grant select,insert,update,delete on table byeollog_automation.native_roulette_tts_attempts_v1
  to service_role;

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
    when 'roulette_spin' then coalesce(
      nullif(btrim(v_command.payload->>'ttsText'),''),
      nullif(btrim(v_command.payload->>'resultText'),'')||', 당첨!'
    )
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

create or replace function public.finish_native_roulette_tts_v1(
  p_workspace_id uuid,
  p_command_id uuid,
  p_overlay_attempt_count integer,
  p_request_id uuid,
  p_succeeded boolean,
  p_provider text,
  p_first_audio_ms integer,
  p_total_ms integer,
  p_audio_bytes integer,
  p_error_code text default null
)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_updated integer;
begin
  if p_workspace_id is null or p_command_id is null or p_request_id is null
     or p_overlay_attempt_count not between 1 and 20
     or p_provider not in ('inworld','cartesia')
     or (p_succeeded and (p_first_audio_ms is null or p_total_ms is null or p_audio_bytes is null or p_audio_bytes<=0))
     or (not p_succeeded and (p_error_code is null or char_length(p_error_code) not between 1 and 80 or p_error_code~'[[:cntrl:]]'))
  then raise exception 'managed overlay tts completion is invalid' using errcode='22023'; end if;
  update byeollog_automation.native_roulette_tts_attempts_v1 attempt set
    status=case when p_succeeded then 'succeeded' else 'failed' end,
    provider=p_provider,
    first_audio_ms=case when p_succeeded then p_first_audio_ms else null end,
    total_ms=case when p_succeeded then p_total_ms else null end,
    audio_bytes=case when p_succeeded then p_audio_bytes else null end,
    last_error_code=case when p_succeeded then null else left(p_error_code,80) end,
    completed_at=clock_timestamp()
  where attempt.command_id=p_command_id
    and attempt.workspace_id=p_workspace_id
    and attempt.overlay_attempt_count=p_overlay_attempt_count
    and attempt.request_id=p_request_id
    and attempt.status='synthesizing';
  get diagnostics v_updated=row_count;
  return v_updated=1;
end
$function$;

revoke all on function public.finish_native_roulette_tts_v1(uuid,uuid,integer,uuid,boolean,text,integer,integer,integer,text)
  from public,anon,authenticated,service_role;
grant execute on function public.finish_native_roulette_tts_v1(uuid,uuid,integer,uuid,boolean,text,integer,integer,integer,text)
  to service_role;

create or replace function public.touch_native_roulette_overlay_client_v1(
  p_workspace_id uuid,p_client_id text
)
returns boolean
language plpgsql
security definer
set search_path=''
set statement_timeout='5s'
as $function$
declare v_updated integer;
begin
  if p_workspace_id is null or char_length(btrim(p_client_id)) not between 8 and 180
     or p_client_id~'[[:cntrl:]]'
  then raise exception 'overlay client heartbeat is invalid' using errcode='22023'; end if;
  update public.byeollog_native_roulette_services service set
    overlay_client_seen_at=clock_timestamp()
  where service.workspace_id=p_workspace_id and service.state='active'
    and service.overlay_client_id=btrim(p_client_id);
  get diagnostics v_updated=row_count;
  return v_updated=1;
end
$function$;

revoke all on function public.touch_native_roulette_overlay_client_v1(uuid,text)
  from public,anon,authenticated,service_role;
grant execute on function public.touch_native_roulette_overlay_client_v1(uuid,text)
  to service_role;

comment on table byeollog_automation.native_roulette_tts_attempts_v1 is
  'Service-only managed TTS execution metadata. Stores no message text or audio.';
