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
 assert(r.reports.filter(x=>x.kind==='handoff_committed').every(x=>x.basis==='content_matched'&&x.contentVerified));
});
for(const mode of ['reject','mismatch','quiet'])test(mode+' replacement retains active socket without claiming a handoff',async t=>{
 const r=await setup(t,mode);assert.equal(r.phase,0);assert.equal(r.result.cleanupComplete,true);assert(r.reports.some(x=>x.kind==='handoff_blocked'&&x.oldPreserved));assert(r.selected>0);
});
test('cross-account replacement is rejected before opening a second socket',async t=>{const r=await setup(t,'owner');assert.equal(r.maxSockets,1);assert.equal(r.result.reason,'replacement_owner_or_application_mismatch');assert.equal(r.result.cleanupComplete,true)});
test('provider eviction of active socket is a failure, not a successful switch',async t=>{const r=await setup(t,'evict');assert.equal(r.phase,0);assert.equal(r.result.reason,'socket_closed');assert.equal(r.result.cleanupComplete,true)});

async function quietSetup(t,mode='healthy'){
 const server=new WebSocketServer({host:'127.0.0.1',port:0,autoPong:false});await new Promise(r=>server.once('listening',r));
 const abort=new AbortController(),reports=[],timers=[],sockets=[];let replace,maxSockets=0,frames=0;
 const cfg={...configFor(),salt:'synthetic-salt'.repeat(4),durationMs:2500,providerTokenExpiresAt:new Date(Date.now()+60000).toISOString()};
 const gift=fixtures().find(f=>f.code===18),send=s=>{if(s.readyState===1)s.send(encodePacket(18,gift.fields))};
 t.after(async()=>{abort.abort();for(const h of timers)clearTimeout(h);for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r))});
 server.on('connection',s=>{
  sockets.push(s);maxSockets=Math.max(maxSockets,server.clients.size);s.pongs=0;
  s.on('ping',data=>{
   if(mode==='no-pong')return;
   if(mode==='stale-pong'&&s.pongs++)return;
   s.pong(mode==='wrong-pong'?Buffer.from('unrelated'):data);
  });
  s.on('message',b=>{const p=decodePackets(b)[0];
   if(p.code===16){s.token=p.fields[0];s.send(encodePacket(1))}
   if(p.code===2){s.send(encodePacket(2,[mode==='other-broadcast'&&s.token!==cfg.accessToken?'1001':'1000','lab0']));
    if(mode==='warmup-content'&&s.token!==cfg.accessToken)send(sockets[0]);
   }
  });
 });
 class Transport extends WebSocket{constructor(url,p,o){super('ws://127.0.0.1:'+server.address().port+new URL(url).pathname,p,o)}}
 const result=await observeRolling(cfg,{WebSocketImpl:Transport,signal:abort.signal,
  timing:{settleMs:50,overlapMs:120,attemptMs:700,pollMs:5,maxFrames:100,healthFreshMs:80,probeMs:20,probeTimeoutMs:30},
  fetchImpl:async(_u,o)=>{const info=infoFor();if(mode==='other-broadcast'&&new URLSearchParams(o.body).get('access_token')!==cfg.accessToken)info.data[0].chat_no=1001;return new Response(JSON.stringify(info))},
  subscribeReplacement:fn=>{replace=fn;return()=>{replace=null}},onReport:r=>{
   reports.push(r);
   if(r.kind==='ready')timers.push(setTimeout(()=>replace({...cfg,accessToken:'synthetic-new-token',providerTokenExpiresAt:new Date(Date.now()+600000).toISOString()}),30));
   if(r.kind==='handoff_overlap_started'&&mode==='one-sided')timers.push(setTimeout(()=>send(sockets[0]),80));
   if(r.kind==='handoff_committed'){
    // First post-switch donation is delivered by both live transports at the
    // boundary, but only the new authoritative leg may emit it.
    for(const s of sockets)send(s);
   }
   if(r.kind==='frame'){frames++;if(reports.some(x=>x.kind==='handoff_committed'))timers.push(setTimeout(()=>abort.abort(),30));}
   if(r.kind==='handoff_blocked')timers.push(setTimeout(()=>{send(sockets[0]);timers.push(setTimeout(()=>abort.abort(),30))},20));
  }});
 return {result,reports,frames,maxSockets};
}
test('quiet handoff requires post-join correlated pong, records unverified content and receives first later gift exactly once',async t=>{
 const r=await quietSetup(t);const h=r.reports.find(x=>x.kind==='handoff_committed');
 assert(h);assert.equal(h.basis,'quiet_transport_verified');assert.equal(h.contentVerified,false);assert.equal(h.matched,0);
 assert.equal(r.frames,1);assert.equal(r.result.counts.BALLOON_GIFTED,1);assert.equal(r.maxSockets,2);assert.equal(r.result.cleanupComplete,true);
 assert(!JSON.stringify(r.reports).includes('synthetic-new-token'));
});
for(const mode of ['no-pong','wrong-pong','stale-pong','one-sided','warmup-content','other-broadcast'])test('quiet switch is blocked for '+mode+' while active connection survives',async t=>{
 const r=await quietSetup(t,mode);assert(!r.reports.some(x=>x.kind==='handoff_committed'));
 assert(r.reports.some(x=>x.kind==='handoff_blocked'&&x.oldPreserved));assert(r.frames>0);assert.equal(r.result.cleanupComplete,true);
});
