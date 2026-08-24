import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('winner TTS is authorized by the currently leased raffle execution only',async()=>{
  const sql=await source('../supabase/migrations/20260824130000_add_raffle_winner_tts_gateway.sql');
  assert.match(sql,/create or replace function public\.g3a_prepare_raffle_winner_tts_v1/);
  assert.match(sql,/security definer[\s\S]*set search_path = ''[\s\S]*set statement_timeout = '5s'/);
  assert.match(sql,/assert_runtime_locked_v1/);
  assert.match(sql,/assert_agent_device_locked_v1/);
  assert.match(sql,/execution_row\.execution_target = 'local_agent'/);
  assert.match(sql,/execution_row\.action_type = 'raffle\.overlay'/);
  assert.match(sql,/execution_row\.status = 'running'/);
  assert.match(sql,/execution_row\.attempt_no = p_attempt_no/);
  assert.match(sql,/execution_row\.lease_owner = p_worker_id/);
  assert.match(sql,/execution_row\.lease_expires_at > clock_timestamp\(\)/);
  assert.match(sql,/v_execution\.action_params->'winners'/);
  assert.match(sql,/v_winners->p_winner_ordinal->>'actorName'/);
  assert.match(sql,/raffle-winner-voice-v1\|/);
  assert.match(sql,/revoke all on function public\.g3a_prepare_raffle_winner_tts_v1[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.g3a_prepare_raffle_winner_tts_v1[\s\S]*to service_role/);
  assert.doesNotMatch(sql,/grant execute[\s\S]*to authenticated/);
});

test('agent runtime exposes a bounded private WAV gateway instead of arbitrary public synthesis',async()=>{
  const edge=await source('../supabase/functions/agent-runtime/index.ts');
  assert.match(edge,/operation !== "raffle_winner_tts"/);
  assert.match(edge,/rpc\/g3a_prepare_raffle_winner_tts_v1/);
  assert.match(edge,/BYEOLLOG_TTS_ORIGIN/);
  assert.match(edge,/BYEOLLOG_TTS_SHARED_SECRET/);
  assert.match(edge,/origin\.protocol !== "https:"/);
  assert.match(edge,/new URL\("\/v1\/raffle-winner", origin\)/);
  assert.match(edge,/body: JSON\.stringify\(\{ actorName, voiceKey \}\)/);
  assert.match(edge,/const timeout = setTimeout\(\(\) => controller\.abort\(\), 45_000\)/);
  assert.match(edge,/response\.body\.getReader\(\)/);
  assert.match(edge,/total > MAX_RAFFLE_TTS_BYTES/);
  assert.doesNotMatch(edge,/response\.arrayBuffer\(\)/);
  assert.match(edge,/contentType !== "audio\/wav"/);
  assert.match(edge,/x-byeollog-audio-sha256/);
  assert.match(edge,/x-byeollog-voice-key/);
  assert.match(edge,/x-byeollog-voice-version/);
  assert.match(edge,/returnedVoiceKey !== voiceKey/);
  assert.match(edge,/sha256 !== serviceAudioHash/);
  assert.match(edge,/cache-control": "private, no-store"/);
  assert.match(edge,/raffle_tts_unavailable/);
});

test('sealed raffle candidates and winner executions share one fail-closed voice identity',async()=>{
  const [sql,edge]=await Promise.all([
    source('../supabase/migrations/20260824140000_bind_raffle_tts_cache_identity.sql'),
    source('../supabase/functions/agent-runtime/index.ts')
  ]);
  assert.match(sql,/create or replace function byeollog_automation\.raffle_winner_voice_key_v1/);
  assert.match(sql,/before insert or update of action_params on byeollog_automation\.executions/);
  assert.match(sql,/'voiceKey',[\s\S]*raffle_winner_voice_key_v1/);
  assert.match(sql,/create or replace function public\.g3a_list_raffle_tts_candidates_v1/);
  assert.match(sql,/round_row\.status='sealed'/);
  assert.match(sql,/round_row\.agent_device_id=p_agent_device_id/);
  assert.match(sql,/create or replace function public\.g3a_prepare_raffle_candidate_tts_v1/);
  assert.match(sql,/v_voice_key<>p_expected_voice_key[\s\S]*errcode='40001'/);
  assert.match(sql,/revoke all on function public\.g3a_list_raffle_tts_candidates_v1[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.g3a_list_raffle_tts_candidates_v1[\s\S]*to service_role/);
  assert.match(sql,/revoke all on function public\.g3a_prepare_raffle_candidate_tts_v1[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.g3a_prepare_raffle_candidate_tts_v1[\s\S]*to service_role/);
  assert.doesNotMatch(sql,/grant execute[\s\S]*to authenticated/);

  assert.match(edge,/operation !== "raffle_tts_candidates"/);
  assert.match(edge,/operation !== "raffle_candidate_tts"/);
  assert.match(edge,/rpc\/g3a_list_raffle_tts_candidates_v1/);
  assert.match(edge,/rpc\/g3a_prepare_raffle_candidate_tts_v1/);
  assert.match(edge,/speechContext\.voice_key !== expectedVoiceKey/);
  assert.match(edge,/x-byeollog-voice-key": speechContext\.voice_key/);
});

test('production repair restores the winner gateway after identity binding',async()=>{
  const sql=await source('../supabase/migrations/20260824153000_restore_raffle_winner_tts_gateway.sql');
  assert.match(sql,/create or replace function public\.g3a_prepare_raffle_winner_tts_v1/);
  assert.match(sql,/execution_row\.status='running'/);
  assert.match(sql,/execution_row\.lease_owner=p_worker_id/);
  assert.match(sql,/execution_row\.lease_expires_at>clock_timestamp\(\)/);
  assert.match(sql,/v_kind='test_sequence'[\s\S]*v_actor_name:='테스트 시청자'/);
  assert.match(sql,/v_kind='draw_result'[\s\S]*v_winners->p_winner_ordinal->>'actorName'/);
  assert.match(sql,/raffle_winner_voice_key_v1\(v_actor_name\)/);
  assert.match(sql,/revoke all on function public\.g3a_prepare_raffle_winner_tts_v1[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.g3a_prepare_raffle_winner_tts_v1[\s\S]*to service_role/);
});
