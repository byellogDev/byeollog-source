import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import handler from '../api/native-roulette.js';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('migration is additive, private, service-role only, and intentionally has no activation RPC',async()=>{
  const sql=await source('../supabase/migrations/20260825110000_native_roulette_sdk_skeleton.sql');
  assert.match(sql,/create table byeollog_automation\.native_roulette_profiles/);
  assert.match(sql,/create table byeollog_automation\.native_roulette_cache_requirements/);
  assert.match(sql,/create table byeollog_automation\.native_roulette_dispatch_outbox/);
  assert.equal((sql.match(/'roulette-0[1-7]-[^']+-clean-edge\.webp'/g)||[]).length,7);
  assert.match(sql,/enable row level security/);
  assert.match(sql,/explicitly_deny_direct_client_access/);
  assert.match(sql,/revoke all on table[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(sql,/grant execute on function public\.save_native_roulette_draft_v1[\s\S]*to service_role/);
  assert.match(sql,/grant execute on function public\.ingest_native_roulette_soop_donation_v1[\s\S]*to service_role/);
  assert.doesNotMatch(sql,/create\s+(?:or replace\s+)?function\s+(?:public\.)?activate_native_roulette/i);
  assert.match(sql,/activation_rpc_intentionally_absent/);
});

test('migration excludes direct-upbo results from TTS requirements and presentation',async()=>{
  const sql=await source('../supabase/migrations/20260825110000_native_roulette_sdk_skeleton.sql');
  assert.match(sql,/if not \(v_item->>'directUpbo'\)::boolean then[\s\S]*'result_tts'/);
  assert.match(sql,/'kind','direct_upbo','skipAutomation',true,[\s\S]*'skipPresentation',true/);
  assert.match(sql,/'kind','automation_event','skipAutomation',false,[\s\S]*'presentation'/);
  assert.match(sql,/'source','byeollog','platform','soop',[\s\S]*'eventType','roulette'/);
});

test('server ingestion remains fail-closed until the SDK flag and internal secret are present',async()=>{
  const api=await source('../api/native-roulette.js');
  assert.match(api,/process\.env\.SOOP_CHAT_SDK_ENABLED!=='true'/);
  assert.match(api,/SOOP_CHAT_SDK_SECRET/);
  assert.match(api,/safeEqual\(expected,supplied\)/);
  assert.match(api,/rpc\/ingest_native_roulette_soop_donation_v1/);
  assert.match(api,/requireCapabilityLive\(req,res,req\.method==='POST'\?'roulette:configure':'roulette:read'\)/);
});

test('disabled SDK request returns before any database or session dependency is needed',async()=>{
  const previous=process.env.SOOP_CHAT_SDK_ENABLED;
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
    if(previous===undefined)delete process.env.SOOP_CHAT_SDK_ENABLED;
    else process.env.SOOP_CHAT_SDK_ENABLED=previous;
  }
});

test('settings UI exposes all requested controls but no activation control',async()=>{
  const html=await source('../lib/native-roulette-settings-html.js');
  const js=await source('../assets/native-roulette-settings.js');
  for(const label of ['업보 직행','오버레이 WebP 선택','효과음 음량','결과 TTS 음량','초안 저장 및 TTS 준비']){
    assert.match(html,new RegExp(label));
  }
  assert.match(html,/승인 전 활성화 불가/);
  assert.match(html,/disabled/);
  assert.match(js,/directUpbo/);assert.match(js,/ttsText/);assert.match(js,/overlayAssetKey/);
});
