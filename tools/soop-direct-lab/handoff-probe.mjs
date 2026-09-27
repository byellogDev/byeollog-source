// Bounded, receive-only experiment. NOT imported by the running soak or gateway.
// No refresh endpoint, database writes, raw packet logs or retry loop.
import {createHmac,randomBytes} from 'node:crypto';
import {runDirect} from './client.mjs';
import {CONTENT_CODES,contentEvent,fault} from './protocol.mjs';

export async function probeTokenHandoff(initial,{getReplacement,WebSocketImpl,fetchImpl=fetch,signal,
  onReport=()=>{},onSelectedEvent=()=>{},limits={},clientTiming={}}={}){
 const cfg={totalMs:180000,credentialMs:20000,overlapMs:30000,settleMs:1000,postMs:30000,
  deadlineMarginMs:10000,pollMs:25,maxFrames:10000,...limits};
 for(const[k,v]of Object.entries(cfg))if(!Number.isSafeInteger(v)||v<1||v>(k==='maxFrames'?20000:600000))throw fault('invalid_probe_limits');
 if(cfg.settleMs>=cfg.overlapMs||cfg.overlapMs+cfg.postMs+cfg.credentialMs>=cfg.totalMs)throw fault('invalid_probe_limits');
 if(typeof getReplacement!=='function')throw fault('replacement_reader_required');
 const owner=initial.broadcasterId,now=()=>Date.now(),salt=randomBytes(32);
 const started=now(),endsAt=started+cfg.totalMs;
 const legs={},controllers=[],pending={old:[],next:[]},common={old:[],next:[]};
 const report={status:'running',promoted:false,matched:0,selectedEvents:0,selectedCounts:{},overlapCounts:{old:0,next:0},
  excludedWarmup:{old:0,next:0},oldPreservedOnFailure:false,reason:null,cleanupComplete:false};
 let authority='old',commonAt=null,finishAt=endsAt,finishing=false,credentialTimer,poll;
 let resolveDone;const done=new Promise(r=>resolveDone=r);
 const emit=(kind,values={})=>onReport({kind,...values});
 function validate(c,old=false){
  if(!c||c.broadcasterId!==owner||typeof owner!=='string')throw fault('handoff_owner_mismatch');
  if(c.clientId!==initial.clientId||c.clientSecret!==initial.clientSecret)throw fault('handoff_application_mismatch');
  const expiry=Date.parse(c.providerTokenExpiresAt||'');
  if(!Number.isFinite(expiry)||expiry-now()<=cfg.credentialMs+cfg.overlapMs+cfg.deadlineMarginMs)throw fault('handoff_token_too_short');
  if(!old&&(c.accessToken===initial.accessToken||expiry<=Date.parse(initial.providerTokenExpiresAt)))throw fault('replacement_not_newer');
  return {...c,durationMs:Math.min(endsAt-now(),expiry-now()-cfg.deadlineMarginMs)};
 }
 validate(initial,true);
 const fail=reason=>{
  if(finishing||report.status!=='running')return;
  if(report.promoted){report.status='needs_review';report.reason=reason;finish(reason);return}
  report.status='not_promoted';report.reason=reason;
  report.oldPreservedOnFailure=!!legs.old?.ready&&!legs.old?.ended;
  finishAt=Math.min(endsAt,now()+cfg.postMs);
  legs.next?.abort.abort();
  emit('handoff_blocked',{reason,oldPreserved:report.oldPreservedOnFailure});
 };
 const finish=reason=>{
  if(finishing)return;finishing=true;
  if(report.status==='running'){report.status=report.promoted?'promoted':'not_promoted';report.reason=reason}
  for(const a of controllers)a.abort();resolveDone();
 };
 const externalAbort=()=>finish('supervisor_stopped');
 function frame(side,p){
  if(finishing||!CONTENT_CODES.includes(p.code))return;
  // runDirect reports bytes before conversion: independently validate before
  // accepting evidence that could authorize promotion.
  contentEvent(p,{broadcasterId:owner});
  if(side===authority)report.selectedCounts[p.code]=(report.selectedCounts[p.code]||0)+1;
  if(report.promoted||report.status!=='running'||commonAt===null||now()<commonAt){report.excludedWarmup[side]++;return}
  const key=p.code+':'+createHmac('sha256',salt).update(p.bytes).digest('hex');
  if(common[side].length>=cfg.maxFrames){fail('comparison_capacity');return}
  common[side].push(key);pending[side].push(key);report.overlapCounts[side]++;
  while(pending.old.length&&pending.next.length){
   if(pending.old[0]!==pending.next[0]){fail('overlap_order_or_content_mismatch');return}
   pending.old.shift();pending.next.shift();report.matched++;
  }
 }
 function launch(side,c){
  const abort=new AbortController();controllers.push(abort);
  const leg=legs[side]={abort,ready:false,ended:false,expectedStop:false};
  leg.promise=runDirect(c,{WebSocketImpl,fetchImpl,signal:abort.signal,timing:clientTiming,
   onFrame:p=>frame(side,p),onEvent:e=>{
    if(!finishing&&side===authority)onSelectedEvent({...e,sequence:report.selectedEvents++});
   },onReport:e=>{
    if(finishing)return;
    if(e.kind==='candidate_decode_error'){fail('packet_validation_failed');return}
    if(e.kind==='ready'){
     leg.ready=true;leg.readyAt=now();emit('leg_ready',{side});
     if(side==='old')void replacement();
     else {commonAt=now()+cfg.settleMs;emit('overlap_started')}
    }
    if(e.kind==='broadcast_signal'){finish('broadcast_closed')}
   }}).then(result=>{
    leg.ended=true;leg.reason=result.reason;emit('leg_closed',{side,expected:leg.expectedStop});
    if(finishing||leg.expectedStop)return;
    if(side===authority){report.reason=side==='old'?'old_connection_lost':'new_connection_lost';report.status='needs_review';finish(report.reason)}
    else fail('replacement_connection_failed');
   }).catch(()=>{leg.ended=true;if(side===authority){report.status='needs_review';report.reason='active_connection_failed';finish(report.reason)}else fail('replacement_connection_failed')});
 }
 async function replacement(){
  const abort=new AbortController();controllers.push(abort);
  let expired=false;
  credentialTimer=setTimeout(()=>{expired=true;abort.abort();fail('replacement_read_timeout')},cfg.credentialMs);
  try{
   const next=await getReplacement({signal:abort.signal});
   if(expired||finishing||report.status!=='running')return;
   const checked=validate(next);clearTimeout(credentialTimer);
   launch('next',checked);
  }catch{if(!finishing)fail('replacement_unavailable_or_invalid')}
  finally{clearTimeout(credentialTimer)}
 }
 try{
  if(signal?.aborted){finish('supervisor_stopped');return report}
  signal?.addEventListener('abort',externalAbort,{once:true});
  launch('old',validate(initial,true));
  poll=setInterval(()=>{
   if(now()>=finishAt){finish(report.promoted?'post_observation_complete':'probe_deadline');return}
   if(report.status!=='running'||report.promoted||!legs.next?.ready||legs.next.ended||legs.old.ended||now()<commonAt+cfg.overlapMs)return;
   if(pending.old.length||pending.next.length||report.matched===0){fail(report.matched===0?'no_common_content':'overlap_incomplete');return}
   // One synchronous authority flip; the old connection is aborted afterwards.
   // This is experimental selection evidence, not a durable delivery guarantee.
   authority='next';report.promoted=true;report.cutoverAt=new Date().toISOString();
   report.readyOverlapMs=now()-legs.next.readyAt;
   finishAt=Math.min(endsAt,now()+cfg.postMs);
   legs.old.expectedStop=true;emit('handoff_committed',{matched:report.matched,readyOverlapMs:report.readyOverlapMs});legs.old.abort.abort();
  },cfg.pollMs);
  await done;
 }finally{
  finishing=true;clearInterval(poll);clearTimeout(credentialTimer);signal?.removeEventListener('abort',externalAbort);
  for(const a of controllers)a.abort();
  await Promise.all(Object.values(legs).map(l=>l.promise));
  report.cleanupComplete=Object.values(legs).every(l=>l.ended);
  report.pending={old:pending.old.length,next:pending.next.length};
  report.durationMs=now()-started;
  // No packet bytes, event fields, OAuth values or HMACs escape this experiment.
  emit('handoff_result',report);
 }
 return report;
}
