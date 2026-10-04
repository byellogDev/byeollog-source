import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {handleSoopGatewayIngress,ingestNormalizedSoopDonation} from '../../apps/collector-runtime/lib/soop-gateway-api.js';
import {normalizeSoopChatSdkCallback,signSoopGatewayRequest} from '../../apps/collector-runtime/lib/soop-chat-gateway.js';
import {issueSoopGatewayLease} from '../../apps/collector-runtime/lib/soop-gateway-lease.js';

const workspaceId='10000000-0000-4000-8000-000000000001';
const instanceId='gateway-instance';
const providerAccountId='streamer01';
const room={bjId:providerAccountId,chatNumber:43120};
const secret='gateway_secret_123456789012345678901234567890';
const env={SOOP_GATEWAY_INGRESS_ENABLED:'true',SOOP_GATEWAY_INGRESS_SECRET:secret};
function response(){return {statusCode:200,body:null,headers:{},status(code){this.statusCode=code;return this},setHeader(k,v){this.headers[k]=v},json(value){this.body=value;return this}}}
function request(body,headers={},signingSecret=secret){
  if(['event','heartbeat'].includes(body?.kind)&&!body.leaseToken){
    body={...body,instanceId:body.instanceId||instanceId,
      leaseToken:issueSoopGatewayLease({workspaceId:body.workspaceId,broadcasterId:providerAccountId,
        instanceId:body.instanceId||instanceId,expiresAt:Date.now()+60_000},env),
      ...(body.kind==='event'||body.state==='connected'?{room:body.room||room}:{})};
  }
  const timestamp=String(Date.now()),nonce='a'.repeat(32);
  const signature=signSoopGatewayRequest({secret:signingSecret,timestamp,nonce,body});
  return {method:'POST',headers:{
    'content-type':'application/json','x-byeollog-soop-gateway-secret':signingSecret,
    'x-byeollog-soop-gateway-timestamp':timestamp,'x-byeollog-soop-gateway-nonce':nonce,
    'x-byeollog-soop-gateway-signature':signature,...headers
  },body};
}
function relay(){return {schemaVersion:1,provider:'soop',eventType:'chat',event:{eventId:'chat-1',actor:{id:'viewer',name:'시청자'},message:'딸깍',occurredAt:'2026-08-29T03:00:00.000Z'},receivedAt:'2026-08-29T03:00:00.100Z',connection:{id:`${instanceId}:${workspaceId}:1`,sequence:1,reconnectCount:0},rawPayloadSha256:'a'.repeat(64)}}

test('video gift passes signed, leased, room-owned ingress into core wallpaper donation',async()=>{
  const normalized=normalizeSoopChatSdkCallback({action:'VIDEOBALLOON_GIFTED',
    message:{bjId:providerAccountId,userId:'viewer',userNickname:'영상후원자',count:100,imageUrl:'https://res.sooplive.com/new_player/items/img_video_balloon.png'},
    connection:{id:`${instanceId}:${workspaceId}:1`,sequence:8,reconnectCount:0},receivedAt:'2026-09-23T00:00:00Z'});
  const calls=[],res=response();
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:normalized.relay}),res,{
    env,sbImpl:async(table,path,options)=>{
      calls.push(table);
      if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true}];
      if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
      if(table==='byeollog_soop_event_observations')return [];
      if(table==='rpc/ingest_soop_core_donation_v2'){
        const body=typeof options.body==='string'?JSON.parse(options.body):options.body;
        assert.equal(body.p_donation_type_label,'영상후원');
        assert.equal(body.p_amount,100);
        assert.equal(body.p_workspace_id,workspaceId);
        return {status:'recorded',wallpaperRecorded:true,sourceUid:null,fixedRuleCount:0};
      }
      assert.fail(`unexpected RPC ${table}`);
    }
  });
  assert.equal(res.statusCode,200);
  assert.ok(calls.includes('rpc/ingest_soop_core_donation_v2'));
  assert.ok(!calls.includes('rpc/ingest_soop_wallpaper_adballoon_v1'));
});

test('one ingress deadline reaches each database request and stops stalled processing',async()=>{
  const abort=new AbortController(),res=response();let calls=0;
  const pending=handleSoopGatewayIngress(request({kind:'heartbeat',workspaceId,state:'waiting_for_live'}),res,{
    env,signal:abort.signal,sbImpl:async(table,path,options)=>{
      calls++;assert.equal(options.signal,abort.signal);
      if(calls===1)return [{gateway_enabled:true,core_collection_enabled:true}];
      return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    }
  });
  await new Promise(resolve=>setTimeout(resolve,5));abort.abort();await pending;
  assert.equal(calls,2);assert.equal(res.statusCode,503);
  assert.equal(res.body.code,'soop_gateway_deadline_exceeded');assert.equal(res.headers['Retry-After'],'5');
});

test('live adballoon reaches only the ownership-checked wallpaper RPC, never Upbo/native roulette',async()=>{
  const normalized=normalizeSoopChatSdkCallback({action:'ADBALLOON_GIFTED',
    message:{userId:'viewer',userNickname:'광고후원자',count:33,imageUrl:'https://res.sooplive.com/ad.png',fromVod:false,fromStation:false},
    connection:{id:`${instanceId}:${workspaceId}:1`,sequence:7,reconnectCount:0},receivedAt:'2026-09-20T00:00:00Z'});
  const res=response(),calls=[];
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:normalized.relay}),res,{
    env,processCollector:async()=>assert.fail('adballoon must not create Upbo'),sbImpl:async(table,path,options)=>{
      calls.push(table);
      if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true}];
      if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
      if(table==='rpc/ingest_soop_wallpaper_adballoon_v1'){
        assert.equal(options.body.p_amount,33);assert.equal(options.body.p_donation_type_label,'애드벌룬');
        assert.equal(options.body.p_ceremony_image_url,'https://res.sooplive.com/ad.png');
        return {duplicate:false,status:'recorded',wallpaperRecorded:true,sourceUid:null,fixedRuleCount:0};
      }
      if(table==='byeollog_soop_event_observations')return [];
      assert.fail('unexpected write '+table);
    }});
  assert.equal(res.statusCode,200);assert.equal(res.body.activated,true);
  assert.ok(calls.includes('rpc/ingest_soop_wallpaper_adballoon_v1'));
  await assert.rejects(ingestNormalizedSoopDonation(workspaceId,normalized.relay,{sbImpl:async()=>assert.fail('native path reached')}));
});

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
    {workspace_id:workspaceId,gateway_enabled:true,core_collection_enabled:true}
  ]});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body.workspaceIds,[workspaceId]);
});

test('trusted gateway obtains a short collection lease through the server boundary',async()=>{
  const res=response(),requestedAt=Date.now(),future=new Date(requestedAt+60*60_000).toISOString();let refreshed=false;
  await handleSoopGatewayIngress(request({kind:'lease',workspaceId,instanceId}),res,{
    env,sbImpl:async(table)=>table==='byeollog_workspaces'
      ?[{id:workspaceId,soop_id:providerAccountId,status:'active'}]
      :[{gateway_enabled:true,core_collection_enabled:true,native_roulette_enabled:false}],
    oauthConfig:()=>({clientId:'client-id',clientSecret:'client-secret'}),
    refreshConnection:async(id)=>{refreshed=id===workspaceId;return {accessToken:'access-token',expiresAt:future,refreshed:false}}
  });
  assert.equal(res.statusCode,200);assert.equal(refreshed,true);
  assert.equal(res.body.kind,'lease');assert.equal(res.body.accessToken,'access-token');assert.equal(res.body.clientSecret,'client-secret');
  assert.equal(res.body.providerAccountId,providerAccountId);assert.ok(res.body.leaseToken);
  assert.equal(res.body.providerTokenExpiresAt,future);
  assert.ok(Date.parse(res.body.expiresAt)>=requestedAt+9*60_000);
  assert.ok(Date.parse(res.body.expiresAt)<=Date.now()+10*60_000);
  assert.ok(Date.parse(res.body.expiresAt)<Date.parse(res.body.providerTokenExpiresAt));
});

test('enabled heartbeat records only bounded operational state',async()=>{
  const calls=[];const res=response();
  await handleSoopGatewayIngress(request({kind:'heartbeat',workspaceId,instanceId:'gateway-instance',state:'waiting_for_live',heartbeatAt:'2026-08-29T03:00:00.000Z',reconnectCount:2,lastSequence:7}),res,{env,sbImpl:async(table,path,options)=>{calls.push({table,path,options});if(!options?.method)return [{gateway_enabled:true,native_roulette_enabled:false}];return []}});
  assert.equal(res.statusCode,200);assert.equal(res.body.state,'waiting_for_live');
  assert.equal(calls[1].table,'byeollog_soop_gateway_sessions');
  assert.equal(calls[1].options.body.last_sequence,7);
  assert.equal(calls[1].options.body.connected_at,null);
  assert.equal(calls[1].options.body.last_event_at,null);
  assert.equal(calls[1].options.body.token_expires_at,null);
  assert.equal(calls[1].options.body.bj_id,null);
  assert.equal('access_token' in calls[1].options.body,false);
});

test('room identity mismatch is rejected before any workspace or donation write',async()=>{
  const res=response();let touched=false;
  const body={kind:'event',workspaceId,instanceId,room:{bjId:'another-streamer',chatNumber:999},relay:relay()};
  body.leaseToken=issueSoopGatewayLease({workspaceId,broadcasterId:providerAccountId,instanceId,expiresAt:Date.now()+60_000},env);
  await handleSoopGatewayIngress(request(body),res,{env,sbImpl:async()=>{touched=true}});
  assert.equal(res.statusCode,409);assert.equal(res.body.code,'soop_room_owner_mismatch');assert.equal(touched,false);
});

test('a provider event already owned by another workspace is quarantined before core, wallpaper or Upbo writes',async()=>{
  const calls=[];const res=response();
  const donation={...relay(),eventType:'donation',event:{eventId:'cross-workspace',actor:{id:'viewer',name:'시청자'},amount:33,donationTypeLabel:'별풍선',occurredAt:'2026-09-06T00:00:00Z'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:donation}),res,{env,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true}];
    if(table==='rpc/claim_soop_event_ownership_v1')return 'conflict';
    throw new Error(`unexpected ${table}`);
  }});
  assert.equal(res.statusCode,409);assert.equal(res.body.code,'soop_event_workspace_conflict');
  assert.deepEqual(calls.map(call=>call.table),['byeollog_soop_runtime_controls','rpc/claim_soop_event_ownership_v1']);
});

test('two concurrent workspaces cannot commit the same provider donation or reach each other downstream',async()=>{
  const workspaceB='20000000-0000-4000-8000-000000000002';
  const instanceB='gateway-instance-b';
  const providerB='streamer02';
  const owners=new Map(),ingested=[];
  const sbImpl=async(table,_path,options)=>{
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true,native_roulette_enabled:false}];
    if(table==='rpc/claim_soop_event_ownership_v1'){
      const fingerprint=options.body.p_event_fingerprint;
      const owner=owners.get(fingerprint);
      if(owner&&owner!==options.body.p_workspace_id)return 'conflict';
      owners.set(fingerprint,options.body.p_workspace_id);
      return owner?'owned':'claimed';
    }
    if(table==='rpc/ingest_soop_core_donation_v2'){
      ingested.push(options.body);
      return {duplicate:false,status:'recorded',wallpaperRecorded:true};
    }
    if(table==='byeollog_soop_event_observations')return [];
    throw new Error('unexpected '+table);
  };
  const donation={...relay(),eventType:'donation',event:{
    eventId:'shared-provider-event',actor:{id:'viewer',name:'시청자'},amount:33,
    donationTypeLabel:'별풍선',occurredAt:'2026-09-07T00:00:00.000Z'
  }};
  const resA=response();
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:donation}),resA,{env,sbImpl});
  assert.equal(resA.statusCode,200);

  const relayB={...donation,connection:{...donation.connection,id:`${instanceB}:${workspaceB}:1`}};
  const bodyB={kind:'event',workspaceId:workspaceB,instanceId:instanceB,
    leaseToken:issueSoopGatewayLease({workspaceId:workspaceB,broadcasterId:providerB,
      instanceId:instanceB,expiresAt:Date.now()+60_000},env),
    room:{bjId:providerB,chatNumber:43121},relay:relayB};
  const resB=response();
  await handleSoopGatewayIngress(request(bodyB),resB,{env,sbImpl});
  assert.equal(resB.statusCode,409);
  assert.equal(resB.body.code,'soop_event_workspace_conflict');
  assert.equal(ingested.length,1);
  assert.equal(ingested[0].p_workspace_id,workspaceId);
  assert.equal(ingested[0].p_provider_bj_id,providerAccountId);
});

test('signed out-of-contract donation is acknowledged as ignored without touching the database RPC',async t=>{
  const warnings=[];t.mock.method(console,'warn',(...args)=>warnings.push(args));
  const calls=[];const res=response();
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,metadata:{action:'BALLOON_GIFTED'},relay:{
    ...relay(),eventType:'donation',event:{eventId:'bad-count',actor:{id:'viewer',name:'시청자'},amount:1_000_000_001,donationTypeLabel:'별풍선',occurredAt:'2026-09-06T00:00:00Z'}
  }}),res,{env,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true}];
    throw new Error('database must not be touched');
  }});
  assert.equal(res.statusCode,200);
  assert.equal(res.body.reason,'invalid_donation_amount');
  assert.equal(calls.length,1);
  assert.equal(warnings.length,1);
  assert.doesNotMatch(JSON.stringify(warnings),/viewer|시청자|bad-count/);
});

test('database constraint failures log only bounded event diagnostics',async t=>{
  const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
  const res=response();
  const donation={...relay(),eventType:'donation',event:{eventId:'private-event',actor:{id:'private-viewer',name:'비공개'},amount:33,donationTypeLabel:'별풍선',occurredAt:'2026-09-06T00:00:00Z'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,metadata:{action:'BALLOON_GIFTED'},relay:donation}),res,{env,sbImpl:async(table,_path,options)=>{
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true}];
    if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
    if(table==='rpc/ingest_soop_core_donation_v2'){
      const error=Object.assign(new Error('new row violates check constraint "safe_amount_check"'),{
        code:'23514',status:400,detail:{message:'private payload',details:'Failing row contains private-viewer',constraint:'safe_amount_check'}
      });
      throw error;
    }
    throw new Error('unexpected');
  }});
  assert.equal(res.statusCode,400);
  assert.equal(logs.length,1);
  assert.deepEqual(logs[0][1],{
    code:'23514',status:400,kind:'event',eventType:'donation',action:'BALLOON_GIFTED',constraint:'safe_amount_check'
  });
  assert.doesNotMatch(JSON.stringify(logs),/private-viewer|비공개|private payload/);
});

test('ordinary chat is normalized and observed without entering roulette correlation',async()=>{
  const calls=[];const res=response();
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:relay(),metadata:{occurredAtSource:'provider'}}),res,{env,sbImpl:async(table,path,options)=>{calls.push({table,path,options});if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true,native_roulette_enabled:false}];if(table==='byeollog_soop_event_observations')return [{id:'observation'}];throw new Error('unexpected')}});
  assert.equal(res.statusCode,200);assert.equal(res.body.activated,false);assert.equal(res.body.reason,'not_external_roulette_result');
  assert.equal(calls.some(call=>String(call.table).startsWith('rpc/')),false);
  assert.doesNotMatch(JSON.stringify(calls),/딸깍|시청자/);
});

test('enabled donation records wallpaper and history without native roulette or TTS',async()=>{
  const calls=[];const processed=[];const res=response();
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:{...relay(),eventType:'donation',event:{eventId:'donation-1',actor:{id:'viewer',name:'시청자'},amount:33,donationTypeLabel:'도전미션',message:null,occurredAt:'2026-08-29T03:00:00.000Z'}}}),res,{env,processCollector:async input=>processed.push(input),sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true,native_roulette_enabled:false}];
    if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
    if(table==='rpc/ingest_soop_core_donation_v2')return {duplicate:false,status:'recorded',wallpaperRecorded:true,sourceUid:'soop_sdk:donation-1',fixedRuleCount:1};
    if(table==='byeollog_soop_event_observations')return [];
    throw new Error('unexpected '+table);
  }});
  assert.equal(res.statusCode,200);assert.equal(res.body.activated,true);
  assert.equal(calls[1].table,'rpc/claim_soop_event_ownership_v1');
  assert.equal(calls[2].table,'rpc/ingest_soop_core_donation_v2');
  assert.equal(calls[2].options.body.p_broadcast_key,`${instanceId}:${workspaceId}:1`);
  assert.equal(calls[2].options.body.p_release_key,'local-development');
  assert.equal(calls[2].options.body.p_ceremony_image_url,null);
  assert.equal(calls[2].options.body.p_donation_type_label,'도전미션');
  assert.equal(calls[2].options.body.p_provider_bj_id,providerAccountId);
  assert.equal(calls[2].options.body.p_source_chat_number,room.chatNumber);
  assert.match(calls[2].options.body.p_event_fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(calls[3].table,'byeollog_soop_event_observations');
  assert.equal(calls[3].options.body.tts_queued_at,null);
  assert.equal(processed[0].signal instanceof AbortSignal,true);assert.deepEqual(processed.map(({signal,...rest})=>rest),[{sourceUids:['soop_sdk:donation-1'],workspaceId}]);
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
  const calls=[];const res=response();
  const donation={...relay(),eventType:'donation',event:{eventId:'diagnostic-image-1',actor:{id:'viewer',name:'시청자'},amount:1,donationTypeLabel:'별풍선',message:null,ceremonyImageUrl:'https://static.file.sooplive.com/a.png',occurredAt:'2026-08-29T03:00:00.000Z'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:donation,metadata:{occurredAtSource:'gateway_receive',ceremonyImage:{fieldPresent:true,valuePresent:true,accepted:true,scheme:'https',hostname:'static.file.sooplive.com',path:'/must-not-survive',token:'secret'}}}),res,{env,sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true,native_roulette_enabled:false}];
    if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
    if(table==='rpc/ingest_soop_core_donation_v2')return {duplicate:false,status:'recorded',wallpaperRecorded:true};
    if(table==='byeollog_soop_event_observations')return [];
    throw new Error('unexpected '+table);
  }});
  const details=calls.at(-1).options.body.details;
  assert.deepEqual(details.ceremonyImage,{fieldPresent:true,valuePresent:true,accepted:true,scheme:'https',hostname:'static.file.sooplive.com'});
  assert.doesNotMatch(JSON.stringify(details),/must-not-survive|secret/);
});

test('viewer, lookalike, malformed suffix and missing authors cannot consume FIFO or create exception rows',async()=>{
  for(const id of ['viewer',providerAccountId+'evil',providerAccountId+'(x)',providerAccountId+'(0)extra',providerAccountId+'(0)(1)']){
    const calls=[],res=response();
    await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:{...relay(),event:{...relay().event,actor:{id,name:'스트리머'},message:'룰렛 결과 : 시크릿 단컷'}}}),res,{env,processCollector:async()=>assert.fail('untrusted author reached upbo'),sbImpl:async(table,path,options)=>{
      calls.push(table);if(table==='byeollog_soop_runtime_controls')return [{gateway_enabled:true,core_collection_enabled:true}];assert.fail('untrusted author caused a database write');
    }});
    assert.equal(res.statusCode,200);assert.equal(res.body.reason,'untrusted_roulette_author');assert.deepEqual(calls,['byeollog_soop_runtime_controls']);
  }
});

test('external roulette result is processed only after the database matches one donation',async()=>{
  const calls=[];const processed=[];const res=response();
  const resultRelay={...relay(),event:{...relay().event,eventId:'chat-result-1',actor:{id:providerAccountId+'(0)',name:'스트리머'},message:'룰렛 결과 : 물 한 잔'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:resultRelay}),res,{env,processCollector:async input=>processed.push(input),sbImpl:async(table,path,options)=>{
    calls.push({table,path,options});
    if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true,native_roulette_enabled:false}];
    if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
    if(table==='rpc/ingest_soop_external_roulette_result_v4')return {duplicate:false,matched:true,status:'matched',matchMethod:'fifo_expected_spins',sourceUid:'soop_sdk:donation-1'};
    if(table==='byeollog_soop_event_observations')return [];
    throw new Error('unexpected '+table);
  }});
  assert.equal(res.statusCode,200);
  assert.equal(res.body.activated,true);
  assert.equal(calls[1].table,'rpc/ingest_soop_external_roulette_result_v4');
  assert.equal(calls[1].options.body.p_broadcast_key,`${instanceId}:${workspaceId}:1`);
  assert.equal(calls[1].options.body.p_provider_bj_id,providerAccountId);
  assert.equal(calls[1].options.body.p_source_chat_number,43120);
  assert.match(calls[1].options.body.p_event_fingerprint,/^[0-9a-f]{64}$/);
  assert.equal(processed[0].signal instanceof AbortSignal,true);assert.deepEqual(processed.map(({signal,...rest})=>rest),[{sourceUids:['soop_sdk:donation-1'],workspaceId}]);
});

test('disabled roulette is ACKed without observation, ownership or Upbo writes',async()=>{
  const res=response(),calls=[];
  const resultRelay={...relay(),event:{...relay().event,actor:{id:providerAccountId,name:'스트리머'},message:'룰렛 결과 : A'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:resultRelay}),res,{
    env,processCollector:async()=>assert.fail('disabled roulette reached Upbo'),sbImpl:async(table)=>{
      calls.push(table);
      if(table==='byeollog_soop_runtime_controls')return [{gateway_enabled:true,core_collection_enabled:true}];
      if(table==='rpc/ingest_soop_external_roulette_result_v4')return {matched:false,status:'roulette_collection_disabled'};
      assert.fail('disabled result caused an extra write');
    }
  });
  assert.equal(res.statusCode,200);assert.equal(res.body.reason,'roulette_collection_disabled');assert.equal(res.body.activated,false);
  assert.deepEqual(calls,['byeollog_soop_runtime_controls','rpc/ingest_soop_external_roulette_result_v4']);
});

test('unavailable activation decision is retried, never mistaken for disabled roulette',async t=>{
  t.mock.method(console,'error',()=>{});const res=response();
  const resultRelay={...relay(),event:{...relay().event,actor:{id:providerAccountId,name:'스트리머'},message:'룰렛 결과 : A'}};
  await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:resultRelay}),res,{
    env,sbImpl:async(table)=>{
      if(table==='byeollog_soop_runtime_controls')return [{gateway_enabled:true,core_collection_enabled:true}];
      throw Object.assign(new Error('temporary DB outage'),{status:503});
    }
  });
  assert.equal(res.statusCode,503);assert.notEqual(res.body.reason,'roulette_collection_disabled');
});

test('upbo failures emit bounded diagnostics without pretending retries or blocking the ingress ACK',async t=>{
  const logs=[];t.mock.method(console,'error',(...args)=>logs.push(args));
  const donation={...relay(),eventType:'donation',event:{eventId:'diagnostic-failure',actor:{id:'private-id',name:'private-name'},amount:33,donationTypeLabel:'별풍선',occurredAt:'2026-09-06T00:00:00Z'}};
  for(const throws of [false,true]){
    const res=response();
    await handleSoopGatewayIngress(request({kind:'event',workspaceId,relay:donation}),res,{
      env,processCollector:async()=>{if(throws)throw Error('private-token-error');return {ok:false,results:[{error:'private-detail'}]}},
      sbImpl:async(table,_path,options)=>{
        if(!options?.method)return [{gateway_enabled:true,core_collection_enabled:true}];
        if(table==='rpc/claim_soop_event_ownership_v1')return 'claimed';
        if(table==='rpc/ingest_soop_core_donation_v2')return {status:'recorded',sourceUid:'soop_sdk:private-source'};
        if(table==='byeollog_soop_event_observations')return [];
        throw Error('unexpected '+table);
      }
    });
    assert.equal(res.statusCode,200,'automatic retry is explicitly deferred, not secretly enabled');
  }
  assert.equal(logs.length,2);assert.equal(logs[0][1].code,'upbo_processing_failed');
  assert.equal(logs[1][1].code,'upbo_processing_exception');
  assert.equal(logs[0][1].retryScheduled,false);
  assert.doesNotMatch(JSON.stringify(logs),/private-|deferred/);
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
  const sql=await readFile(auditURL('../supabase/migrations/20260830025645_enable_tts_for_all_donations.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260830045041_fixed_followup_queue_and_complete_donation_test.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260830035415_correlate_soop_donation_message_by_name.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260829183549_add_overlay_donation_test_mode.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260829231235_preserve_soop_donation_type_in_overlay.sql',import.meta.url),'utf8');
  assert.match(sql,/ingest_native_overlay_soop_donation_v4/i);
  assert.match(sql,/v_label not in \('별풍선','대결미션','도전미션'\)/i);
  assert.match(sql,/payload=outbox\.payload\|\|jsonb_build_object\('donationTypeLabel',v_label\)/i);
  assert.match(sql,/revoke all on function public\.ingest_native_overlay_soop_donation_v4[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant execute on function public\.ingest_native_overlay_soop_donation_v4[\s\S]*to service_role/i);
});

test('pre-approval migration quarantines old native upbo rows and blocks every future legacy write',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260829114729_isolate_preapproval_native_roulette.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260828173951_soop_gateway_readiness_observability.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260829164723_add_soop_gateway_incident_monitor.sql',import.meta.url),'utf8');
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
  const sql=await readFile(auditURL('../supabase/migrations/20260831063842_relax_offline_gateway_heartbeat_monitor.sql',import.meta.url),'utf8');
  assert.match(sql,/case when session\.state='connected' then 45 else 600 end/i);
  assert.match(sql,/make_interval\(secs=>threshold_seconds\)/i);
  assert.match(sql,/상태별 허용 시간을 초과했습니다/i);
  assert.match(sql,/revoke all on function private\.check_soop_gateway_heartbeats_v1\(\)[\s\S]+from public,anon,authenticated,service_role/i);
  assert.doesNotMatch(sql,/create policy/i);
});

test('live heartbeat coalescing allows two missed reports without changing the event hot path',async()=>{
  const sql=await readFile(auditURL('../supabase/migrations/20260901165151_coalesce_live_gateway_heartbeat_without_hot_path_changes.sql',import.meta.url),'utf8');
  assert.match(sql,/case when session\.state='connected' then 150 else 600 end/i);
  assert.match(sql,/make_interval\(secs=>threshold_seconds\)/i);
  assert.match(sql,/revoke all on function private\.check_soop_gateway_heartbeats_v1\(\)[\s\S]+from public,anon,authenticated,service_role/i);
  const runner=await readFile(auditURL('../services/soop-chat-gateway/index.mjs',import.meta.url),'utf8');
  assert.match(runner,/shouldSendSoopGatewayHeartbeat/);
  assert.match(runner,/X-Byeollog-Soop-Gateway-Signature/);
  assert.doesNotMatch(runner,/X-Byeollog-Soop-Gateway-Secret/);
  assert.match(runner,/enqueueGatewayEvent\(\{kind:'event'/);
  assert.match(runner,/void flushOutbox\(\)/);
  assert.doesNotMatch(runner,/await heartbeat\([^\n]+enqueueGatewayEvent/);
});

test('browser gateway follows the current SOOP Chat SDK lifecycle and resolves the real page context',async()=>{
  const source=await readFile(auditURL('../services/soop-chat-gateway/browser-session.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/chat\.init\s*\(/);
  assert.match(source,/new window\.SOOP\.ChatSDK\(config\.clientId,config\.clientSecret\)/);
  assert.match(source,/expression:'window',returnByValue:false/);
  assert.match(source,/objectId:shard\.pageObjectId/);
  assert.doesNotMatch(source,/executionContextId\s*:\s*1/);
  assert.match(source,/const roomIdentity=\(\)=>/);
  assert.match(source,/chat\.handleReady\(message=>emit\([\s\S]+room:roomIdentity\(\)/);
  assert.match(source,/kind:'event'[\s\S]+room:roomIdentity\(\)/);
  assert.match(source,/if\(payload&&'imageUrl' in message\)payload\.imageUrl=message\.imageUrl/);
  assert.doesNotMatch(source,/await chat\.connect\(\);[^\n]+chat\.getRoomInfo\(\)/);
  assert.match(source,/SOOP_SHARED_BROWSER_POLICY=Object\.freeze\(\{browserProcesses:1,storageIsolation:'browser_context',rendererProcessLimit:8,targetCreationConcurrency:8,sessionsPerShard:1,shardMaxAgeMs:300_000\}\)/);
  assert.match(source,/startByeollogGateway=async\(sessionId,config\)/);
  assert.match(source,/void Promise\.resolve\(\)\.then\(\(\)=>chat\.connect\(\)\)\.catch\(failConnect\)/);
  assert.doesNotMatch(source,/await chat\.connect\(\)/);
  assert.match(source,/lastErrorCode='sdk_connect_timeout'/);
  assert.match(source,/finish\('connect_timeout'\)/);
  assert.doesNotMatch(source,/room:null/);
  assert.match(source,/sdk_room_owner_mismatch/);
  assert.match(source,/retireShard=true/);
  assert.doesNotMatch(source,/retireShard=false/,'closed SDK pages must never be reused');
  assert.match(source,/candidate\.alive&&!candidate\.retiring/);
  assert.match(source,/shard\.stop\(sessionId,\{retire:retireShard\}\)/);
  assert.match(source,/const chats=new Map\(\)/);
  assert.match(source,/acquireShardSession/);
  assert.match(source,/async function createSharedBrowserHost\(\)/);
  assert.match(source,/const host=await browserHost\(\)/);
  assert.match(source,/host\.createTarget\(\)/);
  assert.match(source,/await host\.closeTarget\(target\.id\)/);
  assert.match(source,/Target\.createBrowserContext/);
  assert.match(source,/Target\.createTarget[\s\S]+browserContextId/);
  assert.match(source,/Target\.disposeBrowserContext/);
  assert.match(source,/openSoopSharedBrowserProbeTargets/);
  assert.match(source,/probeSoopBrowserStorageIsolation/);
  assert.match(source,/contextsDistinct:true/);
  assert.match(source,/--renderer-process-limit=/);
  assert.match(source,/--disable-renderer-backgrounding/);
  assert.match(source,/createTargetLimited/);
  assert.match(source,/session\.finish\('browser_closed'\)/);
  assert.equal((source.match(/spawn\(executable/g)||[]).length,1);
  const runner=await readFile(auditURL('../services/soop-chat-gateway/index.mjs',import.meta.url),'utf8');
  assert.match(runner,/lastErrorCode,chatNumber,\.\.\.extra/);
  assert.match(runner,/chatNumber=Number\(room\?\.chatNumber\)\|\|null/);
  assert.match(runner,/classifySoopChatSdkCallback/);
  assert.match(runner,/SoopRelevantChatGate/);
  assert.match(runner,/chatGate\.arm\(normalized\.relay\.event\.actor\)/);
  assert.match(runner,/!chatGate\.shouldForwardEvent\(normalized,\{broadcasterId:token\.providerAccountId\}\)/);
  assert.match(runner,/SOOP_GATEWAY_HEARTBEAT_POLICY\.checkMs/);
  assert.match(runner,/RECONCILE_MS=60_000/);
  assert.match(runner,/expiresAt-Date\.now\(\)>LEASE_REFRESH_SKEW_MS/);
  assert.match(runner,/deliverOutboxItem/);
  assert.match(runner,/body\?\.kind!==\'event\'\|\|!isSoopGatewayLeaseExpiredError\(error\)/);
  assert.match(runner,/lease=null;\s*activeLease=await currentLease\(true\)/);
  assert.match(runner,/lease\?\.leaseToken\|\|token\.leaseToken/);
  assert.match(runner,/sdk_event_ignored/);
  assert.match(runner,/eventType:normalized\.relay\.eventType,sequence:currentSequence/);
  assert.match(runner,/stableSoopGatewayStaggerMs/);
  assert.match(runner,/await closeSoopBrowserHost\(\)/);
});

test('Windows gateway supervisor and task keep the worker recoverable without user controls',async()=>{
  const runner=await readFile(auditURL('../tools/Run-SoopGatewayHidden.ps1',import.meta.url),'utf8');
  const supervisor=await readFile(auditURL('../services/soop-chat-gateway/supervisor.mjs',import.meta.url),'utf8');
  const installer=await readFile(auditURL('../tools/Install-SoopGatewayTask.ps1',import.meta.url),'utf8');
  const hiddenLauncher=await readFile(auditURL('../tools/Run-PowerShellHidden.vbs',import.meta.url),'utf8');
  const watchdog=await readFile(auditURL('../tools/Ensure-SoopGatewayRunning.ps1',import.meta.url),'utf8');
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
