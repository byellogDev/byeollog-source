import crypto from 'node:crypto';
import WebSocket from 'ws';
import {observeRolling} from './core.mjs';
import {createEgressFetch} from './egress-fetch.mjs';

export async function runSoopDirectSession({clientId,clientSecret,accessToken,expectedBroadcasterId,providerTokenExpiresAt,getCredentials,signal,onEvent=()=>{},onState=()=>{},onDiagnostic=()=>{},fetchImpl=fetch,WebSocketImpl=WebSocket,timing,credentialPollMs=30000,durationMs=172800000}={}){
 const roomFetch=createEgressFetch({socketPath:process.env.SOOP_EGRESS_CONTROL_SOCKET,
  baselinePorts:(process.env.SOOP_EGRESS_BASELINE_PORTS||'').split(',').filter(Boolean).map(Number),owner:expectedBroadcasterId,fetchImpl});
 const abort=new AbortController();
 const stop=()=>abort.abort();signal?.addEventListener('abort',stop,{once:true});if(signal?.aborted)abort.abort();
 let polling=false,receiver=null,timer=null,terminalCode=null;
 const config={clientId,clientSecret,accessToken,broadcasterId:expectedBroadcasterId,providerTokenExpiresAt,salt:crypto.randomBytes(32).toString('hex'),durationMs};
 const poll=async()=>{
  if(polling||abort.signal.aborted||!receiver)return;polling=true;
  try{
   const next=await getCredentials();if(abort.signal.aborted)return;
   if(next.providerAccountId!==expectedBroadcasterId||next.clientId!==clientId||next.clientSecret!==clientSecret){terminalCode='replacement_owner_or_application_mismatch';abort.abort();return}
   receiver({...config,accessToken:next.accessToken,providerTokenExpiresAt:next.providerTokenExpiresAt});
  }catch(e){
   // Revocation/scope failure must stop collection, while transient refresh
   // failures retain an already authenticated connection.
   if(['soop_connection_missing','soop_gateway_lease_scope_mismatch','soop_workspace_forbidden'].includes(e?.code)){
    terminalCode='direct_authorization_revoked';abort.abort();
   }else onDiagnostic({kind:'credential_unavailable_keep_active'});
  }finally{polling=false}
 };
 try{
  const result=await observeRolling(config,{WebSocketImpl,fetchImpl:roomFetch,signal:abort.signal,timing,
   subscribeReplacement:fn=>{receiver=fn;timer=setInterval(()=>void poll(),credentialPollMs);return()=>{clearInterval(timer);receiver=null}},
   onEvent:e=>onEvent({...e,at:e.receivedAt}),
   onReport:e=>{
    if(e.kind==='ready')onState({state:'connected',at:new Date().toISOString(),room:{bjId:expectedBroadcasterId,chatNumber:e.chatNumber}});
    // Full content and high-volume comparison records are never logged.
    else if(e.kind!=='frame'&&e.kind!=='telemetry')onDiagnostic(e);
   }});
  const code=terminalCode||result.reason;
  if(signal?.aborted)return {ready:result.ready,errorCode:'supervisor_stopped'};
  if(['broadcast_offline','broadcast_closed'].includes(code))return {ready:false,errorCode:'broadcast_offline'};
  if(code==='duration_reached')return {ready:result.ready,errorCode:'duration_reached'};
  const error=Object.assign(new Error(code||'direct_connection_failed'),{code:code||'direct_connection_failed'});
  if(/owner|identity|application_mismatch|authorization_revoked|auth_rejected|login_rejected|join_rejected/.test(error.code))error.directTerminal=true;
  throw error;
 }finally{clearInterval(timer);receiver=null;signal?.removeEventListener('abort',stop);abort.abort()}
}
