import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {handleSoopGatewayIngress,ingestNormalizedSoopDonation} from '../lib/soop-gateway-api.js';
import {normalizeSoopChatSdkCallback,signSoopGatewayRequest} from '../lib/soop-chat-gateway.js';

const workspaceId='10000000-0000-4000-8000-000000000001';
const secret='gateway_secret_123456789012345678901234567890';
const env={SOOP_GATEWAY_INGRESS_ENABLED:'true',SOOP_GATEWAY_INGRESS_SECRET:secret};
function response(){return {statusCode:200,body:null,headers:{},status(code){this.statusCode=code;return this},setHeader(k,v){this.headers[k]=v},json(value){this.body=value;return this}}}
function request(body,headers={},signingSecret=secret){
  const timestamp=String(Date.now()),nonce='a'.repeat(32);
  const signature=signSoopGatewayRequest({secret:signingSecret,timestamp,nonce,body});
  return {method:'POST',headers:{
    'content-type':'application/json','x-byeollog-soop-gateway-secret':signingSecret,
    'x-byeollog-soop-gateway-timestamp':timestamp,'x-byeollog-soop-gateway-nonce':nonce,
    'x-byeollog-soop-gateway-signature':signature,...headers
  },body};
}
function relay(){return {schemaVersion:1,provider:'soop',eventType:'chat',event:{eventId:'chat-1',actor:{id:'viewer',name:'시청자'},message:'딸깍',occurredAt:'2026-08-29T03:00:00.000Z'},receivedAt:'2026-08-29T03:00:00.100Z',connection:{id:'gateway-instance:1',sequence:1,reconnectCount:0},rawPayloadSha256:'a'.repeat(64)}}

test('gateway ingress is indistinguishable from missing until server secret gate is enabled',async()=>{
  const res=response();let touched=false;
  await handleSoopGatewayIngress(request({kind:'heartbeat',workspaceId}),res,{env:{},sbImpl:async()=>{touched=true}});
  assert.equal(res.statusCode,404);assert.equal(touched,false);
});

test('gateway ingress rejects wrong service secret before workspace lookup',async()=>{
  const res=response();let touched=false;
  await handleSoopGatewayIngress(request({kind:'heartbeat',workspaceId},{},'x'.repeat(40)),res,{env,sbImpl:async()=>{touched=true}});
  assert.equal(res.statusCode,401);assert.equal(touched,false);
});

test('gateway ingress rejects stale signatures and disables legacy bearer by default',async()=>{
  const body={kind:'heartbeat',workspaceId};
  const timestamp=String(Date.now()-10*60_000),nonce='b'.repeat(32);
  const signature=signSoopGatewayRequest({secret,timestamp,nonce,body});
  const res=response();let touched=false;
  await handleSoopGatewayIngress({method:'POST',headers:{
    'content-type':'application/json','x-byeollog-soop-gateway-secret':secret,
    'x-byeollog-soop-gateway-timestamp':timestamp,'x-byeollog-soop-gateway-nonce':nonce,
    'x-byeollog-soop-gateway-signature':signature
  },body},res,{env,sbImpl:async()=>{touched=true}});
  assert.equal(res.statusCode,401);assert.equal(touched,false);
});

test('workspace control keeps every live gateway dormant by default',async()=>{
  const res=response();
  await handleSoopGatewayIngress(request({kind:'heartbeat',workspaceId,instanceId:'gateway-instance',state:'idle'}),res,{env,sbImpl:async()=>[{gateway_enabled:false,native_roulette_enabled:false}]});
  assert.equal(res.statusCode,409);assert.equal(res.body.code,'soop_gateway_disabled');
});

test('trusted gateway reconciles only workspaces with the production service enabled',async()=>{
  const res=response();
  await handleSoopGatewayIngress(request({kind:'reconcile'}),res,{env,sbImpl:async()=>[
    {workspace_id:workspaceId,gateway_enabled:true,native_roulette_enabled:true}
  ]});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body.workspaceIds,[workspaceId]);
});

test('trusted gateway obtains a short production execution lease through the server boundary',async()=>{
  const res=response(),future=new Date(Date.now()+60_000).toISOString();let refreshed=false;
  await handleSoopGatewayIngress(request({kind:'lease',workspaceId}),res,{
    env,sbImpl:async()=>[{gateway_enabled:true,native_roulette_enabled:true}],
    oauthConfig:()=>({clientId:'client-id',clientSecret:'client-secret'}),
    refreshConnection:async(id)=>{refreshed=id===workspaceId;return {accessToken:'access-token',expiresAt:future,refreshed:false}}
  });
  assert.equal(res.statusCode,200);assert.equal(refreshed,true);
  assert.equal(res.body.kind,'lease');assert.equal(res.body.accessToken,'access-token');assert.equal(res.body.clientSecret,'client-secret');
});

test('enabled heartbeat records only bounded operational state',async()=>{
  const calls=[];const res=response();
  await handleSoopGatewayIngress(request({kind:'heartbeat',workspaceId,instanceId:'gateway-instance',state:'waiting_for_live',heartbeatAt:'2026-08-29T03:00:00.000Z',reconnectCount:2,lastSequence:7}),res,{env,sbImpl:async(table,path,options)=>{calls.push({table,path,options});if(!options)return [{gateway_enabled:true,native_roulette_enabled:false}];return []}});
  assert.equal(res.statusCode,200);assert.equal(res.body.state,'waiting_for_live');
  assert.equal(calls[1].table,'byeollog_soop_gateway_sessions');
  assert.equal(calls[1].options.body.last_sequence,7);
  assert.equal('access_token' in calls[1].options.body,false);
});

test('event is normalized and observed but cannot run roulette while the activation flag is off',async()=>{
  const calls=[];const res=response();
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:relay(),metadata:{occurredAtSource:'provider'}}),res,{env,sbImpl:async(table,path,options)=>{calls.push({table,path,options});if(!options)return [{gateway_enabled:true,native_roulette_enabled:false}];if(table==='byeollog_soop_event_observations')return [{id:'observation'}];throw new Error('unexpected')}});
  assert.equal(res.statusCode,200);assert.equal(res.body.activated,false);assert.equal(res.body.reason,'native_roulette_disabled');
  assert.equal(calls.some(call=>String(call.table).startsWith('rpc/')),false);
  assert.doesNotMatch(JSON.stringify(calls),/딸깍|시청자/);
});

test('enabled donation commits its official kind, broadcast key, and release key through the wallpaper-aware v8 RPC',async()=>{
  const calls=[];const res=response();const enabledEnv={...env,NATIVE_ROULETTE_ENABLED:'true'};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:{...relay(),eventType:'donation',event:{eventId:'donation-1',actor:{id:'viewer',name:'시청자'},amount:33,donationTypeLabel:'도전미션',message:null,occurredAt:'2026-08-29T03:00:00.000Z'}}}),res,{env:enabledEnv,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options)return [{gateway_enabled:true,native_roulette_enabled:true}];
    if(table==='rpc/ingest_native_overlay_soop_donation_v8')return {duplicate:false,status:'queued',spinCount:1,ttsQueued:true,dataIsolation:'pre_approval',upboWrites:0,wallpaperRecorded:true};
    if(table==='byeollog_soop_event_observations')return [];
    throw new Error('unexpected '+table);
  }});
  assert.equal(res.statusCode,200);assert.equal(res.body.activated,true);
  assert.equal(calls[1].table,'rpc/ingest_native_overlay_soop_donation_v8');
  assert.equal(calls[1].options.body.p_broadcast_key,'gateway-instance:1');
  assert.equal(calls[1].options.body.p_release_key,'local-development');
  assert.equal(calls[1].options.body.p_ceremony_image_url,null);
  assert.equal(calls[1].options.body.p_donation_type_label,'도전미션');
  assert.equal(calls[2].table,'byeollog_soop_event_observations');
  assert.ok(calls[2].options.body.tts_queued_at);
});

test('ordinary SOOP balloon imageUrl survives the complete SDK to database ingress path',async()=>{
  const providerImage='https://static.file.sooplive.com/balloon/ceremony/ordinary-1.png?version=2';
  const normalized=normalizeSoopChatSdkCallback({
    action:'BALLOON_GIFTED',receivedAt:'2026-08-30T03:00:00.100Z',
    connection:{id:'gateway-instance:image-path',sequence:9,reconnectCount:0},
    message:{transactionId:'ordinary-image-1',userId:'viewer',userNickname:'시청자',count:1,imageUrl:providerImage}
  });
  const calls=[];
  await ingestNormalizedSoopDonation(workspaceId,normalized.relay,{sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    return {duplicate:false,status:'queued',spinCount:0,ceremonyQueued:true,ttsQueued:false,
      dataIsolation:'pre_approval',upboWrites:0};
  }});
  assert.equal(normalized.relay.event.ceremonyImageUrl,providerImage);
  assert.equal(calls[0].table,'rpc/ingest_native_overlay_soop_donation_v8');
  assert.equal(calls[0].options.body.p_broadcast_key,'gateway-instance:image-path');
  assert.equal(calls[0].options.body.p_amount,1);
  assert.equal(calls[0].options.body.p_ceremony_image_url,providerImage);
  assert.equal(calls[0].options.body.p_donation_type_label,'별풍선');
});

test('gateway observation stores only bounded provider image diagnostics',async()=>{
  const calls=[];const res=response();const enabledEnv={...env,NATIVE_ROULETTE_ENABLED:'true'};
  const donation={...relay(),eventType:'donation',event:{eventId:'diagnostic-image-1',actor:{id:'viewer',name:'시청자'},amount:1,donationTypeLabel:'별풍선',message:null,ceremonyImageUrl:'https://static.file.sooplive.com/a.png',occurredAt:'2026-08-29T03:00:00.000Z'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:donation,metadata:{occurredAtSource:'gateway_receive',ceremonyImage:{fieldPresent:true,valuePresent:true,accepted:true,scheme:'https',hostname:'static.file.sooplive.com',path:'/must-not-survive',token:'secret'}}}),res,{env:enabledEnv,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options)return [{gateway_enabled:true,native_roulette_enabled:true}];
    if(table==='rpc/ingest_native_overlay_soop_donation_v8')return {duplicate:false,status:'queued',spinCount:0,ttsQueued:false,dataIsolation:'pre_approval',upboWrites:0,wallpaperRecorded:true};
    if(table==='byeollog_soop_event_observations')return [];
    throw new Error('unexpected '+table);
  }});
  const details=calls.at(-1).options.body.details;
  assert.deepEqual(details.ceremonyImage,{fieldPresent:true,valuePresent:true,accepted:true,scheme:'https',hostname:'static.file.sooplive.com'});
  assert.doesNotMatch(JSON.stringify(details),/must-not-survive|secret/);
});

test('gateway fails closed when the database does not attest pre-approval isolation',async()=>{
  const calls=[];const res=response();const enabledEnv={...env,NATIVE_ROULETTE_ENABLED:'true'};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:{...relay(),eventType:'donation',event:{eventId:'donation-isolation-mismatch',actor:{id:'viewer',name:'시청자'},amount:33,message:null,occurredAt:'2026-08-29T03:00:00.000Z'}}}),res,{env:enabledEnv,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options)return [{gateway_enabled:true,native_roulette_enabled:true}];
    if(table==='rpc/ingest_native_overlay_soop_donation_v8')return {duplicate:false,status:'queued',spinCount:1};
    throw new Error('unexpected '+table);
  }});
  assert.equal(res.statusCode,503);
  assert.equal(res.body.code,'native_roulette_isolation_mismatch');
  assert.equal(calls.some(call=>call.table==='byeollog_soop_event_observations'),false);
});

test('streamer donation test crosses the normalized donation boundary but uses the isolated test RPC',async()=>{
  const calls=[];
  const testRelay={eventType:'donation',event:{
    eventId:'overlay-test:11111111-1111-4111-8111-111111111111',
    actor:{id:'byeollog-overlay-test',name:'후원 테스트'},amount:33,
    message:'오버레이와 티티에스 확인',occurredAt:'2026-08-29T03:00:00.000Z'
  }};
  const {resultRow}=await ingestNormalizedSoopDonation(workspaceId,testRelay,{testMode:true,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    return {duplicate:false,status:'queued',spinCount:1,presentationCount:1,
      dataIsolation:'manual_overlay_test',upboWrites:0,statisticsWrites:0};
  }});
  assert.equal(resultRow.dataIsolation,'manual_overlay_test');
  assert.equal(calls.length,1);
  assert.equal(calls[0].table,'rpc/enqueue_native_overlay_donation_test_v3');
  assert.equal(calls[0].options.body.p_amount,33);
  assert.equal(calls[0].options.body.p_message,'오버레이와 티티에스 확인');
  assert.equal('p_ceremony_image_url' in calls[0].options.body,false);
});

test('ordinary, signature, and roulette donations share one message TTS wrapper without browser access',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260830025645_enable_tts_for_all_donations.sql',import.meta.url),'utf8');
  assert.match(sql,/ingest_native_overlay_soop_donation_v5/i);
  assert.match(sql,/enqueue_native_overlay_donation_test_v2/i);
  assert.match(sql,/command_kind='donation_chat_tts'/i);
  assert.match(sql,/enqueue_native_roulette_chat_tts_v2/i);
  assert.doesNotMatch(sql,/v_spin_count\s*>\s*0\s+and\s+v_message/i);
  assert.match(sql,/'testMode',true,'dataIsolation','manual_overlay_test'/i);
  assert.match(sql,/event\.is_test/i);
  assert.match(sql,/revoke all on function public\.ingest_native_overlay_soop_donation_v5[\s\S]+from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute on function public\.ingest_native_overlay_soop_donation_v5[\s\S]+to service_role/i);
  assert.match(sql,/revoke all on function public\.enqueue_native_overlay_donation_test_v2[\s\S]+from public,anon,authenticated,service_role/i);
  assert.doesNotMatch(sql,/insert into public\.bangsel_tasks|insert into public\.bangsel_fans/i);
});

test('fixed follow-up migration advances a queued donation and gives every donation test a complete card',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260830045041_fixed_followup_queue_and_complete_donation_test.sql',import.meta.url),'utf8');
  assert.match(sql,/\{followupChatTtsWindowSeconds\}','15'::jsonb/i);
  assert.match(sql,/expires_at=wait\.opens_at\+interval '15 seconds'/i);
  assert.match(sql,/create or replace function public\.claim_native_roulette_overlay_v5/i);
  assert.match(sql,/claim_native_roulette_overlay_v4\([\s\S]*p_preferred_event_id/i);
  assert.match(sql,/claim_native_roulette_overlay_v4\([\s\S]*p_token_version,p_client_id,null/i);
  assert.match(sql,/create or replace function public\.enqueue_native_overlay_donation_test_v3/i);
  assert.match(sql,/v_presentation_count=0[\s\S]*'donation_ceremony'/i);
  assert.match(sql,/'donationTypeLabel','별풍선'/i);
  assert.match(sql,/'ceremony',jsonb_build_object\('source','none'\)/i);
  assert.match(sql,/enqueue_native_roulette_chat_tts_v2/i);
  assert.match(sql,/'dataIsolation','manual_overlay_test'[\s\S]*'upboWrites',0[\s\S]*'statisticsWrites',0/i);
  assert.doesNotMatch(sql,/insert into public\.bangsel_tasks|insert into public\.bangsel_fans/i);
  assert.match(sql,/revoke all on function public\.claim_native_roulette_overlay_v5[\s\S]+from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute on function public\.enqueue_native_overlay_donation_test_v3[\s\S]+to service_role/i);
});

test('real SOOP donation text correlates by id first and exact nickname second',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260830035415_correlate_soop_donation_message_by_name.sql',import.meta.url),'utf8');
  assert.match(sql,/add column if not exists actor_name text/i);
  assert.match(sql,/buffer\.actor_id=lower\(btrim\(p_actor_id\)\)\s+or lower\(buffer\.actor_name\)=lower\(btrim\(p_actor_name\)\)/i);
  assert.match(sql,/wait\.actor_id=lower\(btrim\(p_actor_id\)\)\s+or lower\(wait\.actor_name\)=lower\(btrim\(p_actor_name\)\)/i);
  assert.match(sql,/order by\s+\(buffer\.actor_id=lower\(btrim\(p_actor_id\)\)\) desc/i);
  assert.match(sql,/order by\s+\(wait\.actor_id=lower\(btrim\(p_actor_id\)\)\) desc/i);
  assert.match(sql,/'messageMatchKind',v_match_kind/i);
  assert.match(sql,/'matchKind',v_match_kind,'ttsQueued',true/i);
  assert.match(sql,/native_roulette_chat_waits_v2_name_match_idx/i);
  assert.match(sql,/native_roulette_chat_buffer_v2_name_match_idx/i);
  assert.match(sql,/revoke all on function public\.ingest_native_overlay_soop_donation_v5[\s\S]+from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute on function public\.ingest_native_overlay_soop_donation_v5[\s\S]+to service_role/i);
  assert.match(sql,/revoke all on function public\.ingest_native_roulette_soop_chat_v2[\s\S]+from public,anon,authenticated,service_role/i);
  assert.doesNotMatch(sql,/insert into public\.bangsel_tasks|insert into public\.bangsel_fans/i);
});

test('streamer donation test fails closed if the database loses its test isolation label',async()=>{
  const testRelay={eventType:'donation',event:{eventId:'overlay-test:11111111-1111-4111-8111-111111111111',
    actor:{id:'byeollog-overlay-test',name:'후원 테스트'},amount:33,message:null,
    occurredAt:'2026-08-29T03:00:00.000Z'}};
  await assert.rejects(
    ingestNormalizedSoopDonation(workspaceId,testRelay,{testMode:true,sbImpl:async()=>({
      status:'queued',spinCount:1,dataIsolation:'pre_approval',upboWrites:0
    })}),
    error=>error?.code==='native_roulette_isolation_mismatch'
  );
});

test('donation test migration uses the production sampler and outbox while permanently labelling test rows',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829183549_add_overlay_donation_test_mode.sql',import.meta.url),'utf8');
  for(const table of ['native_roulette_events_v2','native_roulette_spins_v2','native_roulette_overlay_outbox_v2']){
    assert.match(sql,new RegExp(`${table}[^;]+add column if not exists is_test boolean not null default false`,'i'));
  }
  assert.match(sql,/native_roulette_sample_ppm_v1\(\)/i);
  assert.match(sql,/native_roulette_overlay_outbox_v2/i);
  assert.match(sql,/enqueue_native_roulette_chat_tts_v2/i);
  assert.match(sql,/'testMode',true/i);
  assert.match(sql,/'dataIsolation','manual_overlay_test'/i);
  assert.match(sql,/'statisticsWrites',0/i);
  assert.match(sql,/'upboWrites',0/i);
  assert.match(sql,/char_length\(p_message\)>120/i);
  assert.match(sql,/revoke all on function public\.enqueue_native_overlay_donation_test_v1[\s\S]+from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute on function public\.enqueue_native_overlay_donation_test_v1[\s\S]+to service_role/i);
  assert.doesNotMatch(sql,/insert into public\.bangsel_tasks|insert into public\.bangsel_fans/i);
});

test('official SOOP donation kind migration is service-only and decorates presentation payloads',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829231235_preserve_soop_donation_type_in_overlay.sql',import.meta.url),'utf8');
  assert.match(sql,/ingest_native_overlay_soop_donation_v4/i);
  assert.match(sql,/v_label not in \('별풍선','대결미션','도전미션'\)/i);
  assert.match(sql,/payload=outbox\.payload\|\|jsonb_build_object\('donationTypeLabel',v_label\)/i);
  assert.match(sql,/revoke all on function public\.ingest_native_overlay_soop_donation_v4[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute on function public\.ingest_native_overlay_soop_donation_v4[\s\S]*to service_role/i);
});

test('pre-approval migration quarantines old native upbo rows and blocks every future legacy write',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829114729_isolate_preapproval_native_roulette.sql',import.meta.url),'utf8');
  assert.match(sql,/preapproval_native_roulette_upbo_quarantine_v1/i);
  assert.match(sql,/delete from public\.bangsel_tasks/i);
  assert.match(sql,/create trigger deny_preapproval_native_roulette_upbo_v1/i);
  assert.match(sql,/raise exception 'native roulette upbo writes are isolated until approval'/i);
  assert.match(sql,/'dataIsolation','pre_approval'/i);
  assert.match(sql,/'upboWrites',0/i);
  assert.match(sql,/'upboSuppressed',v_direct/i);
  assert.doesNotMatch(sql,/insert into public\.bangsel_tasks|insert into public\.bangsel_fans/i);
});

test('gateway observability schema is service-only, RLS locked, and live flags default off',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260828173951_soop_gateway_readiness_observability.sql',import.meta.url),'utf8');
  assert.match(sql,/gateway_enabled boolean not null default false/i);
  assert.match(sql,/native_roulette_enabled boolean not null default false/i);
  for(const table of ['byeollog_soop_runtime_controls','byeollog_soop_gateway_sessions','byeollog_soop_event_observations','byeollog_soop_diagnostic_runs']){
    assert.match(sql,new RegExp(`alter table public\\.${table} enable row level security`,'i'));
    assert.match(sql,new RegExp(`revoke all on table public\\.${table} from public,anon,authenticated,service_role`,'i'));
  }
  assert.doesNotMatch(sql,/create policy/i);
  assert.match(sql,/after insert or update of workspace_id on public\.byeollog_soop_connections/i);
  assert.match(sql,/on conflict\(workspace_id\) do nothing/i);
});

test('gateway incident monitor is service-only, database scheduled, and webhook optional',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260829164723_add_soop_gateway_incident_monitor.sql',import.meta.url),'utf8');
  assert.match(sql,/heartbeat_at<v_now-interval '45 seconds'/i);
  assert.match(sql,/cron\.schedule\([\s\S]*'30 seconds'/i);
  assert.match(sql,/soop_gateway_alert_webhook_url/i);
  assert.match(sql,/coalesce\(v_url,''\)!~'\^https:/i);
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/revoke all on table public\.byeollog_soop_gateway_incidents from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant select,insert,update,delete on table public\.byeollog_soop_gateway_incidents to service_role/i);
  assert.match(sql,/No chat or viewer content is stored/i);
});

test('gateway incident monitor keeps live detection strict while permitting offline heartbeat coalescing',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260831063842_relax_offline_gateway_heartbeat_monitor.sql',import.meta.url),'utf8');
  assert.match(sql,/case when session\.state='connected' then 45 else 600 end/i);
  assert.match(sql,/make_interval\(secs=>threshold_seconds\)/i);
  assert.match(sql,/상태별 허용 시간을 초과했습니다/i);
  assert.match(sql,/revoke all on function private\.check_soop_gateway_heartbeats_v1\(\)[\s\S]+from public,anon,authenticated,service_role/i);
  assert.doesNotMatch(sql,/create policy/i);
});

test('live heartbeat coalescing allows two missed reports without changing the event hot path',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260901165151_coalesce_live_gateway_heartbeat_without_hot_path_changes.sql',import.meta.url),'utf8');
  assert.match(sql,/case when session\.state='connected' then 150 else 600 end/i);
  assert.match(sql,/make_interval\(secs=>threshold_seconds\)/i);
  assert.match(sql,/revoke all on function private\.check_soop_gateway_heartbeats_v1\(\)[\s\S]+from public,anon,authenticated,service_role/i);
  const runner=await readFile(new URL('../services/soop-chat-gateway/index.mjs',import.meta.url),'utf8');
  assert.match(runner,/shouldSendSoopGatewayHeartbeat/);
  assert.match(runner,/X-Byeollog-Soop-Gateway-Signature/);
  assert.doesNotMatch(runner,/X-Byeollog-Soop-Gateway-Secret/);
  assert.match(runner,/enqueueGatewayEvent\(\{kind:'event'/);
  assert.match(runner,/void flushOutbox\(\)/);
  assert.doesNotMatch(runner,/await heartbeat\([^\n]+enqueueGatewayEvent/);
});

test('browser gateway follows the current SOOP Chat SDK lifecycle and resolves the real page context',async()=>{
  const source=await readFile(new URL('../services/soop-chat-gateway/browser-session.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/chat\.init\s*\(/);
  assert.match(source,/new window\.SOOP\.ChatSDK\(config\.clientId,config\.clientSecret\)/);
  assert.match(source,/expression:'window',returnByValue:false/);
  assert.match(source,/objectId:shard\.pageObjectId/);
  assert.doesNotMatch(source,/executionContextId\s*:\s*1/);
  assert.match(source,/chat\.handleReady\(message=>\{const room=chat\.getRoomInfo\(\)/);
  assert.match(source,/if\(payload&&'imageUrl' in message\)payload\.imageUrl=message\.imageUrl/);
  assert.doesNotMatch(source,/await chat\.connect\(\);[^\n]+chat\.getRoomInfo\(\)/);
  assert.match(source,/SOOP_SHARED_BROWSER_POLICY=Object\.freeze\(\{browserProcesses:1,rendererProcessLimit:8,targetCreationConcurrency:8,sessionsPerShard:16,shardMaxAgeMs:300_000\}\)/);
  assert.match(source,/startByeollogGateway=async\(sessionId,config\)/);
  assert.match(source,/const chats=new Map\(\)/);
  assert.match(source,/acquireShardSession/);
  assert.match(source,/async function createSharedBrowserHost\(\)/);
  assert.match(source,/const host=await browserHost\(\)/);
  assert.match(source,/host\.createTarget\(\)/);
  assert.match(source,/await host\.closeTarget\(target\.id\)/);
  assert.match(source,/openSoopSharedBrowserProbeTargets/);
  assert.match(source,/--renderer-process-limit=/);
  assert.match(source,/--disable-renderer-backgrounding/);
  assert.match(source,/createTargetLimited/);
  assert.match(source,/session\.finish\('browser_closed'\)/);
  assert.equal((source.match(/spawn\(executable/g)||[]).length,1);
  const runner=await readFile(new URL('../services/soop-chat-gateway/index.mjs',import.meta.url),'utf8');
  assert.match(runner,/lastErrorCode,chatNumber,\.\.\.extra/);
  assert.match(runner,/chatNumber=Number\(room\?\.chatNumber\)\|\|null/);
  assert.match(runner,/classifySoopChatSdkCallback/);
  assert.match(runner,/SoopRelevantChatGate/);
  assert.match(runner,/chatGate\.arm\(normalized\.relay\.event\.actor\)/);
  assert.match(runner,/!chatGate\.shouldForward\(normalized\.relay\.event\.actor\)/);
  assert.match(runner,/SOOP_GATEWAY_HEARTBEAT_POLICY\.checkMs/);
  assert.match(runner,/RECONCILE_MS=60_000/);
  assert.match(runner,/expiresAt-Date\.now\(\)>LEASE_REFRESH_SKEW_MS/);
  assert.match(runner,/sdk_event_ignored/);
  assert.match(runner,/eventType:normalized\.relay\.eventType,sequence:currentSequence/);
  assert.match(runner,/stableSoopGatewayStaggerMs/);
  assert.match(runner,/await closeSoopBrowserHost\(\)/);
});

test('Windows gateway supervisor and task keep the worker recoverable without user controls',async()=>{
  const runner=await readFile(new URL('../tools/Run-SoopGatewayHidden.ps1',import.meta.url),'utf8');
  const supervisor=await readFile(new URL('../services/soop-chat-gateway/supervisor.mjs',import.meta.url),'utf8');
  const installer=await readFile(new URL('../tools/Install-SoopGatewayTask.ps1',import.meta.url),'utf8');
  const hiddenLauncher=await readFile(new URL('../tools/Run-PowerShellHidden.vbs',import.meta.url),'utf8');
  const watchdog=await readFile(new URL('../tools/Ensure-SoopGatewayRunning.ps1',import.meta.url),'utf8');
  assert.match(runner,/supervisor\.mjs/);
  assert.match(runner,/gateway_supervisor_process_exited/);
  assert.doesNotMatch(runner,/while\(\$true\)/);
  assert.match(runner,/Local\\ByeollogSoopGateway/);
  assert.match(runner,/UTF8Encoding.*false/);
  assert.match(runner,/AppendAllText/);
  assert.doesNotMatch(runner,/Tee-Object/);
  assert.match(supervisor,/unclean_previous_supervisor_exit/);
  assert.match(supervisor,/gateway_child_restart_scheduled/);
  assert.match(supervisor,/supervisor-state\.json/);
  assert.match(installer,/New-ScheduledTaskTrigger -AtLogOn/);
  assert.match(installer,/RestartCount 999/);
  assert.match(installer,/Start-ScheduledTask/);
  assert.match(installer,/AllowStartIfOnBatteries/);
  assert.match(installer,/DontStopIfGoingOnBatteries/);
  assert.match(installer,/Byeollog SOOP Gateway Watchdog/);
  assert.match(installer,/RepetitionInterval \(New-TimeSpan -Minutes 1\)/);
  assert.match(installer,/wscript\.exe/);
  assert.match(installer,/\/\/B \/\/Nologo/);
  assert.doesNotMatch(installer,/New-ScheduledTaskAction -Execute \$powerShellPath/);
  assert.match(hiddenLauncher,/shell\.Run\(command, 0, True\)/i);
  assert.match(watchdog,/127\.0\.0\.1:47631\/healthz/);
  assert.match(watchdog,/gateway_health_restart_requested/);
});
