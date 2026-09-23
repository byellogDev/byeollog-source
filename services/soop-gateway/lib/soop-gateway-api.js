import {safeEqual} from './auth.js';
import {isJsonRequest} from './request-origin.js';
import {normalizeSoopSdkRelayEnvelope} from './soop-sdk-relay.js';
import {verifySoopGatewayRequestSignature} from './soop-chat-gateway.js';
import {parseExternalRouletteResultMessage} from './soop-external-roulette.js';
import {getSoopOAuthConfig,refreshSoopConnection} from './soop-oauth.js';
import {sb} from './supabase-rest.js';
import {processPendingCollectorRows} from './collector-processor.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES=new Set(['idle','connecting','waiting_for_live','connected','retry_wait','reauthorization_required','stopped']);

function bodyOf(req){
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}
  return req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:null;
}
function text(value,max){const result=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();return result&&result.length<=max?result:''}
function iso(value){const date=new Date(value);return Number.isFinite(date.getTime())?date.toISOString():null}

export function getSoopGatewayIngressReadiness(env=process.env){
  return {
    enabled:String(env.SOOP_GATEWAY_INGRESS_ENABLED||'')==='true',
    configured:String(env.SOOP_GATEWAY_INGRESS_SECRET||'').trim().length>=32
  };
}

async function controlFor(workspaceId,sbImpl){
  const rows=await sbImpl('byeollog_soop_runtime_controls',`?select=gateway_enabled,core_collection_enabled,native_roulette_enabled,live_diagnostics_enabled&workspace_id=eq.${encodeURIComponent(workspaceId)}&limit=1`);
  return Array.isArray(rows)?rows[0]||null:null;
}

async function reconcile(sbImpl){
  const rows=await sbImpl('byeollog_soop_runtime_controls','?select=workspace_id,gateway_enabled,core_collection_enabled&gateway_enabled=eq.true&core_collection_enabled=eq.true&order=workspace_id');
  const workspaceIds=(Array.isArray(rows)?rows:[]).map(control=>control.workspace_id);
  return {ok:true,kind:'reconcile',workspaceIds};
}

async function lease(workspaceId,control,{env,sbImpl,oauthConfig=getSoopOAuthConfig,refreshConnection=refreshSoopConnection}){
  if(!control?.core_collection_enabled)throw Object.assign(new Error('gateway lease disabled'),{status:409,code:'soop_gateway_lease_disabled'});
  const config=oauthConfig(env),token=await refreshConnection(workspaceId,{env,sbImpl});
  return {ok:true,kind:'lease',workspaceId,clientId:config.clientId,clientSecret:config.clientSecret,accessToken:token.accessToken,expiresAt:token.expiresAt,refreshed:token.refreshed===true};
}

async function heartbeat(body,control,sbImpl){
  const workspaceId=text(body.workspaceId,36).toLowerCase();
  const instanceId=text(body.instanceId,160);
  const state=text(body.state,40);
  if(!UUID.test(workspaceId)||!instanceId||!STATES.has(state))throw Object.assign(new Error('invalid heartbeat'),{status:400,code:'invalid_gateway_heartbeat'});
  const heartbeatAt=iso(body.heartbeatAt)||new Date().toISOString();
  const row={
    workspace_id:workspaceId,instance_id:instanceId,state,
    generation:Math.max(0,Math.trunc(Number(body.generation)||0)),
    reconnect_count:Math.max(0,Math.trunc(Number(body.reconnectCount)||0)),
    last_sequence:Math.max(0,Math.trunc(Number(body.lastSequence)||0)),
    chat_number:Number.isSafeInteger(Number(body.chatNumber))&&Number(body.chatNumber)>0?Number(body.chatNumber):null,
    token_expires_at:iso(body.tokenExpiresAt),connected_at:iso(body.connectedAt),
    last_event_at:iso(body.lastEventAt),
    heartbeat_at:heartbeatAt,last_error_code:text(body.lastErrorCode,120)||null,updated_at:heartbeatAt
  };
  await sbImpl('byeollog_soop_gateway_sessions','?on_conflict=workspace_id',{method:'POST',body:row,prefer:'resolution=merge-duplicates,return=minimal'});
  return {ok:true,kind:'heartbeat',state};
}

function safeCeremonyImageDiagnostic(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const scheme=text(value.scheme,16).toLowerCase();
  const hostname=text(value.hostname,253).toLowerCase();
  return {
    fieldPresent:value.fieldPresent===true,valuePresent:value.valuePresent===true,
    accepted:value.accepted===true,scheme:['missing','invalid','relative','http','https'].includes(scheme)?scheme:'unknown',
    hostname:/^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(hostname)?hostname:null
  };
}

async function recordObservation(workspaceId,relay,body,outcome,details,sbImpl){
  const now=new Date().toISOString();
  const ceremonyImage=safeCeremonyImageDiagnostic(body.metadata?.ceremonyImage);
  await sbImpl('byeollog_soop_event_observations','?on_conflict=workspace_id,event_fingerprint',{
    method:'POST',body:{
      workspace_id:workspaceId,event_fingerprint:relay.eventFingerprint,event_type:relay.eventType,
      provider_occurred_at:relay.event.occurredAt,gateway_received_at:relay.receivedAt,server_received_at:now,
      normalized_at:now,roulette_committed_at:outcome==='committed'?now:null,
      overlay_queued_at:outcome==='committed'&&relay.eventType==='donation'?now:null,
      tts_queued_at:details?.ttsQueued===true?now:null,action_queued_at:null,deduplicated:details?.duplicate===true,outcome,
      details:{occurredAtSource:body.metadata?.occurredAtSource==='provider'?'provider':'gateway_receive',reconnectCount:relay.connection.reconnectCount,sequence:relay.connection.sequence,...(ceremonyImage?{ceremonyImage}:{}),...details}
    },prefer:'resolution=merge-duplicates,return=minimal'
  });
}

export async function ingestNormalizedSoopDonation(workspaceId,relay,{testMode=false,sbImpl=sb,environment=process.env}={}){
  const normalizedWorkspace=text(workspaceId,36).toLowerCase();
  if(!UUID.test(normalizedWorkspace)||relay?.eventType!=='donation'){
    throw Object.assign(new Error('invalid normalized donation'),{status:400,code:'invalid_normalized_donation'});
  }
  const rpc=testMode?'enqueue_native_overlay_donation_test_v3':'ingest_native_overlay_soop_donation_v8';
  const event=relay.event;
  const body={
    p_workspace_id:normalizedWorkspace,p_event_id:event.eventId,p_actor_id:event.actor.id,
    p_actor_name:event.actor.name,p_amount:event.amount,p_message:event.message,
    p_occurred_at:event.occurredAt
  };
  if(!testMode){
    body.p_ceremony_image_url=event.ceremonyImageUrl;
    body.p_donation_type_label=event.donationTypeLabel;
    body.p_broadcast_key=relay.connection.id;
    body.p_release_key=text(environment.VERCEL_DEPLOYMENT_ID||environment.VERCEL_GIT_COMMIT_SHA||environment.npm_package_version||'local-development',160)||'local-development';
  }
  const result=await sbImpl(`rpc/${rpc}`,'',{method:'POST',body});
  const resultRow=Array.isArray(result)?result[0]||{}:result||{};
  const expectedIsolation=testMode?'manual_overlay_test':'pre_approval';
  if(resultRow.dataIsolation!==expectedIsolation||Number(resultRow.upboWrites)!==0){
    throw Object.assign(new Error('native roulette isolation contract mismatch'),{
      status:503,code:'native_roulette_isolation_mismatch'
    });
  }
  return {result,resultRow};
}

async function event(body,control,sbImpl,env,processCollector){
  const workspaceId=text(body.workspaceId,36).toLowerCase();
  if(!UUID.test(workspaceId))throw Object.assign(new Error('invalid workspace'),{status:400,code:'invalid_gateway_workspace'});
  const relay=normalizeSoopSdkRelayEnvelope(body.relay||{});
  if(!control.core_collection_enabled||String(env.SOOP_CORE_COLLECTION_ENABLED||'true').toLowerCase()==='false'){
    await recordObservation(workspaceId,relay,body,'ignored',{duplicate:false,reason:'core_collection_disabled'},sbImpl);
    return {ok:true,kind:'event',duplicate:false,activated:false,reason:'core_collection_disabled'};
  }
  let result,resultRow;
  if(relay.eventType==='donation'){
    const event=relay.event;
    result=await sbImpl('rpc/ingest_soop_core_donation_v1','',{method:'POST',body:{
      p_workspace_id:workspaceId,p_event_id:event.eventId,p_actor_id:event.actor.id,
      p_actor_name:event.actor.name,p_amount:event.amount,p_donation_type_label:event.donationTypeLabel,
      p_ceremony_image_url:event.ceremonyImageUrl,p_occurred_at:event.occurredAt,
      p_broadcast_key:relay.connection.id,
      p_release_key:text(env.VERCEL_DEPLOYMENT_ID||env.VERCEL_GIT_COMMIT_SHA||env.npm_package_version||'local-development',160)||'local-development'
    }});
    resultRow=Array.isArray(result)?result[0]||{}:result||{};
  }else{
    const parsed=parseExternalRouletteResultMessage(relay.event.message);
    if(!parsed){
      await recordObservation(workspaceId,relay,body,'ignored',{duplicate:false,reason:'not_external_roulette_result'},sbImpl);
      return {ok:true,kind:'event',duplicate:false,activated:false,reason:'not_external_roulette_result'};
    }
    const rpcBody={
      p_workspace_id:workspaceId,p_chat_event_id:relay.event.eventId,
      p_chat_actor_id:relay.event.actor.id,p_chat_actor_name:relay.event.actor.name,
      p_donor_name_hint:parsed.donorName,p_roulette_name:parsed.rouletteName,
      p_result_text:parsed.resultText,p_raw_message:parsed.message,p_occurred_at:relay.event.occurredAt,
      p_broadcast_key:relay.connection.id
    };
    result=await sbImpl('rpc/ingest_soop_external_roulette_result_v1','',{method:'POST',body:rpcBody});
    resultRow=Array.isArray(result)?result[0]||{}:result||{};
    if(resultRow.matched===true&&text(resultRow.sourceUid,220)){
      try{await processCollector({sourceUids:[resultRow.sourceUid],workspaceId})}
      catch(error){console.error('[soop-gateway] upbo processing deferred',{code:error?.code||'upbo_processing_deferred'})}
    }
  }
  await recordObservation(workspaceId,relay,body,'committed',{
    duplicate:resultRow.duplicate===true,status:resultRow.status||null,
    ttsQueued:false,
    messageMatchKind:text(resultRow.matchMethod,40)||null,
    coreCollection:true
  },sbImpl);
  const activated=relay.eventType==='chat'?resultRow.matched===true:resultRow.status==='recorded'||resultRow.status==='duplicate';
  return {ok:true,kind:'event',duplicate:resultRow.duplicate===true,activated,
    reason:activated?null:(relay.eventType==='chat'?resultRow.status||'no_pending_donation':'donation_not_recorded'),result};
}

export async function handleSoopGatewayIngress(req,res,{env=process.env,sbImpl=sb,oauthConfig,refreshConnection,processCollector=processPendingCollectorRows}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const readiness=getSoopGatewayIngressReadiness(env);
  if(!readiness.enabled||!readiness.configured)return res.status(404).json({message:'Not found'});
  const expected=String(env.SOOP_GATEWAY_INGRESS_SECRET||'').trim();
  const supplied=String(req.headers?.['x-byeollog-soop-gateway-secret']||'').trim();
  const body=bodyOf(req);
  if(!body||JSON.stringify(body).length>64*1024)return res.status(400).json({message:'Invalid request'});
  const signed=verifySoopGatewayRequestSignature({
    secret:expected,
    timestamp:req.headers?.['x-byeollog-soop-gateway-timestamp'],
    nonce:req.headers?.['x-byeollog-soop-gateway-nonce'],
    signature:req.headers?.['x-byeollog-soop-gateway-signature'],
    body
  });
  const legacyAllowed=String(env.SOOP_GATEWAY_ALLOW_LEGACY_BEARER||'').trim().toLowerCase()==='true';
  const legacyAccepted=legacyAllowed&&supplied.length>=32&&safeEqual(expected,supplied);
  if(!signed&&!legacyAccepted)return res.status(401).json({message:'Unauthorized'});
  if(body.kind==='reconcile'){
    try{return res.status(200).json(await reconcile(sbImpl))}
    catch(error){return res.status(503).json({message:'SOOP 게이트웨이 작업 목록을 불러오지 못했습니다.',code:error?.code||'soop_gateway_reconcile_failed'})}
  }
  const workspaceId=text(body.workspaceId,36).toLowerCase();
  if(!UUID.test(workspaceId))return res.status(400).json({message:'workspaceId is invalid'});
  try{
    const control=await controlFor(workspaceId,sbImpl);
    if(!control?.gateway_enabled)return res.status(409).json({message:'SOOP 게이트웨이가 아직 활성화되지 않았습니다.',code:'soop_gateway_disabled'});
    const result=body.kind==='lease'?await lease(workspaceId,control,{env,sbImpl,oauthConfig,refreshConnection}):body.kind==='heartbeat'?await heartbeat(body,control,sbImpl):body.kind==='event'?await event(body,control,sbImpl,env,processCollector):null;
    if(!result)return res.status(400).json({message:'Gateway request kind is invalid'});
    return res.status(200).json(result);
  }catch(error){
    console.error('[soop-gateway] ingress failed',{code:error?.code||'soop_gateway_ingress_failed',status:error?.status||null});
    return res.status(error?.status||503).json({message:'SOOP 게이트웨이 요청을 처리하지 못했습니다.',code:error?.code||'soop_gateway_ingress_failed'});
  }
}
