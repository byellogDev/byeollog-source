import {safeEqual} from './auth.js';
import {isJsonRequest} from './request-origin.js';
import {normalizeSoopSdkRelayEnvelope} from './soop-sdk-relay.js';
import {verifySoopGatewayRequestSignature} from './soop-chat-gateway.js';
import {parseExternalRouletteResultMessage,isTrustedExternalRouletteAuthor} from './soop-external-roulette.js';
import {getSoopOAuthConfig,refreshSoopConnection,readSoopConnectionForObservation} from './soop-oauth.js';
import {sb} from './supabase-rest.js';
import {processPendingCollectorRows} from './collector-processor.js';
import {SOOP_DONATION_MAX_BALLOONS} from './native-roulette.js';
import {assertSoopGatewayOwnership,issueSoopGatewayLease,normalizeSoopBroadcasterId,verifySoopGatewayLease} from './soop-gateway-lease.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES=new Set(['idle','connecting','waiting_for_live','connected','retry_wait','reauthorization_required','stopped']);

function bodyOf(req){
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}
  return req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:null;
}
function text(value,max){const result=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();return result&&result.length<=max?result:''}
function iso(value){
  if(value===null||value===undefined||String(value).trim()==='')return null;
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toISOString():null;
}

function safeConstraintName(error){
  const detail=error?.detail&&typeof error.detail==='object'?error.detail:null;
  const direct=String(detail?.constraint??'');
  if(/^[a-z0-9_]{1,160}$/i.test(direct))return direct.toLowerCase();
  const candidates=[detail?.message,detail?.details,error?.message];
  for(const candidate of candidates){
    const value=String(candidate??'');
    const match=value.match(/(?:check constraint|constraint)\s+["']?([a-z0-9_]{1,160})["']?/i);
    const name=match?.[1]||null;
    if(name&&/^[a-z0-9_]{1,160}$/i.test(name))return name.toLowerCase();
  }
  return null;
}

function overLimitDonation(body){
  if(body?.relay?.eventType!=='donation')return false;
  const amount=Number(body?.relay?.event?.amount);
  return Number.isSafeInteger(amount)&&amount>SOOP_DONATION_MAX_BALLOONS;
}

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

async function lease(workspaceId,instanceId,control,{env,sbImpl,signal,observation=false,oauthConfig=getSoopOAuthConfig,refreshConnection=refreshSoopConnection}){
  if(!control?.core_collection_enabled)throw Object.assign(new Error('gateway lease disabled'),{status:409,code:'soop_gateway_lease_disabled'});
  const safeInstance=text(instanceId,160);
  if(!safeInstance)throw Object.assign(new Error('gateway instance is required'),{status:400,code:'invalid_gateway_instance'});
  const rows=await sbImpl('byeollog_workspaces',`?select=id,soop_id,status&id=eq.${encodeURIComponent(workspaceId)}&limit=1`);
  const workspace=Array.isArray(rows)?rows[0]||null:null;
  const providerAccountId=normalizeSoopBroadcasterId(workspace?.soop_id);
  if(workspace?.status!=='active'||!providerAccountId){
    throw Object.assign(new Error('workspace SOOP identity is unavailable'),{status:409,code:'soop_workspace_identity_missing'});
  }
  const config=oauthConfig(env),token=await (observation?readSoopConnectionForObservation:refreshConnection)(workspaceId,{env,sbImpl,signal});
  if(observation)return {
    ok:true,kind:'observe',workspaceId,providerAccountId,
    clientId:config.clientId,clientSecret:config.clientSecret,accessToken:token.accessToken,
    providerTokenExpiresAt:token.expiresAt,refreshed:false
  };
  const providerTokenExpiry=Date.parse(token.expiresAt||'');
  const leaseExpiresAt=Math.min(Number.isFinite(providerTokenExpiry)?providerTokenExpiry:Date.now()+10*60_000,Date.now()+10*60_000);
  if(leaseExpiresAt<=Date.now()+15_000)throw Object.assign(new Error('provider token expires too soon'),{status:409,code:'soop_gateway_lease_expired'});
  const leaseToken=issueSoopGatewayLease({workspaceId,broadcasterId:providerAccountId,instanceId:safeInstance,expiresAt:leaseExpiresAt},env);
  return {
    ok:true,kind:'lease',workspaceId,providerAccountId,leaseToken,
    clientId:config.clientId,clientSecret:config.clientSecret,accessToken:token.accessToken,
    // `expiresAt` is the signed collection lease deadline used by the gateway
    // refresh fence.  Keep the longer provider-token deadline separate so a
    // valid OAuth token cannot make the gateway reuse an expired lease.
    expiresAt:new Date(leaseExpiresAt).toISOString(),
    providerTokenExpiresAt:token.expiresAt,
    refreshed:token.refreshed===true
  };
}

function authorizedGatewayRequest(body,env,{requireRoom=false}={}){
  const claims=verifySoopGatewayLease(body?.leaseToken,env);
  return assertSoopGatewayOwnership({body,claims,requireRoom});
}

async function heartbeat(body,control,sbImpl,env,authorized=null){
  const ownership=authorized||authorizedGatewayRequest(body,env,{requireRoom:body?.state==='connected'});
  const {workspaceId,instanceId,room}=ownership;
  const state=text(body.state,40);
  if(!UUID.test(workspaceId)||!instanceId||!STATES.has(state))throw Object.assign(new Error('invalid heartbeat'),{status:400,code:'invalid_gateway_heartbeat'});
  const heartbeatAt=iso(body.heartbeatAt)||new Date().toISOString();
  const row={
    workspace_id:workspaceId,instance_id:instanceId,state,
    generation:Math.max(0,Math.trunc(Number(body.generation)||0)),
    reconnect_count:Math.max(0,Math.trunc(Number(body.reconnectCount)||0)),
    last_sequence:Math.max(0,Math.trunc(Number(body.lastSequence)||0)),
    chat_number:room?.chatNumber||null,bj_id:room?.broadcasterId||null,
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
  const room=body?.room&&typeof body.room==='object'?{
    providerBjId:normalizeSoopBroadcasterId(body.room.bjId)||null,
    chatNumber:Number.isSafeInteger(Number(body.room.chatNumber))?Number(body.room.chatNumber):null
  }:null;
  await sbImpl('byeollog_soop_event_observations','?on_conflict=workspace_id,event_fingerprint',{
    method:'POST',body:{
      workspace_id:workspaceId,event_fingerprint:relay.eventFingerprint,event_type:relay.eventType,
      provider_occurred_at:relay.event.occurredAt,gateway_received_at:relay.receivedAt,server_received_at:now,
      normalized_at:now,roulette_committed_at:outcome==='committed'?now:null,
      overlay_queued_at:outcome==='committed'&&relay.eventType==='donation'?now:null,
      tts_queued_at:details?.ttsQueued===true?now:null,action_queued_at:null,deduplicated:details?.duplicate===true,outcome,
      details:{occurredAtSource:body.metadata?.occurredAtSource==='provider'?'provider':'gateway_receive',reconnectCount:relay.connection.reconnectCount,sequence:relay.connection.sequence,...(room?{room}:{}),...(ceremonyImage?{ceremonyImage}:{}),...details}
    },prefer:'resolution=merge-duplicates,return=minimal'
  });
}

export async function ingestNormalizedSoopDonation(workspaceId,relay,{testMode=false,sbImpl=sb,environment=process.env}={}){
  const normalizedWorkspace=text(workspaceId,36).toLowerCase();
  if(!UUID.test(normalizedWorkspace)||relay?.eventType!=='donation'||relay?.event?.donationTypeLabel==='애드벌룬'){
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
  const ownership=authorizedGatewayRequest(body,env,{requireRoom:true});
  const {workspaceId,instanceId,room}=ownership;
  // Signed provider packets outside the durable database contract are
  // permanently unusable. ACK them as ignored so the encrypted outbox does
  // not retry the same packet three times and delay valid donations behind it.
  if(overLimitDonation(body)){
    console.warn('[soop-gateway] event ignored',{
      code:'donation_amount_out_of_contract',kind:'event',eventType:'donation',
      action:text(body?.metadata?.action,40)||null
    });
    return {ok:true,kind:'event',duplicate:false,activated:false,reason:'invalid_donation_amount'};
  }
  const relay=normalizeSoopSdkRelayEnvelope(body.relay||{});
  if(!relay.connection.id.startsWith(`${instanceId}:${workspaceId}:`)){
    throw Object.assign(new Error('SOOP event connection is outside the leased workspace'),{status:409,code:'soop_gateway_lease_scope_mismatch'});
  }
  if(!control.core_collection_enabled||String(env.SOOP_CORE_COLLECTION_ENABLED||'true').toLowerCase()==='false'){
    await recordObservation(workspaceId,relay,body,'ignored',{duplicate:false,reason:'core_collection_disabled'},sbImpl);
    return {ok:true,kind:'event',duplicate:false,activated:false,reason:'core_collection_disabled'};
  }
  const claimOwnership=async()=>{
    const claim=await sbImpl('rpc/claim_soop_event_ownership_v1','',{method:'POST',body:{
      p_workspace_id:workspaceId,p_event_fingerprint:relay.eventFingerprint,
      p_provider_bj_id:room.broadcasterId,p_chat_number:room.chatNumber
    }});
    const status=String(Array.isArray(claim)?claim[0]?.status??claim[0]??'':claim?.status??claim??'');
    if(!['claimed','owned'].includes(status)){
      throw Object.assign(new Error('SOOP event already belongs to another workspace'),{status:409,code:'soop_event_workspace_conflict'});
    }
  };
  let result,resultRow;
  if(relay.eventType==='donation'){
    await claimOwnership();
    const event=relay.event;
    const donationRpc=event.donationTypeLabel==='애드벌룬'
      ?'ingest_soop_wallpaper_adballoon_v1':'ingest_soop_core_donation_v2';
    result=await sbImpl(`rpc/${donationRpc}`,'',{method:'POST',body:{
      p_workspace_id:workspaceId,p_event_id:event.eventId,p_actor_id:event.actor.id,
      p_actor_name:event.actor.name,p_amount:event.amount,p_donation_type_label:event.donationTypeLabel,
      p_ceremony_image_url:event.ceremonyImageUrl,p_occurred_at:event.occurredAt,
      p_broadcast_key:relay.connection.id,
      p_provider_bj_id:room.broadcasterId,p_source_chat_number:room.chatNumber,
      p_event_fingerprint:relay.eventFingerprint,
      p_release_key:text(env.VERCEL_DEPLOYMENT_ID||env.VERCEL_GIT_COMMIT_SHA||env.npm_package_version||'local-development',160)||'local-development'
    }});
    resultRow=Array.isArray(result)?result[0]||{}:result||{};
    if(text(resultRow.sourceUid,220)){
      await processUpboWithDiagnostics(processCollector,resultRow.sourceUid,workspaceId,'fixed');
    }
  }else{
    const parsed=parseExternalRouletteResultMessage(relay.event.message);
    if(!parsed){
      await recordObservation(workspaceId,relay,body,'ignored',{duplicate:false,reason:'not_external_roulette_result'},sbImpl);
      return {ok:true,kind:'event',duplicate:false,activated:false,reason:'not_external_roulette_result'};
    }
    if(!isTrustedExternalRouletteAuthor(relay.event.actor.id,room.broadcasterId)){
      return {ok:true,kind:'event',duplicate:false,activated:false,reason:'untrusted_roulette_author'};
    }
    const rpcBody={
      p_workspace_id:workspaceId,p_chat_event_id:relay.event.eventId,
      p_chat_actor_id:relay.event.actor.id,p_chat_actor_name:relay.event.actor.name,
      p_donor_name_hint:parsed.donorName,p_roulette_name:parsed.rouletteName,
      p_result_text:parsed.resultText,p_raw_message:parsed.message,p_occurred_at:relay.event.occurredAt,
      p_broadcast_key:relay.connection.id,p_provider_bj_id:room.broadcasterId,
      p_source_chat_number:room.chatNumber,p_event_fingerprint:relay.eventFingerprint
    };
    // The DB checks activation and pre-disable pending work before claiming
    // or persisting the chat. One transaction also protects the last spin.
    result=await sbImpl('rpc/ingest_soop_external_roulette_result_v4','',{method:'POST',body:rpcBody});
    resultRow=Array.isArray(result)?result[0]||{}:result||{};
    if(resultRow.status==='roulette_collection_disabled'){
      return {ok:true,kind:'event',duplicate:false,activated:false,reason:'roulette_collection_disabled'};
    }
    if(resultRow.matched===true&&text(resultRow.sourceUid,220)){
      await processUpboWithDiagnostics(processCollector,resultRow.sourceUid,workspaceId,'roulette');
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

async function processUpboWithDiagnostics(processCollector,sourceUid,workspaceId,kind){
  // Keep the existing delivery ACK contract until durable retry/partial-write
  // idempotency is verified. Retrying the entire event here could stall new
  // donations or duplicate partially-written rewards. Do not claim a retry
  // was scheduled when no worker owns it, and never log viewer/token payloads.
  try{
    const result=await processCollector({sourceUids:[sourceUid],workspaceId});
    if(result?.ok===false)console.error('[soop-gateway] upbo processing failed',{
      code:'upbo_processing_failed',kind,retryScheduled:false
    });
  }catch{
    console.error('[soop-gateway] upbo processing failed',{
      code:'upbo_processing_exception',kind,retryScheduled:false
    });
  }
}

export async function handleSoopGatewayIngress(req,res,{env=process.env,sbImpl=sb,oauthConfig,refreshConnection,processCollector=processPendingCollectorRows,signal=AbortSignal.timeout(25000)}={}){
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
  // One budget spans control reads, writes, OAuth and Upbo processing. Do not
  // reset it for each query: that would allow a slow database to retain workers.
  const rest=sbImpl,processor=processCollector;
  sbImpl=(table,path='',options={})=>{signal.throwIfAborted();return rest(table,path,{...options,signal:options.signal?AbortSignal.any([signal,options.signal]):signal})};
  processCollector=options=>processor({...options,signal});
  if(body.kind==='reconcile'){
    try{return res.status(200).json(await reconcile(sbImpl))}
    catch(error){return res.status(503).json({message:'SOOP 게이트웨이 작업 목록을 불러오지 못했습니다.',code:error?.code||'soop_gateway_reconcile_failed'})}
  }
  try{
    const isLease=body.kind==='lease'||body.kind==='observe';
    const ownership=isLease?null:authorizedGatewayRequest(body,env,{requireRoom:body.kind==='event'||body?.state==='connected'});
    const workspaceId=isLease?text(body.workspaceId,36).toLowerCase():ownership.workspaceId;
    if(!UUID.test(workspaceId))return res.status(400).json({message:'workspaceId is invalid'});
    const control=await controlFor(workspaceId,sbImpl);
    if(!control?.gateway_enabled)return res.status(409).json({message:'SOOP 게이트웨이가 아직 활성화되지 않았습니다.',code:'soop_gateway_disabled'});
    const result=isLease?await lease(workspaceId,body.instanceId,control,{env,sbImpl,signal,observation:body.kind==='observe',oauthConfig,refreshConnection}):body.kind==='heartbeat'?await heartbeat(body,control,sbImpl,env,ownership):body.kind==='event'?await event(body,control,sbImpl,env,processCollector):null;
    if(!result)return res.status(400).json({message:'Gateway request kind is invalid'});
    return res.status(200).json(result);
  }catch(error){
    if(signal.aborted){res.setHeader('Retry-After','5');return res.status(503).json({message:'서버 응답이 지연되어 다시 전송합니다.',code:'soop_gateway_deadline_exceeded'})}
    console.error('[soop-gateway] ingress failed',{
      code:error?.code||'soop_gateway_ingress_failed',status:error?.status||null,
      kind:text(body?.kind,20)||null,eventType:text(body?.relay?.eventType,20)||null,
      action:text(body?.metadata?.action,40)||null,constraint:safeConstraintName(error)
    });
    return res.status(error?.status||503).json({message:'SOOP 게이트웨이 요청을 처리하지 못했습니다.',code:error?.code||'soop_gateway_ingress_failed'});
  }
}
