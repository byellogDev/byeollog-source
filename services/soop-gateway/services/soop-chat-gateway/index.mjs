import crypto from 'node:crypto';
import os from 'node:os';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {classifySoopChatSdkCallback,isSoopBroadcastOfflineError,isSoopGatewayLeaseExpiredError,shouldSendSoopGatewayHeartbeat,signSoopGatewayRequest,SOOP_GATEWAY_HEARTBEAT_POLICY,stableSoopGatewayStaggerMs,SoopGatewayReplayGuard,SoopRelevantChatGate} from '../../lib/soop-chat-gateway.js';
import {reduceSoopSdkSession} from '../../lib/soop-sdk-relay.js';
import {closeSoopBrowserHost,runSoopBrowserSession,soopBrowserRuntimePolicy} from './browser-session.mjs';
import {EncryptedGatewayOutbox} from './outbox.mjs';
import {WorkspaceEventSequencer} from './workspace-event-sequencer.mjs';
import {enqueueDurably} from './durable-enqueue.mjs';
import {singleFlight,sleep} from './single-flight.mjs';

const RECONCILE_MS=60_000,OUTBOX_FLUSH_MS=1_000;
const LEASE_REFRESH_SKEW_MS=60_000,DONOR_CHAT_WINDOW_MS=120_000;
const instanceId=`${os.hostname().replace(/[^A-Za-z0-9_-]/g,'_').slice(0,48)}:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
const gatewayUrl=String(process.env.BYEOLLOG_SOOP_GATEWAY_URL||'https://byeollog.com/api/auth/soop/gateway').trim();
const gatewaySecret=String(process.env.SOOP_GATEWAY_INGRESS_SECRET||'').trim();
const stateDirectory=String(process.env.SOOP_GATEWAY_STATE_DIR||'').trim();
const workerStatePath=stateDirectory?`${stateDirectory}/worker-state.json`:null;
const channelDiagnostics=new Map();let lastDeliveryAt=null,lastFlushFinishedAt=null;
const workers=new Map(),reportedUnsupportedActions=new Set();let stopping=false,outbox=null,outboxTimer=null,workerStateTimer=null,lastOutboxPressureLogAt=0;

function log(level,event,data={}){process.stdout.write(`${JSON.stringify({at:new Date().toISOString(),level,event,instanceId,...data})}\n`)}
function workspaceTag(workspaceId){return crypto.createHash('sha256').update(String(workspaceId)).digest('hex').slice(0,12)}
function errorCode(value,fallback='sdk_error'){const normalized=String(value||fallback).trim().toLowerCase().replace(/[^a-z0-9_.:-]/g,'_');return (normalized||fallback).slice(0,120)}
function safeErrorMessage(value){return String(value||'').replace(/(?:access|refresh)[_-]?token[^\s]*/gi,'[token-redacted]').replace(/[A-Za-z0-9_-]{80,}/g,'[value-redacted]').slice(0,400)}

async function persistWorkerState(status='running'){
  if(!workerStatePath)return;
  await mkdir(stateDirectory,{recursive:true});
  const temporary=`${workerStatePath}.${process.pid}.tmp`;
  const queue=outbox?await outbox.diagnostics():null;
  const channels=[...channelDiagnostics.values()].map(read=>read());
  await writeFile(temporary,JSON.stringify({schemaVersion:1,status,pid:process.pid,instanceId,heartbeatAt:new Date().toISOString(),lastDeliveryAt,lastFlushFinishedAt,queue,channels}),{encoding:'utf8',mode:0o600});
  await rename(temporary,workerStatePath);
}

function assertConfiguration(){
  if(!/^https:\/\//.test(gatewayUrl))throw new Error('BYEOLLOG_SOOP_GATEWAY_URL must use HTTPS');
  if(gatewaySecret.length<32)throw new Error('SOOP_GATEWAY_INGRESS_SECRET is missing');
}

async function postGateway(body){
  // Ingress has a 25-second total budget. Leave time for its explicit response
  // before retaining the event in the durable outbox for another attempt.
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
  try{
    const timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
    const signature=signSoopGatewayRequest({secret:gatewaySecret,timestamp,nonce,body});
    const response=await fetch(gatewayUrl,{method:'POST',headers:{
      'Content-Type':'application/json',
      'X-Byeollog-Soop-Gateway-Timestamp':timestamp,
      'X-Byeollog-Soop-Gateway-Nonce':nonce,
      'X-Byeollog-Soop-Gateway-Signature':signature
    },body:JSON.stringify(body),cache:'no-store',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(data.code||`gateway_http_${response.status}`);error.status=response.status;error.code=data.code||'gateway_request_failed';throw error}
    return data;
  }finally{clearTimeout(timer)}
}

function classifyGatewayDeliveryFailure(error){
  const status=Number(error?.status)||0;
  const code=String(error?.code||'');
  // Identity/scope failures cannot become valid by retrying the same packet.
  // Move them to the encrypted dead-letter area after the bounded confirmation
  // attempts instead of allowing one poisoned packet to block a workspace.
  if(/^(?:soop_gateway_lease_(?:invalid|missing|scope_mismatch)|soop_room_(?:identity_missing|owner_mismatch)|soop_event_workspace_conflict)$/.test(code))return {retryable:false};
  // Authentication, throttling, conflicts and server/network faults are
  // deployment or transient failures. Preserve their events for recovery.
  if(status===0||status===401||status===403||status===408||status===409||status===425||status===429||status>=500)return {retryable:true};
  // These statuses describe an event that the current API can never accept.
  if([400,404,405,413,415,422].includes(status))return {retryable:false};
  return {retryable:true};
}

function logOutboxPressure(status,force=false){
  const pending=Number(status?.pending)||0,deadLetters=Number(status?.deadLetters)||0;
  const now=Date.now(),threshold=pending>=5_000?'critical':pending>=1_000?'high':pending>=100?'elevated':null;
  if(!threshold&&deadLetters===0)return;
  if(!force&&now-lastOutboxPressureLogAt<60_000)return;
  lastOutboxPressureLogAt=now;
  log(threshold==='critical'?'error':'warn','outbox_pressure',{pending,deadLetters,threshold:threshold||'dead_letter_present'});
}

async function enabledWorkspaceIds(){
  const result=await postGateway({kind:'reconcile'});
  return new Set((Array.isArray(result?.workspaceIds)?result.workspaceIds:[]).map(value=>String(value)).filter(Boolean));
}

async function deliverOutboxItem(body){
  try{return await postGateway(body)}catch(error){
    if(body?.kind!=='event'||!isSoopGatewayLeaseExpiredError(error))throw error;
    // A durable event can outlive its short authorization lease. Renew only
    // that envelope while preserving its workspace, room and event payload.
    const renewed=await postGateway({kind:'lease',workspaceId:body.workspaceId,instanceId:body.instanceId});
    return postGateway({...body,leaseToken:renewed.leaseToken});
  }
}

async function flushOutbox(){
  if(!outbox)return {delivered:0,pending:0};
  const result=await outbox.flush(deliverOutboxItem,{
    concurrency:2,
    classifyFailure:classifyGatewayDeliveryFailure,
    onCorrupt:error=>log('error','outbox_item_quarantined',{code:errorCode(error?.code,'outbox_corrupt')}),
    onFailure:(error,item,state)=>log('warn','outbox_delivery_deferred',{item:item.id.slice(0,12),code:errorCode(error?.code,'event_delivery_failed'),status:Number(error?.status)||null,attempts:state.attempts,nextAttemptAt:state.nextAttemptAt}),
    onDeadLetter:(error,item,state)=>log('error','outbox_item_dead_lettered',{item:item.id.slice(0,12),code:errorCode(error?.code,'event_delivery_failed'),status:Number(error?.status)||null,attempts:state.attempts}),
    onDelivered:item=>{lastDeliveryAt=new Date().toISOString();log('info','outbox_item_delivered',{item:item.id.slice(0,12)})}
  });
  lastFlushFinishedAt=new Date().toISOString();
  logOutboxPressure(result);
  return result;
}

async function enqueueGatewayEvent(body){
  const queued=await enqueueDurably(outbox,body,{onBlocked:state=>log('error','event_storage_blocked',{
    workspace:workspaceTag(body.workspaceId),code:state.code,attempt:state.attempt
  })});
  const image=body.metadata?.ceremonyImage;
  log('info',queued.duplicate?'outbox_item_already_queued':'outbox_item_queued',{
    item:queued.id.slice(0,12),workspace:workspaceTag(body.workspaceId),
    ...(image?{imageFieldPresent:image.fieldPresent===true,imageValuePresent:image.valuePresent===true,
      imageAccepted:image.accepted===true,imageScheme:errorCode(image.scheme,'missing'),imageHost:image.hostname||null}:{})
  });
  void flushOutbox().catch(error=>log('warn','outbox_flush_failed',{code:errorCode(error?.code,'outbox_flush_failed')}));
}

async function runWorkspace(workspaceId,signal){
  const replay=new SoopGatewayReplayGuard(),chatGate=new SoopRelevantChatGate({windowMs:DONOR_CHAT_WINDOW_MS}),eventSequencer=new WorkspaceEventSequencer();let generation=0,sequence=0,lastEventAt=null,chatNumber=null,connectedAt=null,lastDisconnectedAt=null;
  const tag=workspaceTag(workspaceId);let lastErrorCode=null;
  channelDiagnostics.set(workspaceId,()=>({workspace:tag,state:state.status,lastEventAt,lastErrorCode,
    memoryPending:eventSequencer.pendingItems,memoryOldestAgeMs:eventSequencer.oldestAgeMs}));
  let state={status:'idle',reconnectCount:0,retryAttempt:0};
  const retrySleep=async(baseMs,scope)=>{
    const base=Math.max(250,Math.trunc(Number(baseMs)||1_000));
    const jitter=stableSoopGatewayStaggerMs(`${workspaceId}:${scope}:${generation}`,Math.min(5_000,Math.max(250,Math.ceil(base*0.2))));
    await sleep(base+jitter,signal);
  };
  let lease=null,room=null,lastHeartbeatAt=0,lastHeartbeatState=null,lastHeartbeatError=null;
  const currentLease=singleFlight(async(force=false)=>{
    const expiresAt=Date.parse(lease?.expiresAt||'');
    if(!force&&lease&&Number.isFinite(expiresAt)&&expiresAt-Date.now()>LEASE_REFRESH_SKEW_MS)return lease;
    lease=await postGateway({kind:'lease',workspaceId,instanceId});
    return lease;
  });
  const heartbeat=singleFlight(async(extra={},force=false)=>{
    if(!lease?.leaseToken)return {ok:true,skipped:true};
    const now=Date.now(),connected=state.status==='connected';
    // A 30-second local live probe temporarily enters "connecting".  When the
    // last durable state was already offline, keep reporting waiting_for_live
    // instead of turning every local probe into two cloud state transitions.
    const reportedState=state.status==='connecting'&&lastHeartbeatState==='waiting_for_live'
      ?'waiting_for_live':state.status;
    if(!force&&!shouldSendSoopGatewayHeartbeat({
      now,lastHeartbeatAt,reportedState,lastHeartbeatState,lastErrorCode,lastHeartbeatError
    }))return {ok:true,skipped:true};
    const roomIdentity=connected&&room?{chatNumber:Number(room.chatNumber)||0,bjId:String(room.bjId||'')}:null;
    let activeLease=await currentLease();
    const send=()=>postGateway({kind:'heartbeat',workspaceId,instanceId,leaseToken:activeLease.leaseToken,room:roomIdentity,state:reportedState,generation,reconnectCount:state.reconnectCount,lastSequence:sequence,connectedAt:connected?connectedAt:null,lastEventAt,heartbeatAt:new Date(now).toISOString(),lastErrorCode,chatNumber,...extra,tokenExpiresAt:activeLease.providerTokenExpiresAt||extra.tokenExpiresAt});
    let result;
    try{result=await send()}catch(error){
      if(!isSoopGatewayLeaseExpiredError(error))throw error;
      lease=null;
      activeLease=await currentLease(true);
      log('info','lease_rotated',{workspace:tag,reason:'expired'});
      result=await send();
    }
    lastHeartbeatAt=now;lastHeartbeatState=reportedState;lastHeartbeatError=lastErrorCode;
    return result;
  });
  const timer=setInterval(()=>void heartbeat().catch(error=>log('warn','heartbeat_failed',{workspace:tag,code:errorCode(error?.code,'heartbeat_failed')})),SOOP_GATEWAY_HEARTBEAT_POLICY.checkMs);
  try{
    await sleep(stableSoopGatewayStaggerMs(workspaceId,5_000),signal);
    while(!signal.aborted){
      const retryingOffline=state.status==='waiting_for_live';
      generation+=1;sequence=0;chatNumber=null;state=reduceSoopSdkSession(state,{type:'connect_requested'});
      if(!retryingOffline)await heartbeat().catch(error=>log('warn','heartbeat_failed',{workspace:tag,code:errorCode(error?.code,'heartbeat_failed')}));
      let token;
      try{token=await currentLease()}catch(error){
        lease=null;
        if(error?.code==='soop_connection_missing'||error?.upstreamStatus===401){state=reduceSoopSdkSession(state,{type:'authorization_failed'})}
        else state=reduceSoopSdkSession(state,{type:'temporary_error'});
        lastErrorCode=errorCode(error?.code,'token_refresh_failed');
        log('warn','lease_failed',{workspace:tag,code:lastErrorCode});
        await heartbeat().catch(()=>{});
        if(state.status==='reauthorization_required')break;
        await retrySleep(state.nextRetryMs||30_000,'lease');continue;
      }
      const connectionId=`${instanceId}:${workspaceId}:${generation}`;
      room=null;
      try{
        const result=await runSoopBrowserSession({clientId:token.clientId,clientSecret:token.clientSecret,accessToken:token.accessToken,expectedBroadcasterId:token.providerAccountId,signal,
          onState:event=>{
            if(event.state==='connected'){
              const readyAt=new Date(event.at||Date.now()).toISOString();
              const reconnectGap=Date.parse(readyAt)-Date.parse(lastDisconnectedAt||'');
              if(!connectedAt||(lastDisconnectedAt&&(!Number.isFinite(reconnectGap)||reconnectGap>20*60_000)))connectedAt=readyAt;
              state=reduceSoopSdkSession(state,{type:'connected'});room=event.room||room;chatNumber=Number(room?.chatNumber)||null;lastErrorCode=null;lastDisconnectedAt=null;
              log('info','sdk_connected',{workspace:tag,chatNumberAvailable:chatNumber!==null,ownerSuffixNormalized:event.ownerSuffixNormalized===true});
              void heartbeat({tokenExpiresAt:token.providerTokenExpiresAt||token.expiresAt}).catch(()=>{});
            }
            else if(event.state==='connecting'&&event.room)room=event.room;
            else if(event.state==='error'){
              const offline=isSoopBroadcastOfflineError(event);
              lastErrorCode=errorCode(offline?'broadcast_offline':event.code,'sdk_error');
              if(!offline)log('warn','sdk_error',{workspace:tag,code:lastErrorCode,message:String(event.message||'').slice(0,240),...(event.identityCheck?{identityCheck:event.identityCheck}:{})})
            }
          },
          onEvent:event=>{
            const currentSequence=sequence++;
            try{
              const eventRoom={chatNumber:Number(event.room?.chatNumber)||0,bjId:String(event.room?.bjId||'').trim()};
              if(!eventRoom.bjId||eventRoom.bjId.toLowerCase()!==String(token.providerAccountId||'').toLowerCase()||!Number.isSafeInteger(eventRoom.chatNumber)||eventRoom.chatNumber<=0){
                log('error','sdk_event_quarantined',{workspace:tag,sequence:currentSequence,code:'soop_room_owner_mismatch'});return;
              }
              const classified=classifySoopChatSdkCallback({action:event.action,message:event.message,receivedAt:event.at,connection:{id:connectionId,sequence:currentSequence,reconnectCount:state.reconnectCount}});
            if(classified.kind!=='event'){
              const action=errorCode(classified.action,'unknown');
              const unsupportedKey=`${tag}:${action}`;
              const shouldLog=classified.reason!=='unsupported_action'||!reportedUnsupportedActions.has(unsupportedKey);
              if(shouldLog){
                if(classified.reason==='unsupported_action'){
                  if(reportedUnsupportedActions.size>=256)reportedUnsupportedActions.clear();
                  reportedUnsupportedActions.add(unsupportedKey);
                }
                // Log only the SDK action and classification reason. Donor
                // identity and chat payload remain outside diagnostic logs.
                log('info','sdk_event_ignored',{workspace:tag,action,sequence:currentSequence,reason:errorCode(classified.reason,'invalid_content')});
              }
              return;
            }
            const normalized=classified.value;
            const duplicate=replay.check({signature:normalized.metadata.replaySignature,connectionId,explicitEventId:normalized.metadata.explicitEventId});
            if(duplicate)return;
            if(normalized.relay.eventType==='donation'){
              // Arm synchronously before any queued disk/network work so an
              // immediately following donor chat cannot race the donation.
              chatGate.arm(normalized.relay.event.actor);
            }else if(!chatGate.shouldForwardEvent(normalized,{broadcasterId:token.providerAccountId})){
              return;
            }
            lastEventAt=event.at;
              void eventSequencer.run(workspaceId,()=>enqueueGatewayEvent({kind:'event',workspaceId,instanceId,leaseToken:lease?.leaseToken||token.leaseToken,room:eventRoom,relay:normalized.relay,metadata:{
                action:normalized.metadata.action,
                occurredAtSource:normalized.metadata.occurredAtSource,
                ...(normalized.metadata.ceremonyImage?{ceremonyImage:normalized.metadata.ceremonyImage}:{})
              }})).catch(error=>log('error','event_queue_failed',{workspace:tag,action:normalized.metadata.action,eventType:normalized.relay.eventType,sequence:currentSequence,code:errorCode(error?.code,'event_queue_failed')}));
            }catch(error){
              log('error','sdk_event_processing_failed',{workspace:tag,action:errorCode(event?.action,'unknown'),sequence:currentSequence,code:errorCode(error?.code,'sdk_event_processing_failed')});
            }
          }});
        if(signal.aborted)break;
        if(state.status==='connected')lastDisconnectedAt=new Date().toISOString();
        const offline=!result.ready&&isSoopBroadcastOfflineError(result);
        if(!result.ready)lastErrorCode=errorCode(offline?'broadcast_offline':result.errorCode,'sdk_connect_failed');
        state=reduceSoopSdkSession(state,{type:result.ready?'connection_closed':offline?'broadcast_offline':'temporary_error'});
      }catch(error){
        if(state.status==='connected')lastDisconnectedAt=new Date().toISOString();
        const offline=isSoopBroadcastOfflineError(error);
        if(!offline&&/token|unauthor|forbidden|401|403/i.test(`${error?.code||''} ${error?.message||''}`))lease=null;
        lastErrorCode=errorCode(offline?'broadcast_offline':error?.code,'sdk_connect_failed');
        if(offline){
          if(!retryingOffline)log('info','broadcast_offline',{workspace:tag,code:lastErrorCode});
        }else log('warn','session_failed',{workspace:tag,code:lastErrorCode,message:safeErrorMessage(error?.message)});
        state=reduceSoopSdkSession(state,{type:offline?'broadcast_offline':'temporary_error'});
        await heartbeat({chatNumber:Number(room?.chatNumber)||null,tokenExpiresAt:token.providerTokenExpiresAt||token.expiresAt}).catch(()=>{});
        if(offline){await retrySleep(30_000,'offline');continue}
      }
      await heartbeat({tokenExpiresAt:token.providerTokenExpiresAt||token.expiresAt}).catch(()=>{});
      await retrySleep(state.nextRetryMs||1_000,'reconnect');
    }
  }finally{clearInterval(timer);await eventSequencer.drain();state=reduceSoopSdkSession(state,{type:'stopped'});await heartbeat().catch(()=>{});channelDiagnostics.delete(workspaceId);log('info','workspace_stopped',{workspace:tag})}
}

async function reconcile(){
  const enabled=await enabledWorkspaceIds();
  for(const [workspaceId,worker] of workers){if(!enabled.has(workspaceId)){worker.abort.abort();workers.delete(workspaceId)}}
  for(const workspaceId of enabled){if(workers.has(workspaceId))continue;const abort=new AbortController(),tag=workspaceTag(workspaceId);const promise=runWorkspace(workspaceId,abort.signal).catch(error=>log('error','workspace_crashed',{workspace:tag,code:errorCode(error?.code,'workspace_crashed')})).finally(()=>workers.delete(workspaceId));workers.set(workspaceId,{abort,promise});log('info','workspace_started',{workspace:tag})}
}

async function main(){
  assertConfiguration();
  outbox=new EncryptedGatewayOutbox({directory:stateDirectory?`${stateDirectory}/outbox`:`${process.cwd()}/.soop-gateway-outbox`,secret:gatewaySecret,reserveItems:10000});
  const initialization=await outbox.init();
  await persistWorkerState();
  workerStateTimer=setInterval(()=>void persistWorkerState().catch(error=>log('error','worker_state_write_failed',{code:errorCode(error?.code,'worker_state_write_failed')})),15_000);
  const outboxStatus=await outbox.status();log('info','gateway_started',{outboxPending:outboxStatus.pending,outboxDeadLetters:outboxStatus.deadLetters,outboxExpiredToDeadLetter:initialization.pendingExpired,outboxExpiredDeadLettersRemoved:initialization.deadRemoved,browserPolicy:soopBrowserRuntimePolicy()});
  logOutboxPressure(outboxStatus,true);
  await flushOutbox().catch(error=>log('warn','outbox_startup_flush_failed',{code:errorCode(error?.code,'outbox_startup_flush_failed')}));
  outboxTimer=setInterval(()=>void flushOutbox().catch(error=>log('warn','outbox_flush_failed',{code:errorCode(error?.code,'outbox_flush_failed')})),OUTBOX_FLUSH_MS);
  while(!stopping){try{await reconcile()}catch(error){log('error','reconcile_failed',{code:error?.code||'reconcile_failed'})}await sleep(RECONCILE_MS)}
  if(outboxTimer)clearInterval(outboxTimer);
  if(workerStateTimer)clearInterval(workerStateTimer);
  for(const worker of workers.values())worker.abort.abort();await Promise.allSettled([...workers.values()].map(worker=>worker.promise));await flushOutbox().catch(()=>{});await persistWorkerState('stopped').catch(()=>{});const finalOutbox=await outbox.status();log('info','gateway_stopped',{outboxPending:finalOutbox.pending,outboxDeadLetters:finalOutbox.deadLetters});
  await closeSoopBrowserHost();
}

for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>{stopping=true});
main().catch(error=>{log('fatal','gateway_failed',{code:error?.code||'gateway_failed'});process.exitCode=1});
