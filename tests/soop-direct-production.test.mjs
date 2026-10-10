import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {WebSocket,WebSocketServer} from 'ws';
import {runSoopDirectSession} from '../services/soop-gateway/services/soop-chat-gateway/direct/session.mjs';
import {parseTransportPolicy,reconcileTransportWorkers,readTransportPolicy} from '../services/soop-gateway/services/soop-chat-gateway/transport-policy.mjs';
import {EncryptedGatewayOutbox} from '../services/soop-gateway/services/soop-chat-gateway/outbox.mjs';
import {createCandidateDelivery} from '../tools/soop-direct-lab/delivery-candidate.mjs';
import {configFor,infoFor,fixtures} from '../tools/soop-direct-lab/fixtures.mjs';
import {encodePacket,decodePackets} from '../tools/soop-direct-lab/protocol.mjs';

test('production kernel exactly matches reviewed research sources',()=>{
 execFileSync(process.execPath,['tools/build-soop-direct-runtime.mjs','--check']);
});
test('transport policy is explicit, rejects corrupt/duplicate identities, and defaults SDK',async t=>{
 const p=await fs.mkdtemp(join(tmpdir(),'byeollog-policy-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));
 assert.equal((await readTransportPolicy(p)).size,0);
 for(const x of [{},{schemaVersion:1,directWorkspaceIds:['all']},{schemaVersion:1,directWorkspaceIds:['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000001']}])assert.throws(()=>parseTransportPolicy(x));
 await fs.writeFile(join(p,'transport-policy.json'),'{bad');await assert.rejects(readTransportPolicy(p));
});
test('SDK -> direct -> SDK switch waits for old durable drain and never overlaps writers',async()=>{
 const workers=new Map(),enabled=new Set(['a','b']),events=[];let activeA=0,maxA=0,releaseDrain;
 const run=async(id,signal,mode)=>{
  if(id==='a'){activeA++;maxA=Math.max(maxA,activeA)}events.push('start:'+id+':'+mode);
  await new Promise(r=>signal.addEventListener('abort',r,{once:true}));
  if(id==='a'&&mode==='sdk')await new Promise(r=>releaseDrain=r);
  if(id==='a')activeA--;events.push('stop:'+id+':'+mode);
 };
 const opts={workers,enabled,run};await reconcileTransportWorkers({...opts,direct:new Set()});await Promise.resolve();
 const other=workers.get('b');const switching=reconcileTransportWorkers({...opts,direct:new Set(['a'])});
 await new Promise(r=>setTimeout(r,10));assert(!events.includes('start:a:direct'));releaseDrain();await switching;await Promise.resolve();
 assert.equal(workers.get('b'),other);assert.equal(workers.get('a').transport,'direct');
 await reconcileTransportWorkers({...opts,direct:new Set()});await Promise.resolve();
 assert.equal(workers.get('a').transport,'sdk');assert.equal(maxA,1);
 const stop=reconcileTransportWorkers({...opts,enabled:new Set(),direct:new Set()});await new Promise(r=>setTimeout(r,10));releaseDrain();await stop;
 assert.equal(workers.size,0);assert.equal(activeA,0);
});

test('default direct covers new accounts and explicit SDK rollback preserves other workers',async()=>{
 const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002';
 const policy={schemaVersion:2,defaultTransport:'direct',directWorkspaceIds:[],sdkWorkspaceIds:[]};
 const all=parseTransportPolicy(policy),workers=new Map(),enabled=new Set([a]);
 const run=async(id,signal)=>new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
 await reconcileTransportWorkers({workers,enabled,direct:all,run});await Promise.resolve();
 const first=workers.get(a);assert.equal(first.transport,'direct');
 enabled.add(b);await reconcileTransportWorkers({workers,enabled,direct:all,run});await Promise.resolve();
 assert.equal(workers.get(a),first);assert.equal(workers.get(b).transport,'direct');
 const second=workers.get(b),rollback=parseTransportPolicy({...policy,sdkWorkspaceIds:[a]});
 await reconcileTransportWorkers({workers,enabled,direct:rollback,run});await Promise.resolve();
 assert.equal(workers.get(a).transport,'sdk');assert.equal(workers.get(b),second);
 await reconcileTransportWorkers({workers,enabled,direct:all,run});await Promise.resolve();
 assert.equal(workers.get(a).transport,'direct');assert.equal(workers.get(b),second);
 await reconcileTransportWorkers({workers,enabled:new Set(),direct:all,run});assert.equal(workers.size,0);
 const legacy=parseTransportPolicy({schemaVersion:1,directWorkspaceIds:[a]});
 assert(legacy.has(a));assert(!legacy.has(b));
 const sdkDefault=parseTransportPolicy({...policy,defaultTransport:'sdk',directWorkspaceIds:[a]});
 assert(sdkDefault.has(a));assert(!sdkDefault.has(b));
});

test('default transport rejects ambiguous or malformed rollback policy',()=>{
 const id='00000000-0000-4000-8000-000000000001';
 const valid={schemaVersion:2,defaultTransport:'direct',directWorkspaceIds:[],sdkWorkspaceIds:[]};
 for(const p of [{...valid,defaultTransport:'auto'},{...valid,sdkWorkspaceIds:null},{...valid,directWorkspaceIds:null},{...valid,sdkWorkspaceIds:['all']},{...valid,sdkWorkspaceIds:[id,id]},{...valid,directWorkspaceIds:[id],sdkWorkspaceIds:[id]},{...valid,schemaVersion:3}])assert.throws(()=>parseTransportPolicy(p));
});

async function runFixture(t,{mode='normal',onEvent=()=>{}}={}){
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
 const stop=new AbortController(),sockets=[],logs=[],states=[],events=[];let sends=0,handoffs=0,polls=0,maxSockets=0,next=0;
 const cfg={...configFor(),providerTokenExpiresAt:new Date(Date.now()+20000).toISOString()};
 const timers=[];let loop;
 t.after(async()=>{stop.abort();clearInterval(loop);for(const h of timers)clearTimeout(h);for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r))});
 const gift=fixtures().find(f=>f.code===18);
 server.on('connection',s=>{
  sockets.push(s);maxSockets=Math.max(maxSockets,server.clients.size);
  s.on('message',b=>{const p=decodePackets(b)[0];
   if(p.code===16)s.send(encodePacket(1));
   if(p.code===2){s.send(encodePacket(2,['1000',mode==='wrong-room'?'lab1':'lab0']));s.joined=true}
  });
 });
 class Transport extends WebSocket{constructor(url,p,o){super('ws://127.0.0.1:'+server.address().port+new URL(url).pathname,p,o)}}
 const send=()=>{const open=sockets.filter(s=>s.joined&&s.readyState===1);if(!open.length)return;sends++;for(const s of open)s.send(encodePacket(18,gift.fields))};
 const args={...cfg,expectedBroadcasterId:cfg.broadcasterId,signal:stop.signal,WebSocketImpl:Transport,
  timing:{settleMs:10,overlapMs:60,attemptMs:400,pollMs:5,maxFrames:200},credentialPollMs:20,durationMs:2500,
  fetchImpl:async()=>new Response(JSON.stringify(mode==='offline'?{result:-1302}:infoFor())),
  getCredentials:async()=>{
   polls++;if(mode==='revoked')throw Object.assign(Error('revoked'),{code:'soop_connection_missing'});
   if(polls===1)throw Error('temporary unavailable');
   return {...cfg,providerAccountId:mode==='wrong-token-owner'?'lab1':cfg.broadcasterId,accessToken:'synthetic-new-'+next,providerTokenExpiresAt:new Date(Date.now()+600000*(next+1)).toISOString()};
  },
  onEvent:e=>{events.push(e);onEvent(e)},
  onState:e=>{states.push(e);loop=setInterval(send,15)},
  onDiagnostic:e=>{logs.push(e);
   // Deliver the success fixture after both legs enter their comparison window.
   // A frame straddling warmup is correctly refused, covered by rolling tests.
   if(e.kind==='handoff_preparing')clearInterval(loop);
   if(e.kind==='handoff_overlap_started')timers.push(setTimeout(()=>{send();loop=setInterval(send,15)},35));
   if(e.kind==='handoff_committed'){handoffs++;next++;if(handoffs===2){clearInterval(loop);send();timers.push(setTimeout(()=>{for(const s of sockets)if(s.readyState===1)s.send(encodePacket(88,[]))},30))}}
  }
 };
 let result,error;try{result=await runSoopDirectSession(args)}catch(e){error=e}
 clearInterval(loop);return {result,error,events,logs,states,sends,handoffs,maxSockets,remaining:server.clients.size};
}
test('production session selects one stream across two replacements; encrypted retry/restart preserves repeated gifts',async t=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'byeollog-direct-prod-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const options={directory,secret:'synthetic-secret-for-encrypted-production-flow',baseRetryMs:1,maxRetryMs:1};
 const box=new EncryptedGatewayOutbox(options);await box.init();
 const delivery=createCandidateDelivery({workspaceId:'synthetic-a',instanceId:'synthetic-instance',logicalConnectionId:'synthetic-direct-session',expectedBroadcasterId:'lab0',leaseToken:'synthetic-lease',outbox:box});
 const r=await runFixture(t,{onEvent:e=>delivery.accept({...e,receivedAt:e.at})});await delivery.drain();
 assert.equal(r.error,undefined);assert.equal(r.result.errorCode,'broadcast_offline',JSON.stringify(r.logs));assert.equal(r.handoffs,2);assert.equal(r.maxSockets,2);assert.equal(r.events.length,r.sends);
 assert.equal(r.states.length,1);assert.deepEqual(r.states[0].room,{bjId:'lab0',chatNumber:1000});
 assert(r.events.every(e=>e.at&&e.room.bjId==='lab0'));assert(r.logs.some(e=>e.kind==='credential_unavailable_keep_active'));
 assert.equal(await box.count(),r.sends);for(const f of await box.files())assert.doesNotMatch(await fs.readFile(join(directory,f),'utf8'),/synthetic-user|synthetic-lease/);
 await box.flush(async()=>{throw Object.assign(Error('temporary failure'),{status:503})});await new Promise(r=>setTimeout(r,10));
 const restarted=new EncryptedGatewayOutbox(options);await restarted.init();const sent=[];await restarted.flush(async b=>sent.push(b),{limit:1000});
 assert.equal(sent.length,r.sends);assert.equal(new Set(sent.map(b=>b.relay.event.eventId)).size,r.sends);assert.equal(await restarted.count(),0);
 assert.deepEqual(sent.map(b=>b.relay.connection.sequence),Array.from({length:r.sends},(_,i)=>i));
});
for(const mode of ['revoked','wrong-room','wrong-token-owner'])test('production '+mode+' stops without SDK or unsafe retry',async t=>{
 const r=await runFixture(t,{mode});assert(r.error?.directTerminal);assert.equal(r.handoffs,0);assert.equal(r.maxSockets,1);
 if(mode==='wrong-room')assert.equal(r.events.length,0);
});
test('offline broadcast uses waiting policy without opening a WebSocket',async t=>{
 const r=await runFixture(t,{mode:'offline'});assert.equal(r.error,undefined);assert.equal(r.result.errorCode,'broadcast_offline');assert.equal(r.maxSockets,0);
});
