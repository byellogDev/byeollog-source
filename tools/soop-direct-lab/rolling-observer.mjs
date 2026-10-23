// Receive-only rolling observation. OAuth refresh remains owned by production.
import {runDirect} from './client.mjs';
import {CONTENT_CODES,contentEvent,fault} from './protocol.mjs';
import {comparisonRecord,comparisonDifference} from './comparison-record.mjs';

export async function observeRolling(config,{WebSocketImpl,fetchImpl=fetch,signal,onReport=()=>{},onEvent=()=>{},subscribeReplacement=()=>()=>{},timing={}}={}){
 const limits={settleMs:1000,overlapMs:30000,attemptMs:90000,pollMs:100,maxFrames:10000,healthFreshMs:60000,...timing};
 for(const [k,v] of Object.entries(limits))if(!Number.isSafeInteger(v)||v<1||v>(k==='maxFrames'?20000:180000))throw fault('invalid_handoff_limits');
 if(limits.settleMs+limits.overlapMs>=limits.attemptMs)throw fault('invalid_handoff_limits');
 if(typeof config.salt!=='string'||config.salt.length<32)throw fault('invalid_observer_salt');
 const duration=Number(config.durationMs);if(!Number.isFinite(duration)||duration<100||duration>172800000)throw fault('invalid_duration');
 const end=Date.now()+duration,legs=new Set(),counts={},unknownCodes={};let active,next,finished=false,reason=null,ready=false,handoffs=0,sequence=0,unsubscribe,terminal=null,generation=0;
 let resolveDone;const done=new Promise(r=>resolveDone=r);
 let attemptedToken=config.accessToken;
 const emit=(kind,x={})=>onReport({kind,...x});
 const finish=why=>{if(!finished){finished=true;reason=why;resolveDone()}};
 const abort=()=>finish('supervisor_stopped');
 const block=why=>{if(!next)return;const old=next;next=null;
  for(const side of ['old','next'])for(const record of old.pending[side].slice(0,20))emit('comparison_diagnostic',{diagnosticKind:'handoff_unmatched',[side==='old'?'old':'replacement']:record});
  old.expected=true;old.abort.abort();emit('handoff_blocked',{reason:why,oldPreserved:!!active?.ready&&!active?.ended})};
 function frame(leg,p){
  if(finished)return;
  // Passive provider traffic after validated room admission; no injected WS ping.
  // Login/join acknowledgements, unknown codes and rejected control frames cannot
  // count as fresh post-warmup evidence. Content comparison remains separate.
  if(!CONTENT_CODES.includes(p.code)){
   if(p.ret===0&&[0,4,127].includes(p.code)){leg.healthAt=Date.now();leg.healthCode=p.code;}
   return;
  }
  const record=comparisonRecord(p,{broadcasterId:config.broadcasterId,chatNumber:leg.chatNumber},config.salt);
  if(leg===active)emit('frame',record);
  // Content during warmup also disqualifies a quiet switch. It cannot be
  // re-labelled silence merely because it falls outside the common window.
  if(next&&[active,next].includes(leg))next.sawContent=true;
  if(!next?.commonAt||Date.now()<next.commonAt||![active,next].includes(leg))return;
  const side=leg===active?'old':'next',pending=next.pending;
  const recordBytes=Buffer.byteLength(JSON.stringify(record));
  if(pending[side].length>=limits.maxFrames||next.pendingBytes+recordBytes>4*1024*1024){block('comparison_capacity');return}
  next.pendingBytes+=recordBytes;
  pending[side].push(record);
  while(next&&pending.old.length&&pending.next.length){
   const a=pending.old[0],b=pending.next[0];
   if(a.code!==b.code||a.digest!==b.digest){emit('comparison_diagnostic',{diagnosticKind:'handoff_content_mismatch',old:a,replacement:b,...comparisonDifference(a,b)});block('overlap_order_or_content_mismatch');return}
   if(a.rawDigest!==b.rawDigest)emit('comparison_diagnostic',{diagnosticKind:'handoff_wire_only_difference',old:a,replacement:b,...comparisonDifference(a,b)});
   next.pendingBytes-=Buffer.byteLength(JSON.stringify(a))+Buffer.byteLength(JSON.stringify(b));
   pending.old.shift();pending.next.shift();if(a.semanticKind==='event')next.matched++;
  }
 }
 function launch(credentials){
  const leg={credentials,abort:new AbortController(),ready:false,ended:false,expected:false,pending:{old:[],next:[]},pendingBytes:0,matched:0,started:Date.now(),commonAt:null,sawContent:false,healthAt:0,healthCode:null,chatNumber:null,generation:++generation};legs.add(leg);
  // Assign authority before any async transport callback can run.
  if(!active)active=leg;else next=leg;
  leg.promise=runDirect({...credentials,durationMs:Math.max(100,end-Date.now())},{WebSocketImpl,fetchImpl,signal:leg.abort.signal,
   onFrame:p=>frame(leg,p),onEvent:e=>{if(leg===active&&!finished){sequence++;counts[e.action]=(counts[e.action]||0)+1;onEvent({...e,sequence})}},
   onReport:e=>{
    if(finished)return;
    if(e.kind==='ready'){
     leg.ready=true;leg.chatNumber=e.chatNumber;
     if(leg===active){ready=true;emit('ready',{chatNumber:leg.chatNumber})}
     else if(leg===next){
      if(leg.chatNumber!==active.chatNumber){block('replacement_broadcast_mismatch');return}
      leg.commonAt=Date.now()+limits.settleMs;emit('handoff_overlap_started');
     }
    }else if(e.kind==='telemetry'&&leg===active){emit('telemetry',{...e,events:sequence,counts:{...counts},sockets:[...legs].filter(l=>l.ready&&!l.ended).length,handoffs,oauthExpired:Date.now()>=Date.parse(leg.credentials.providerTokenExpiresAt),providerControlAgeMs:leg.healthAt?Date.now()-leg.healthAt:null,providerControlCode:leg.healthCode})}
    else if(e.kind==='candidate_decode_error'){emit('candidate_decode_error',e);if(leg===next)block('replacement_decode_failed')}
    else if(e.kind==='broadcast_signal'&&leg===active)emit('broadcast_signal',e);
   }}).then(result=>{
    leg.ended=true;legs.delete(leg);for(const [k,v]of Object.entries(result.unknownCodes||{}))unknownCodes[k]=(unknownCodes[k]||0)+v;
    emit('connection_ended',{generation:leg.generation,role:leg===active?'active':'replacement',expected:leg.expected,reason:result.reason,stage:result.stage,transport:result.transport});
    if(finished||leg.expected)return;
    if(leg===active){terminal=result;finish(result.reason||'active_connection_failed');}else if(leg===next)block('replacement_connection_failed');
   }).catch(()=>{leg.ended=true;legs.delete(leg);if(!finished&&!leg.expected){if(leg===active)finish('active_connection_failed');else block('replacement_connection_failed')}});
  return leg;
 }
 function replace(c){
  if(finished||!active?.ready||next||legs.size>=2)return;
  if(!c||c.accessToken===attemptedToken||c.accessToken===active.credentials.accessToken)return;
  const expiry=Date.parse(c.providerTokenExpiresAt||'');
  if(c.broadcasterId!==config.broadcasterId||c.clientId!==config.clientId||c.clientSecret!==config.clientSecret){finish('replacement_owner_or_application_mismatch');return}
  if(!Number.isFinite(expiry)||expiry<=Date.parse(active.credentials.providerTokenExpiresAt)||expiry-Date.now()<limits.attemptMs+30000){emit('handoff_blocked',{reason:'replacement_not_newer_or_too_short',oldPreserved:true});return}
  attemptedToken=c.accessToken;launch(c);emit('handoff_preparing');
 }
 const poll=setInterval(()=>{
  if(Date.now()>=end){finish('duration_reached');return}
  if(!next)return;
  if(Date.now()-next.started>=limits.attemptMs){block(next.matched?'overlap_incomplete':'no_common_content');return}
  if(!next.ready||next.ended||active.ended||!next.commonAt||Date.now()<next.commonAt+limits.overlapMs||next.pending.old.length||next.pending.next.length)return;
  const basis=next.matched?'content_matched':!next.sawContent&&next.healthAt>=next.commonAt&&Date.now()-next.healthAt<=limits.healthFreshMs?'quiet_provider_traffic':null;
  if(!basis)return;
  const old=active,promoted=next;active=promoted;next=null;old.expected=true;handoffs++;
  emit('handoff_committed',{matched:promoted.matched,overlapMs:Date.now()-promoted.commonAt,handoffs,basis,contentVerified:basis==='content_matched',providerControlCode:basis==='quiet_provider_traffic'?promoted.healthCode:null,providerControlAgeMs:basis==='quiet_provider_traffic'?Date.now()-promoted.healthAt:null});old.abort.abort();
 },limits.pollMs);
 try{
  if(signal?.aborted)finish('supervisor_stopped');else{signal?.addEventListener('abort',abort,{once:true});launch(config);unsubscribe=subscribeReplacement(replace)}
  await done;
 }finally{
  finished=true;clearInterval(poll);unsubscribe?.();signal?.removeEventListener('abort',abort);
  const closing=[...legs];for(const l of closing)l.abort.abort();await Promise.all(closing.map(l=>l.promise));
 }
 return {ready,reason,stage:terminal?.stage??null,transport:terminal?.transport??{},counts,unknownCodes,handoffs,cleanupComplete:legs.size===0};
}
