-- Keep historical Inworld rows readable while promoting Google to the active
-- primary provider and Cartesia to the only production fallback.

alter table byeollog_automation.native_roulette_tts_attempts_v1
  drop constraint if exists native_roulette_tts_attempts_v1_provider_check;
alter table byeollog_automation.native_roulette_tts_attempts_v1
  add constraint native_roulette_tts_attempts_v1_provider_check
  check (provider is null or provider in ('google','cartesia','inworld'));

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
     or p_provider not in ('google','cartesia','inworld')
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

comment on constraint native_roulette_tts_attempts_v1_provider_check
  on byeollog_automation.native_roulette_tts_attempts_v1 is
  'Google is primary, Cartesia is fallback, and Inworld is retained only for historical execution metadata.';
