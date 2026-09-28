import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket,WebSocketServer} from '../../node_modules/ws/wrapper.mjs';
import {probeTokenHandoff} from './handoff-probe.mjs';
import {decodePackets,encodePacket} from './protocol.mjs';
import {configFor,infoFor,fixtures} from './fixtures.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EncryptedGatewayOutbox} from '../../services/soop-gateway/services/soop-chat-gateway/outbox.mjs';
import {createCandidateDelivery} from './delivery-candidate.mjs';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const limits={totalMs:2000,credentialMs:200,overlapMs:180,settleMs:20,postMs:100,deadlineMarginMs:50,pollMs:5,maxFrames:100};
async function fixture(t,mode='normal',overrides={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 const sockets=new Map(),records=[],timers=[],completion=new AbortController();let sent=0,selected=0,afterBlocked=0,blocked=false,loop,maxSockets=0,finalBatchSent=false,finalBatchSelected=false;
 t.after(async()=>{for(const h of timers){clearTimeout(h);clearInterval(h)}clearInterval(loop);for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r))});
 const initial={...configFor(),providerTokenExpiresAt:new Date(Date.now()+10000).toISOString()};
 const next={...initial,accessToken:'synthetic-new',providerTokenExpiresAt:new Date(Date.now()+20000).toISOString()};
 server.on('connection',s=>{
  maxSockets=Math.max(maxSockets,server.clients.size);
  s.on('message',data=>{
   const p=decodePackets(data)[0];
   if(p.code===16){s.side=p.fields[0]===next.accessToken?'next':'old';sockets.set(s.side,s);s.send(encodePacket(1,[]))}
   if(p.code===2){
    if(s.side==='next'&&mode==='reject'){s.send(encodePacket(2,[],1));return}
    s.send(encodePacket(2,['1000','lab0']));
    if(s.side==='next'&&mode==='evict-old')sockets.get('old').close(1000);
    if(s.side==='next'&&mode==='drop-new')timers.push(setTimeout(()=>s.close(1000),30));
   }
  });
 });
 class Transport extends WebSocket{constructor(url,protocol,opts){super('ws://127.0.0.1:'+server.address().port+new URL(url).pathname,protocol,opts)}}
 const send=()=>{
  const active=records.some(r=>r.kind==='handoff_committed')?'next':'old';
  if(sockets.get(active)?.readyState!==1)return;
  // Two byte-identical real occurrences must survive; no Set-based dedupe.
  const f=fixtures().find(f=>f.code===18),b=encodePacket(18,f.fields);
  for(let n=0;n<2;n++){
   sent++;if(blocked)afterBlocked++;
   for(const[side,s]of sockets)if(s.readyState===1){
    if(mode==='mismatch'&&side==='next'){const fields=[...f.fields];fields[3]='99';s.send(encodePacket(18,fields))}
    else s.send(b);
   }
  }
 };
 const onReport=e=>{
  records.push(e);
  if(e.kind==='overlap_started'&&mode!=='quiet')timers.push(setTimeout(()=>{send();clearInterval(loop);loop=setInterval(send,35)},50));
  if(e.kind==='handoff_committed'&&overrides.finishAfterDelivery){
   // End the producer first. A successful socket.send is not a receive ack:
   // closing on a 100ms timer can discard the final pair still in transit.
   clearInterval(loop);finalBatchSent=true;send();
   if(overrides.finalBatchStallMs)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,overrides.finalBatchStallMs);
  }
  if(e.kind==='handoff_blocked'){blocked=true;if(!loop)loop=setInterval(send,20)}
  overrides.onReport?.(e);
 };
 const getReplacement=overrides.getReplacement|| (async()=>mode==='wrong-owner'?{...next,broadcasterId:'lab1'}:mode==='same-token'?{...next,accessToken:initial.accessToken}:next);
 const onSelectedEvent=e=>{
  selected++;overrides.onSelectedEvent?.(e);
  if(finalBatchSent&&selected===sent){finalBatchSelected=true;queueMicrotask(()=>completion.abort())}
 };
 const boundedCompletion=overrides.finishAfterDelivery?{totalMs:5000,postMs:1500}:{};
 const signal=overrides.signal?AbortSignal.any([completion.signal,overrides.signal]):completion.signal;
 const result=await probeTokenHandoff(initial,{getReplacement,WebSocketImpl:Transport,fetchImpl:async()=>new Response(JSON.stringify(infoFor())),onReport,onSelectedEvent,limits:{...limits,...boundedCompletion,...overrides.limits},signal});
 clearInterval(loop);
 return{result,records,sent,afterBlocked,maxSockets,finalBatchSelected};
}
test('new token joins before old closes; byte-identical donations counted once per occurrence across cutover',async t=>{
 const r=await fixture(t,'normal',{finishAfterDelivery:true});assert.equal(r.result.promoted,true);assert.equal(r.result.status,'promoted');assert.equal(r.maxSockets,2);assert.equal(r.finalBatchSelected,true);
 assert.equal(r.result.selectedCounts['18'],r.sent);assert.ok(r.result.matched>=2);assert.equal(r.result.cleanupComplete,true);
 assert.ok(r.records.findIndex(x=>x.kind==='leg_ready'&&x.side==='next')<r.records.findIndex(x=>x.kind==='leg_closed'&&x.side==='old'));
 assert.ok(r.result.readyOverlapMs>=limits.overlapMs);
 assert.ok(!JSON.stringify(r).includes('synthetic-new'));assert.ok(!JSON.stringify(r).includes('synthetic-user'));
});
for(const mode of ['reject','drop-new','wrong-owner','same-token','mismatch','quiet'])test(mode+' blocks handoff and preserves the active connection',async t=>{
 const r=await fixture(t,mode);assert.equal(r.result.promoted,false);assert.equal(r.result.oldPreservedOnFailure,true);assert.equal(r.result.cleanupComplete,true);
 assert.ok(r.afterBlocked>0);assert.ok(r.result.selectedCounts['18']>0);
 assert.ok(!r.records.some(x=>x.kind==='handoff_committed'));
});
test('provider evicting old connection is an explicit coverage failure, not successful handoff',async t=>{
 const r=await fixture(t,'evict-old');assert.equal(r.result.status,'needs_review');assert.equal(r.result.reason,'old_connection_lost');assert.equal(r.result.promoted,false);
});
test('bounded credential read timeout retains old traffic even if reader ignores cancellation',async t=>{
 const r=await fixture(t,'normal',{getReplacement:()=>new Promise(()=>{})});assert.equal(r.result.reason,'replacement_read_timeout');assert.ok(r.afterBlocked>0);assert.equal(r.result.cleanupComplete,true);
});
test('explicit cancellation closes both connections without promotion',async t=>{
 const a=new AbortController();const r=await fixture(t,'normal',{signal:a.signal,onReport:e=>{if(e.kind==='overlap_started')a.abort()}});
 assert.equal(r.result.reason,'supervisor_stopped');assert.equal(r.result.promoted,false);assert.equal(r.result.cleanupComplete,true);
});
test('comparison capacity is bounded and never silently discards packets',async t=>{
 const r=await fixture(t,'normal',{limits:{maxFrames:2}});assert.equal(r.result.reason,'comparison_capacity');assert.equal(r.result.oldPreservedOnFailure,true);
});
test('invalid or too-short initial token fails before opening a socket',async()=>{
 let requests=0;
 await assert.rejects(probeTokenHandoff({...configFor(),providerTokenExpiresAt:new Date().toISOString()},{getReplacement:async()=>{requests++},limits,WebSocketImpl:class{constructor(){requests++}}}),/token_too_short/);
 assert.equal(requests,0);
});

test('selected handoff stream reaches existing encrypted outbox; restart/retry preserves order and identical donations',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'byeollog-handoff-outbox-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const options={directory,secret:'synthetic-outbox-key-for-handoff-test-only',baseRetryMs:1,maxRetryMs:1};
 const box=new EncryptedGatewayOutbox(options);await box.init();
 const delivery=createCandidateDelivery({workspaceId:'synthetic-a',instanceId:'synthetic-instance',logicalConnectionId:'synthetic-logical-a',expectedBroadcasterId:'lab0',leaseToken:'synthetic-lease',outbox:box});
 // Deliberately stall beyond the former 100ms closing window; completion must
 // wait for receipt, then drain durable writes without weakening count/order.
 const r=await fixture(t,'normal',{finishAfterDelivery:true,finalBatchStallMs:150,onSelectedEvent:e=>delivery.accept(e)});await delivery.drain();
 assert.equal(r.finalBatchSelected,true);
 assert.equal(r.result.promoted,true);assert.equal(await box.count(),r.sent);
 for(const name of await box.files())assert.doesNotMatch(await readFile(join(directory,name),'utf8'),/synthetic-user|synthetic-lease|합성시청자/);
 const failed=await box.flush(async()=>{throw Object.assign(Error('synthetic'),{status:503})});assert.equal(failed.delivered,0);
 await new Promise(r=>setTimeout(r,10));
 const restarted=new EncryptedGatewayOutbox(options);await restarted.init();const sent=[];
 await restarted.flush(async b=>sent.push(b),{limit:100});
 assert.equal(sent.length,r.sent);assert.equal(await restarted.count(),0);
 assert.equal(new Set(sent.map(b=>b.relay.event.eventId)).size,r.sent);
 assert.deepEqual(sent.map(b=>b.relay.connection.sequence),Array.from({length:r.sent},(_,i)=>i));
 assert.ok(sent.every(b=>b.workspaceId==='synthetic-a'&&b.room.bjId==='lab0'&&b.relay.event.amount===100));
});

test('delivery binding rejects another room before any outbox write',async()=>{
 let writes=0;const d=createCandidateDelivery({workspaceId:'synthetic-a',instanceId:'synthetic-instance',logicalConnectionId:'synthetic-logical-a',expectedBroadcasterId:'lab0',leaseToken:'synthetic-lease',outbox:{enqueue:async()=>{writes++}}});
 assert.throws(()=>d.accept({room:{bjId:'lab1',chatNumber:1}}),/room_mismatch/);await d.drain();assert.equal(writes,0);
});

test('fatal durable enqueue failure is surfaced by drain rather than acknowledged',async()=>{
 const d=createCandidateDelivery({workspaceId:'synthetic-a',instanceId:'synthetic-instance',logicalConnectionId:'synthetic-logical-a',expectedBroadcasterId:'lab0',leaseToken:'synthetic-lease',outbox:{enqueue:async()=>{throw Error('synthetic invalid input')}}});
 const f=fixtures().find(f=>f.code===18);
 const {contentEvent}=await import('./protocol.mjs');
 const e=contentEvent(decodePackets(encodePacket(18,f.fields))[0],{broadcasterId:'lab0'});
 d.accept({...e,room:{bjId:'lab0',chatNumber:1000},receivedAt:new Date().toISOString()});
 await assert.rejects(d.drain(),/enqueue_failed/);
});

for(const [name,line]of [['unexpected replacement',JSON.stringify({kind:'replacement',config:{accessToken:'do-not-print-this-marker'}})],['oversize input','x'.repeat(32769)],['expired token',JSON.stringify({kind:'start',mode:'handoff-probe',config:{...configFor(),accessToken:'do-not-print-this-marker',providerTokenExpiresAt:'2000-01-01T00:00:00Z'}})]])test('pipe entry rejects '+name+' without disclosing input',async()=>{
 const p=spawn(process.execPath,[fileURLToPath(new URL('./handoff-probe-entry.mjs',import.meta.url))],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 let output='';p.stdout.on('data',x=>output+=x);p.stderr.on('data',x=>output+=x);
 const finished=new Promise((resolve,reject)=>{p.once('error',reject);p.once('exit',resolve)});
 p.stdin.end(line+'\n');
 assert.equal(await finished,2);assert.doesNotMatch(output,/do-not-print-this-marker|synthetic-token|synthetic-secret/);assert.match(output,/probe_(?:input_)?rejected/);
});
