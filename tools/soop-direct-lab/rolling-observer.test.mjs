import test from 'node:test';import assert from 'node:assert/strict';
import {WebSocket,WebSocketServer} from '../../node_modules/ws/wrapper.mjs';
import {observeRolling} from './rolling-observer.mjs';import {configFor,infoFor,fixtures} from './fixtures.mjs';import {decodePackets,encodePacket} from './protocol.mjs';
const timing={settleMs:20,overlapMs:80,attemptMs:400,pollMs:5,maxFrames:100};
async function setup(t,mode='normal'){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 let replace,activeToken='synthetic-token-lab0',maxSockets=0,selected=0,produced=0,phase=0;const reports=[],sockets=new Map(),abort=new AbortController(),timers=[];
 const cfg={...configFor(),salt:'synthetic-salt'.repeat(4),durationMs:3000,providerTokenExpiresAt:new Date(Date.now()+80).toISOString()};
 let loop;
 t.after(async()=>{abort.abort();for(const h of timers)clearTimeout(h);clearInterval(loop);for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r))});
 server.on('connection',s=>{
  maxSockets=Math.max(maxSockets,server.clients.size);
  s.on('message',b=>{const p=decodePackets(b)[0];if(p.code===16){s.token=p.fields[0];sockets.set(s.token,s);s.send(encodePacket(1))}
   if(p.code===2){if(mode==='reject'&&s.token!==cfg.accessToken){s.send(encodePacket(2,[],1));return}s.send(encodePacket(2,['1000','lab0']));s.joined=true;
    if(mode==='evict'&&s.token!==cfg.accessToken)sockets.get(cfg.accessToken)?.close();
   }
  });
 });
 class Transport extends WebSocket{constructor(url,p,o){super('ws://127.0.0.1:'+server.address().port+new URL(url).pathname,p,o)}}
 const next=n=>({...cfg,accessToken:'synthetic-replacement-'+n,providerTokenExpiresAt:new Date(Date.now()+600000*n).toISOString()});
 const send=()=>{if(!sockets.get(activeToken)?.joined||sockets.get(activeToken)?.readyState!==1)return;
  const f=fixtures().find(f=>f.code===18);
  for(let i=0;i<2;i++){produced++;for(const s of sockets.values())if(s.readyState===1&&s.joined){const fields=[...f.fields];if(mode==='mismatch'&&s.token!==cfg.accessToken)fields[3]='999';s.send(encodePacket(18,fields))}}
 };
 const task=observeRolling(cfg,{WebSocketImpl:Transport,fetchImpl:async()=>new Response(JSON.stringify(infoFor())),signal:abort.signal,timing,subscribeReplacement:fn=>{replace=fn;return()=>{replace=null}},onReport:r=>{
  reports.push(r);if(r.kind==='frame'){selected++;if(phase===2&&selected===produced)queueMicrotask(()=>abort.abort())}
  if(r.kind==='ready'){
   loop=setInterval(send,25);
   // The initial OAuth expiry passes while its joined socket remains healthy.
   timers.push(setTimeout(()=>replace(mode==='owner'?{...next(1),broadcasterId:'lab1'}:next(1)),150));
  }
  if(r.kind==='handoff_overlap_started'&&mode==='quiet')clearInterval(loop);
  if(r.kind==='handoff_committed'){
   phase++;activeToken='synthetic-replacement-'+phase;
   if(phase===1)timers.push(setTimeout(()=>replace(next(2)),70));
   else {clearInterval(loop);send()}
  }
  if(r.kind==='handoff_blocked'){
   if(mode==='quiet')loop=setInterval(send,25);
   timers.push(setTimeout(()=>{clearInterval(loop);abort.abort()},80));
  }
 }});
 const result=await task;clearInterval(loop);return {result,reports,maxSockets,selected,produced,phase};
}
test('rolling observation holds expired-token socket, switches twice, preserves identical repeated gifts and reclaims old sockets',async t=>{
 const r=await setup(t);assert.equal(r.phase,2);assert.equal(r.maxSockets,2);assert.equal(r.selected,r.produced);assert.equal(r.result.counts.BALLOON_GIFTED,r.produced);assert.equal(r.result.cleanupComplete,true);assert.equal(r.reports.filter(x=>x.kind==='ready').length,1);assert.equal(r.result.reason,'supervisor_stopped');assert(!JSON.stringify(r.reports).includes('synthetic-replacement'));
});
for(const mode of ['reject','mismatch','quiet'])test(mode+' replacement retains active socket without claiming a handoff',async t=>{
 const r=await setup(t,mode);assert.equal(r.phase,0);assert.equal(r.result.cleanupComplete,true);assert(r.reports.some(x=>x.kind==='handoff_blocked'&&x.oldPreserved));assert(r.selected>0);
});
test('cross-account replacement is rejected before opening a second socket',async t=>{const r=await setup(t,'owner');assert.equal(r.maxSockets,1);assert.equal(r.result.reason,'replacement_owner_or_application_mismatch');assert.equal(r.result.cleanupComplete,true)});
test('provider eviction of active socket is a failure, not a successful switch',async t=>{const r=await setup(t,'evict');assert.equal(r.phase,0);assert.equal(r.result.reason,'socket_closed');assert.equal(r.result.cleanupComplete,true)});
