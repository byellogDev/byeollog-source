import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import test from 'node:test';
import handler from '../api/native-roulette.js';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('native roulette API and settings asset stay outside Vercel deployments',async()=>{
  const ignore=await source('../.vercelignore');
  assert.match(ignore,/^api\/native-roulette\.js$/m);
  assert.match(ignore,/^assets\/native-roulette-settings\.js$/m);
  assert.match(ignore,/^dormant-native-roulette-assets$/m);
});

test('provisional three-second roulette sound is immutable and deployment-dormant',async()=>{
  const audio=await readFile(new URL('../dormant-native-roulette-assets/audio/roulette-spin-v1.wav',import.meta.url));
  assert.equal(audio.byteLength,576044);
  assert.equal(createHash('sha256').update(audio).digest('hex'),
    '651376fec5b8424825269a25e6041e591711ed1c55642fb61e20574f35382bec');
  assert.equal(audio.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(audio.subarray(8,12).toString('ascii'),'WAVE');
});

test('native roulette SQL stays outside the active Supabase migration chain',async()=>{
  const fileName='20260825110000_native_roulette_sdk_skeleton.sql';
  const [active,dormant]=await Promise.all([
    readdir(new URL('../supabase/migrations/',import.meta.url)),
    readdir(new URL('../supabase/dormant-migrations/',import.meta.url))
  ]);
  assert.equal(active.includes(fileName),false);
  assert.equal(dormant.includes(fileName),true);
});

test('dormant migration is additive, private, service-role only, and intentionally has no activation RPC',async()=>{
  const sql=await source('../supabase/dormant-migrations/20260825110000_native_roulette_sdk_skeleton.sql');
  assert.match(sql,/create table byeollog_automation\.native_roulette_profiles/);
  assert.match(sql,/create table byeollog_automation\.native_roulette_cache_requirements/);
  assert.match(sql,/create table byeollog_automation\.native_roulette_chat_followups/);
  assert.match(sql,/create table byeollog_automation\.native_roulette_dispatch_outbox/);
  assert.equal((sql.match(/'roulette-0[1-7]-[^']+-clean-edge\.webp'/g)||[]).length,7);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/explicitly_deny_direct_client_access/);
  assert.match(sql,/revoke all on table[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.save_native_roulette_draft_v1[\s\S]*to service_role/);
  assert.match(sql,/grant execute on function public\.ingest_native_roulette_soop_donation_v1[\s\S]*to service_role/);
  assert.match(sql,/grant execute on function public\.ingest_native_roulette_soop_chat_v1[\s\S]*to service_role/);
  assert.doesNotMatch(sql,/create\s+(?:or replace\s+)?function\s+(?:public\.)?activate_native_roulette/i);
  assert.match(sql,/activation_rpc_intentionally_absent/);
});

test('native roulette draws one cryptographic uint32 and rejects the biased tail',async()=>{
  const sql=await source('../supabase/dormant-migrations/20260825110000_native_roulette_sdk_skeleton.sql');
  const start=sql.indexOf('create or replace function byeollog_automation.native_roulette_sample_ppm_v1');
  const end=sql.indexOf('revoke all on function byeollog_automation.native_roulette_sample_ppm_v1',start);
  const body=sql.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.equal((body.match(/extensions\.gen_random_bytes\(4\)/g)||[]).length,1);
  assert.match(body,/v_limit constant bigint:=4294000000/);
  assert.match(body,/if v_value<v_limit then return \(v_value%1000000\)::integer/);
  assert.doesNotMatch(body,/\brandom\s*\(|Math\.random/);
});

test('message-less donation follow-up chat is single-use, bounded, and queued after roulette results',async()=>{
  const sql=await source('../supabase/dormant-migrations/20260825110000_native_roulette_sdk_skeleton.sql');
  assert.match(sql,/followup_chat_tts_window_seconds integer not null default 10[\s\S]*between 0 and 60/);
  assert.match(sql,/status text not null default 'pending'[\s\S]*'captured','superseded','expired'/);
  assert.match(sql,/pg_advisory_xact_lock[\s\S]*native-roulette-chat:/);
  assert.match(sql,/order by followup\.opens_at desc[\s\S]*limit 1 for update/);
  assert.match(sql,/set status='superseded'[\s\S]*followup\.actor_id=lower/);
  assert.match(sql,/round\(extract\(epoch from \(p_occurred_at-v_donation\.occurred_at\)\)\)::integer/);
  assert.match(sql,/'displayText','\['\|\|v_elapsed_seconds::text\|\|'초전\] '/);
  assert.match(sql,/'ttsText',btrim\(p_message\)/);
  assert.match(sql,/outbox\.dispatch_kind<>'donation_chat_tts' or not exists/);
  assert.match(sql,/dependency\.status in \('pending','processing'\)/);
});

test('migration excludes direct-upbo results from TTS requirements and presentation',async()=>{
  const sql=await source('../supabase/dormant-migrations/20260825110000_native_roulette_sdk_skeleton.sql');
  assert.match(sql,/if not \(v_item->>'directUpbo'\)::boolean then[\s\S]*'result_tts'/);
  assert.match(sql,/'kind','direct_upbo','skipAutomation',true,[\s\S]*'skipPresentation',true/);
  assert.match(sql,/'kind','automation_event','skipAutomation',false,[\s\S]*'presentation'/);
  assert.match(sql,/'source','byeollog','platform','soop',[\s\S]*'eventType','roulette'/);
});

test('server ingestion remains fail-closed until the SDK flag and internal secret are present',async()=>{
  const api=await source('../api/native-roulette.js');
  assert.match(api,/process\.env\.NATIVE_ROULETTE_ENABLED!=='true'/);
  assert.match(api,/process\.env\.SOOP_CHAT_SDK_ENABLED!=='true'/);
  assert.match(api,/SOOP_CHAT_SDK_SECRET/);
  assert.match(api,/safeEqual\(expected,supplied\)/);
  assert.match(api,/rpc\/ingest_native_roulette_soop_donation_v1/);
  assert.match(api,/rpc\/ingest_native_roulette_soop_chat_v1/);
  assert.match(api,/requireCapabilityLive\(req,res,req\.method==='POST'\?'roulette:configure':'roulette:read'\)/);
});

test('native roulette page and API remain indistinguishable from missing routes by default',async()=>{
  const previous=process.env.NATIVE_ROULETTE_ENABLED;
  delete process.env.NATIVE_ROULETTE_ENABLED;
  const requests=[
    {method:'GET',query:{view:'settings'},headers:{}},
    {method:'GET',query:{operation:'assets'},headers:{}},
    {method:'GET',query:{operation:'settings'},headers:{}},
    {method:'POST',query:{operation:'soop-donation'},headers:{},body:{}},
    {method:'POST',query:{operation:'soop-chat'},headers:{},body:{}}
  ];
  try{
    for(const request of requests){
      const response={
        headers:{},statusCode:0,payload:null,
        setHeader(name,value){this.headers[name]=value},
        status(code){this.statusCode=code;return this},
        json(payload){this.payload=payload;return this}
      };
      await handler(request,response);
      assert.equal(response.statusCode,404);
      assert.deepEqual(response.payload,{message:'Not found'});
    }
  }finally{
    if(previous===undefined)delete process.env.NATIVE_ROULETTE_ENABLED;
    else process.env.NATIVE_ROULETTE_ENABLED=previous;
  }
});

test('disabled SDK request returns before any database or session dependency is needed',async()=>{
  const previousRoulette=process.env.NATIVE_ROULETTE_ENABLED;
  const previous=process.env.SOOP_CHAT_SDK_ENABLED;
  process.env.NATIVE_ROULETTE_ENABLED='true';
  delete process.env.SOOP_CHAT_SDK_ENABLED;
  const response={
    headers:{},statusCode:0,payload:null,
    setHeader(name,value){this.headers[name]=value},
    status(code){this.statusCode=code;return this},
    json(payload){this.payload=payload;return this}
  };
  try{
    await handler({method:'POST',query:{operation:'soop-donation'},headers:{},body:{}},response);
    assert.equal(response.statusCode,503);assert.equal(response.payload.code,'soop_chat_sdk_disabled');
  }finally{
    if(previousRoulette===undefined)delete process.env.NATIVE_ROULETTE_ENABLED;
    else process.env.NATIVE_ROULETTE_ENABLED=previousRoulette;
    if(previous===undefined)delete process.env.SOOP_CHAT_SDK_ENABLED;
    else process.env.SOOP_CHAT_SDK_ENABLED=previous;
  }
});

test('settings UI exposes all requested controls but no activation control',async()=>{
  const html=await source('../lib/native-roulette-settings-html.js');
  const js=await source('../assets/native-roulette-settings.js');
  for(const label of ['업보 직행','오버레이 WebP 선택','효과음 음량','결과 TTS 음량','후원 후 첫 채팅 TTS 유효시간','초안 저장 및 TTS 준비']){
    assert.match(html,new RegExp(label));
  }
  assert.match(html,/승인 전 활성화 불가/);
  assert.match(html,/disabled/);
  assert.match(js,/directUpbo/);assert.match(js,/ttsText/);assert.match(js,/overlayAssetKey/);
  assert.match(js,/followupChatTtsWindowSeconds/);
});
