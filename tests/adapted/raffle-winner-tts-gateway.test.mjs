import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const source=path=>readFile(auditURL(path,import.meta.url),'utf8');

test('raffle action TTS is bound to an active Agent execution and server-authored text',async()=>{
  const sql=await source('../supabase/migrations/20260902015745_unify_raffle_action_managed_tts.sql');
  assert.match(sql,/create or replace function public\.g3a_prepare_raffle_action_tts_v1/);
  assert.match(sql,/security definer[\s\S]*set search_path=''[\s\S]*set statement_timeout='5s'/);
  assert.match(sql,/assert_runtime_locked_v1/);
  assert.match(sql,/assert_agent_device_locked_v1/);
  assert.match(sql,/execution_row\.execution_target='local_agent'/);
  assert.match(sql,/execution_row\.status='running'/);
  assert.match(sql,/execution_row\.lease_owner=p_worker_id/);
  assert.match(sql,/execution_row\.lease_expires_at>clock_timestamp\(\)/);
  assert.match(sql,/v_speech_text:='추첨권을 드렸어요!'/);
  assert.match(sql,/당첨을 축하드려요!/);
  assert.match(sql,/v_binding_key<>p_expected_binding_key/);
  assert.match(sql,/revoke all on function public\.g3a_prepare_raffle_action_tts_v1[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.g3a_prepare_raffle_action_tts_v1[\s\S]*to service_role/);
  assert.doesNotMatch(sql,/grant execute[\s\S]*to authenticated/);
});

test('Agent runtime exposes only the managed execution-bound raffle WAV operation',async()=>{
  const edge=await source('../supabase/functions/agent-runtime/index.ts');
  assert.match(edge,/operation !== "raffle_action_tts"/);
  assert.match(edge,/rpc\/g3a_prepare_raffle_action_tts_v1/);
  assert.match(edge,/BYEOLLOG_MANAGED_TTS_BRIDGE_ORIGIN/);
  assert.match(edge,/BYEOLLOG_MANAGED_TTS_BRIDGE_SECRET/);
  assert.match(edge,/new URL\("\/api\/auth\/internal\/raffle-tts", origin\)/);
  assert.match(edge,/x-byeollog-signature/);
  assert.match(edge,/hmacSha256Hex/);
  assert.match(edge,/response\.body\.getReader\(\)/);
  assert.match(edge,/total > MAX_RAFFLE_TTS_BYTES/);
  assert.match(edge,/contentType !== "audio\/wav"/);
  assert.match(edge,/x-byeollog-audio-sha256/);
  assert.match(edge,/x-byeollog-voice-key/);
  assert.match(edge,/sha256 !== serviceAudioHash/);
  assert.doesNotMatch(edge,/operation !== "raffle_winner_tts"/);
  assert.doesNotMatch(edge,/operation !== "raffle_tts_candidates"/);
  assert.doesNotMatch(edge,/operation !== "raffle_candidate_tts"/);
});

test('retired raffle TTS bridge is no longer routable from Vercel',async()=>{
  const [login,tts,vercel]=await Promise.all([
    source('../api/login.js'),
    source('../lib/managed-overlay-tts.js'),
    source('../vercel.json')
  ]);
  assert.match(login,/retiredRuntimeOperation\(operation\)/);
  assert.match(login,/feature_retired/);
  assert.match(tts,/google/);
  assert.match(tts,/cartesia/);
  assert.doesNotMatch(vercel,/\/api\/auth\/internal\/raffle-tts/);
});

test('historical winner gateway remains migration-safe during rollout',async()=>{
  const sql=await source('../supabase/migrations/20260824153000_restore_raffle_winner_tts_gateway.sql');
  assert.match(sql,/create or replace function public\.g3a_prepare_raffle_winner_tts_v1/);
  assert.match(sql,/grant execute on function public\.g3a_prepare_raffle_winner_tts_v1[\s\S]*to service_role/);
});
