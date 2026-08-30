import crypto from 'node:crypto';
import os from 'node:os';
import {mkdir,rename,writeFile} from 'node:fs/promises';
import {classifySoopChatSdkCallback,SoopGatewayReplayGuard} from '../../lib/soop-chat-gateway.js';
import {reduceSoopSdkSession} from '../../lib/soop-sdk-relay.js';
import {runSoopBrowserSession} from './browser-session.mjs';
import {EncryptedGatewayOutbox} from './outbox.mjs';

const POLL_MS=15_000,HEARTBEAT_MS=15_000,OUTBOX_FLUSH_MS=1_000;
const instanceId=`${os.hostname().replace(/[^A-Za-z0-9_-]/g,'_').slice(0,48)}:${process.pid}:${crypto.randomBytes(6).toString('hex')}`;
const gatewayUrl=String(process.env.BYEOLLOG_SOOP_GATEWAY_URL||'https://byeollog.com/api/auth/soop/gateway').trim();
const gatewaySecret=String(process.env.SOOP_GATEWAY_INGRESS_SECRET||'').trim();
const stateDirectory=String(process.env.SOOP_GATEWAY_STATE_DIR||'').trim();
const workerStatePath=stateDirectory?`${stateDirectory}/worker-state.json`:null;
const workers=new Map(),reportedUnsupportedActions=new Set();let stopping=false,outbox=null,outboxTimer=null,workerStateTimer=null;

function log(level,event,data={}){process.stdout.write(`${JSON.stringify({at:new Date().toISOString(),level,event,instanceId,...data})}\n`)}
function workspaceTag(workspaceId){return crypto.createHash('sha256').update(String(workspaceId)).digest('hex').slice(0,12)}
function errorCode(value,fallback='sdk_error'){const normalized=String(value||fallback).trim().replace(/[^A-Za-z0-9_.:-]/g,'_');return (normalized||fallback).slice(0,120)}
function safeErrorMessage(value){return String(value||'').replace(/(?:access|refresh)[_-]?token[^\s]*/gi,'[token-redacted]').replace(/[A-Za-z0-9_-]{80,}/g,'[value-redacted]').slice(0,400)}
function sleep(ms,signal){return new Promise(resolve=>{const timer=setTimeout(resolve,ms);signal?.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})})}

async function persistWorkerState(status='running'){
  if(!workerStatePath)return;
  await mkdir(stateDirectory,{recursive:true});
  const temporary=`${workerStatePath}.${process.pid}.tmp`;
  await writeFile(temporary,JSON.stringify({schemaVersion:1,status,pid:process.pid,instanceId,heartbeatAt:new Date().toISOString()}),{encoding:'utf8',mode:0o600});
  await rename(temporary,workerStatePath);
}

function assertConfiguration(){
  if(!/^https:\/\//.test(gatewayUrl))throw new Error('BYEOLLOG_SOOP_GATEWAY_URL must use HTTPS');
  if(gatewaySecret.length<32)throw new Error('SOOP_GATEWAY_INGRESS_SECRET is missing');
}

async function postGateway(body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10_000);
  try{
    const response=await fetch(gatewayUrl,{method:'POST',headers:{'Content-Type':'application/json','X-Byeollog-Soop-Gateway-Secret':gatewaySecret},body:JSON.stringify(body),cache:'no-store',signal:controller.signal});
    const data=await response.json().catch(()=>({}));
    if(!response.ok){const error=new Error(data.code||`gateway_http_${response.status}`);error.status=response.status;error.code=data.code||'gateway_request_failed';throw error}
    return data;
  }finally{clearTimeout(timer)}
}

async function enabledWorkspaceIds(){
  const result=await postGateway({kind:'reconcile'});
  return new Set((Array.isArray(result?.workspaceIds)?result.workspaceIds:[]).map(value=>String(value)).filter(Boolean));
}

async function flushOutbox(){
  if(!outbox)return {delivered:0,pending:0};
  return await outbox.flush(postGateway,{
    onCorrupt:error=>log('error','outbox_item_quarantined',{code:errorCode(error?.code,'outbox_corrupt')}),
    onFailure:(error,item)=>log('warn','outbox_delivery_deferred',{item:item.id.slice(0,12),code:errorCode(error?.code,'event_delivery_failed'),status:Number(error?.status)||null}),
    onDelivered:item=>log('info','outbox_item_delivered',{item:item.id.slice(0,12)})
  });
}

async function enqueueGatewayEvent(body){
  const queued=await outbox.enqueue(body);
  const image=body.metadata?.ceremonyImage;
  log('info',queued.duplicate?'outbox_item_already_queued':'outbox_item_queued',{
    item:queued.id.slice(0,12),workspace:workspaceTag(body.workspaceId),
    ...(image?{imageFieldPresent:image.fieldPresent===true,imageValuePresent:image.valuePresent===true,
      imageAccepted:image.accepted===true,imageScheme:errorCode(image.scheme,'missing'),imageHost:image.hostname||null}:{})
  });
  void flushOutbox().catch(error=>log('warn','outbox_flush_failed',{code:errorCode(error?.code,'outbox_flush_failed')}));
}

async function runWorkspace(workspaceId,signal){
  const replay=new SoopGatewayReplayGuard(),startedAt=new Date().toISOString();let generation=0,sequence=0,lastEventAt=null,chatNumber=null;
  const tag=workspaceTag(workspaceId);let lastErrorCode=null;
  let state={status:'idle',reconnectCount:0,retryAttempt:0};
  const heartbeat=async(extra={})=>await postGateway({kind:'heartbeat',workspaceId,instanceId,state:state.status,generation,reconnectCount:state.reconnectCount,lastSequence:sequence,connectedAt:state.status==='connected'?startedAt:null,lastEventAt,heartbeatAt:new Date().toISOString(),lastErrorCode,chatNumber,...extra});
  const timer=setInterval(()=>void heartbeat().catch(error=>log('warn','heartbeat_failed',{workspace:tag,code:errorCode(error?.code,'heartbeat_failed')})),HEARTBEAT_MS);
  try{
    while(!signal.aborted){
      generation+=1;sequence=0;chatNumber=null;state=reduceSoopSdkSession(state,{type:'connect_requested'});await heartbeat();
      let token;
      try{token=await postGateway({kind:'lease',workspaceId})}catch(error){
        if(error?.code==='soop_connection_missing'||error?.upstreamStatus===401){state=reduceSoopSdkSession(state,{type:'authorization_failed'})}
        else state=reduceSoopSdkSession(state,{type:'temporary_error'});
        lastErrorCode=errorCode(error?.code,'token_refresh_failed');
        log('warn','lease_failed',{workspace:tag,code:lastErrorCode});
        await heartbeat().catch(()=>{});
        if(state.status==='reauthorization_required')break;
        await sleep(state.nextRetryMs||30_000,signal);continue;
      }
      const connectionId=`${instanceId}:${workspaceId}:${generation}`;
      let room=null;
      try{
        const result=await runSoopBrowserSession({clientId:token.clientId,clientSecret:token.clientSecret,accessToken:token.accessToken,signal,
          onState:event=>{
            if(event.state==='connected'){
              state=reduceSoopSdkSession(state,{type:'connected'});room=event.room||room;chatNumber=Number(room?.chatNumber)||null;lastErrorCode=null;
              log('info','sdk_connected',{workspace:tag,chatNumberAvailable:chatNumber!==null});
              void heartbeat({tokenExpiresAt:token.expiresAt}).catch(()=>{});
            }
            else if(event.state==='connecting'&&event.room)room=event.room;
            else if(event.state==='error'){
              lastErrorCode=errorCode(event.code,'sdk_error');
              log('warn','sdk_error',{workspace:tag,code:lastErrorCode,message:String(event.message||'').slice(0,240)})
            }
          },
          onEvent:event=>{
            const currentSequence=sequence++;
            void (async()=>{
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
                  // Log only the SDK action and classification reason.  Donor
                  // identity and chat payload remain outside diagnostic logs.
                  log('info','sdk_event_ignored',{workspace:tag,action,sequence:currentSequence,reason:errorCode(classified.reason,'invalid_content')});
                }
                return;
              }
              const normalized=classified.value;
              const duplicate=replay.check({signature:normalized.metadata.replaySignature,connectionId,explicitEventId:normalized.metadata.explicitEventId});
              if(duplicate)return;
              lastEventAt=event.at;
               try{await enqueueGatewayEvent({kind:'event',workspaceId,relay:normalized.relay,metadata:{
                 occurredAtSource:normalized.metadata.occurredAtSource,
                 ...(normalized.metadata.ceremonyImage?{ceremonyImage:normalized.metadata.ceremonyImage}:{})
               }})}
              catch(error){
                log('error','event_queue_failed',{workspace:tag,action:normalized.metadata.action,eventType:normalized.relay.eventType,sequence:currentSequence,code:errorCode(error?.code,'event_queue_failed')});
              }
            })().catch(error=>log('error','sdk_event_processing_failed',{workspace:tag,action:errorCode(event.action,'unknown'),sequence:currentSequence,code:errorCode(error?.code,'sdk_event_processing_failed')}));
          }});
        if(signal.aborted)break;
        if(!result.ready)lastErrorCode=errorCode(result.errorCode,'sdk_connect_failed');
        state=reduceSoopSdkSession(state,{type:result.ready?'connection_closed':'temporary_error'});
      }catch(error){
        const offline=/invalid-chat-info|broadcast|방송/i.test(String(error?.message||''));
        lastErrorCode=errorCode(offline?'broadcast_offline':error?.code,'sdk_connect_failed');
        log('warn','session_failed',{workspace:tag,code:lastErrorCode,message:safeErrorMessage(error?.message)});
        state=reduceSoopSdkSession(state,{type:offline?'broadcast_offline':'temporary_error'});
        await heartbeat({chatNumber:Number(room?.chatNumber)||null,tokenExpiresAt:token.expiresAt}).catch(()=>{});
        if(offline){await sleep(30_000,signal);continue}
      }
      await heartbeat({tokenExpiresAt:token.expiresAt}).catch(()=>{});
      await sleep(state.nextRetryMs||1_000,signal);
    }
  }finally{clearInterval(timer);state=reduceSoopSdkSession(state,{type:'stopped'});await heartbeat().catch(()=>{});log('info','workspace_stopped',{workspace:tag})}
}

async function reconcile(){
  const enabled=await enabledWorkspaceIds();
  for(const [workspaceId,worker] of workers){if(!enabled.has(workspaceId)){worker.abort.abort();workers.delete(workspaceId)}}
  for(const workspaceId of enabled){if(workers.has(workspaceId))continue;const abort=new AbortController(),tag=workspaceTag(workspaceId);const promise=runWorkspace(workspaceId,abort.signal).catch(error=>log('error','workspace_crashed',{workspace:tag,code:errorCode(error?.code,'workspace_crashed')})).finally(()=>workers.delete(workspaceId));workers.set(workspaceId,{abort,promise});log('info','workspace_started',{workspace:tag})}
}

async function main(){
  assertConfiguration();
  outbox=new EncryptedGatewayOutbox({directory:stateDirectory?`${stateDirectory}/outbox`:`${process.cwd()}/.soop-gateway-outbox`,secret:gatewaySecret});
  await outbox.init();
  await persistWorkerState();
  workerStateTimer=setInterval(()=>void persistWorkerState().catch(error=>log('error','worker_state_write_failed',{code:errorCode(error?.code,'worker_state_write_failed')})),15_000);
  const pending=await outbox.count();log('info','gateway_started',{outboxPending:pending});
  await flushOutbox().catch(error=>log('warn','outbox_startup_flush_failed',{code:errorCode(error?.code,'outbox_startup_flush_failed')}));
  outboxTimer=setInterval(()=>void flushOutbox().catch(error=>log('warn','outbox_flush_failed',{code:errorCode(error?.code,'outbox_flush_failed')})),OUTBOX_FLUSH_MS);
  while(!stopping){try{await reconcile()}catch(error){log('error','reconcile_failed',{code:error?.code||'reconcile_failed'})}await sleep(POLL_MS)}
  if(outboxTimer)clearInterval(outboxTimer);
  if(workerStateTimer)clearInterval(workerStateTimer);
  for(const worker of workers.values())worker.abort.abort();await Promise.allSettled([...workers.values()].map(worker=>worker.promise));await flushOutbox().catch(()=>{});await persistWorkerState('stopped').catch(()=>{});log('info','gateway_stopped',{outboxPending:await outbox.count()});
}

for(const name of ['SIGINT','SIGTERM'])process.on(name,()=>{stopping=true});
main().catch(error=>{log('fatal','gateway_failed',{code:error?.code||'gateway_failed'});process.exitCode=1});
