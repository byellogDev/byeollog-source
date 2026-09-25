import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket,WebSocketServer} from '../../node_modules/ws/wrapper.mjs';
import {encodePacket,decodePackets,contentEvent,joinPacket} from './protocol.mjs';
import {loadRoom,runDirect} from './client.mjs';
import {configFor,infoFor,fixtures} from './fixtures.mjs';
const response=value=>new Response(JSON.stringify(value));
test('UTF-8 lengths, combined frames, empty keepalive and strict malformed rejection',()=>{
  const b=encodePacket(5,['한글🙂','x']);assert.equal(Number(b.subarray(6,12).toString()),b.length-14);
  assert.equal(decodePackets(b)[0].fields[0],'한글🙂');assert.equal(decodePackets(Buffer.concat([b,b])).length,2);
  assert.deepEqual(decodePackets(encodePacket(0))[0].fields,[]);
  const invalidHeader=Buffer.from(b);invalidHeader[0]=0;
  const invalidUtf=Buffer.from(b);invalidUtf[15]=255;
  for(const bad of [b.subarray(0,-1),Buffer.concat([b,Buffer.from('x')]),invalidHeader,invalidUtf,Buffer.alloc(65537)])assert.throws(()=>decodePackets(bad));
  assert.throws(()=>encodePacket(16,['secret\fextra']));assert.throws(()=>joinPacket({chatNumber:1,ticket:'t'},'client','secret\x11extra'));
});
for(const f of fixtures())test('supported event: '+f.name,()=>assert.ok(contentEvent(decodePackets(encodePacket(f.code,f.fields))[0],{broadcasterId:'lab0'})));
test('wrong owner, invalid money, truncated donation and aggregate guard',()=>{
  const f=fixtures().find(x=>x.code===18),parse=fields=>contentEvent(decodePackets(encodePacket(18,fields))[0],{broadcasterId:'lab0'});
  assert.throws(()=>parse(['other',...f.fields.slice(1)]),/owner/);
  for(const x of ['0','-1','1.5','NaN','9007199254740992']){const a=[...f.fields];a[3]=x;assert.throws(()=>parse(a),/count/)}
  assert.throws(()=>parse(['lab0']),/missing/);
  assert.equal(contentEvent({code:125,ret:0,fields:['{}']},{broadcasterId:'lab0'}),null);
  assert.throws(()=>contentEvent({code:121,ret:0,fields:['{}']},{broadcasterId:'lab0'}),/unknown_mission/);
});
test('official OAuth endpoint only, bounded body and destination from checked identity',async()=>{
  const config=configFor();let seen;
  const r=await loadRoom(config,{fetchImpl:async(u,o)=>{seen={u,o};return response(infoFor())}});
  assert.equal(seen.u,'https://openapi.sooplive.com/broad/access/chatinfo');assert.equal(seen.o.redirect,'error');
  assert.equal(new URLSearchParams(seen.o.body).get('access_token'),config.accessToken);
  assert.equal(r.url,'wss://chat-7f000001.sooplive.com:8001/Websocket/lab0');
  await assert.rejects(loadRoom(config,{fetchImpl:async()=>response(infoFor('other'))}),/owner/);
  await assert.rejects(loadRoom(config,{fetchImpl:async()=>new Response('x'.repeat(65537))}),/too_large/);
  for(const ip of ['127.0.0.999','example.com','1.2.3.4/path']){const v=infoFor();v.data[0].chat_ip=ip;await assert.rejects(loadRoom(config,{fetchImpl:async()=>response(v)}),/address/)}
  await assert.rejects(loadRoom(config,{fetchImpl:async()=>response({result:-1302,data:[]})}),/broadcast_offline/);
  await assert.rejects(loadRoom(config,{fetchImpl:async()=>response({result:-999,data:[]})}),/provider_rejected/);
});
async function harness(t,handler){
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  t.after(async()=>{for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r))});
  const outbound=[];
  server.on('connection',(s,request)=>s.on('message',data=>{const p=decodePackets(data)[0];outbound.push(p.code);handler(s,p,request)}));
  class Transport extends WebSocket{constructor(url,protocol,opts){const u=new URL(url);assert.match(u.hostname,/^chat-[0-9a-f]{8}\.sooplive\.com$/);super('ws://127.0.0.1:'+server.address().port+u.pathname,protocol,opts)}}
  return {Transport,outbound};
}
const normalJoin=(s,p,owner='lab0')=>{if(p.code===16)s.send(encodePacket(1,[owner,'4|0']));if(p.code===2)s.send(encodePacket(2,['1000',owner,'0','20',']']))};
test('two isolated accounts, ordered events, identical donations kept and only auth/control writes',async t=>{
  const h=await harness(t,(s,p,req)=>{const id=req.url.split('/').at(-1);normalJoin(s,p,id);if(p.code===2){for(const f of fixtures(id))s.send(encodePacket(f.code,f.fields));const f=fixtures(id)[2];s.send(encodePacket(f.code,f.fields))}});
  const all=await Promise.all(['lab0','lab1'].map(async id=>{const events=[];const r=await runDirect({...configFor(id),durationMs:150},{fetchImpl:async()=>response(infoFor(id)),WebSocketImpl:h.Transport,onEvent:e=>events.push(e)});return {r,events,id}}));
  for(const {r,events,id}of all){assert.equal(r.reason,'duration_reached');assert.equal(r.ready,true);assert.equal(events.length,14);assert.ok(events.every(e=>e.room.bjId===id));assert.deepEqual(events.map(e=>e.sequence),Array.from({length:14},(_,i)=>i+1));assert.equal(r.counts.BALLOON_GIFTED,5)}
  assert.ok(h.outbound.every(c=>[0,16,2].includes(c)));
});
for(const [name,code,ret,fields,expected]of [
  ['login rejection',1,1,[],'login_rejected'],['unsolicited join',2,0,['1000','lab0'],'unexpected_join_ack'],['early content',5,0,fixtures()[0].fields,'content_before_ready']
])test(name,async t=>{const h=await harness(t,(s,p)=>{if(p.code===16)s.send(encodePacket(code,fields,ret))});const r=await runDirect(configFor(),{fetchImpl:async()=>response(infoFor()),WebSocketImpl:h.Transport});assert.equal(r.reason,expected);assert.equal(r.ready,false)});
for(const [id,ret,expected]of [['other',0,'join_owner_mismatch'],['lab0',1,'join_rejected']])test(expected,async t=>{const h=await harness(t,(s,p)=>{if(p.code===16)s.send(encodePacket(1,['lab0','4|0']));else if(p.code===2)s.send(encodePacket(2,['1000',id],ret))});const r=await runDirect(configFor(),{fetchImpl:async()=>response(infoFor()),WebSocketImpl:h.Transport});assert.equal(r.reason,expected)});
test('idle room without pong remains connected and receives later chat',async t=>{
  const reports=[],events=[];let pings=0,late;
  const h=await harness(t,(s,p)=>{s._autoPong=false;normalJoin(s,p);if(p.code===2){s.on('ping',()=>pings++);late=setTimeout(()=>{const f=fixtures()[0];if(s.readyState===1)s.send(encodePacket(f.code,f.fields))},220)}});
  t.after(()=>clearTimeout(late));
  const r=await runDirect({...configFor(),durationMs:350},{fetchImpl:async()=>response(infoFor()),WebSocketImpl:h.Transport,timing:{pingMs:20,idleMs:60,telemetryMs:10},onReport:e=>reports.push(e),onEvent:e=>events.push(e)});
  assert.equal(r.reason,'duration_reached');assert.equal(events.length,1);assert.equal(pings,0);
  const idle=reports.findIndex(e=>e.receiveState==='idle_unconfirmed');assert.ok(idle>=0);
  assert.ok(reports.slice(idle+1).some(e=>e.receiveState==='receiving'&&e.events===1));
  assert.ok(h.outbound.filter(c=>c===0).length>=3);
});
for(const mode of ['failure','timeout','backpressure'])test('keepalive write '+mode+' stops candidate',async t=>{
  const h=await harness(t,(s,p)=>normalJoin(s,p));
  class Broken extends h.Transport{
    send(data,callback){
      if(decodePackets(data)[0].code===0){if(mode==='failure')queueMicrotask(()=>callback(Error('synthetic')));return}
      return super.send(data,callback);
    }
    get bufferedAmount(){return mode==='backpressure'&&this.block?300000:super.bufferedAmount}
  }
  let transport;
  class Tracked extends Broken{constructor(...args){super(...args);transport=this}}
  const r=await runDirect({...configFor(),durationMs:500},{fetchImpl:async()=>response(infoFor()),WebSocketImpl:Tracked,timing:{pingMs:20,writeMs:40},onReport:e=>{if(e.kind==='ready')transport.block=true}});
  assert.equal(r.reason,mode==='failure'?'write_failed':mode==='timeout'?'write_timeout':'write_backpressure');assert.equal(r.ready,true);
});
test('explicit socket close, broadcast close and supervisor abort still stop',async t=>{
  const closed=await harness(t,(s,p)=>{normalJoin(s,p);if(p.code===2)setTimeout(()=>s.close(1000),20)});
  let r=await runDirect(configFor(),{fetchImpl:async()=>response(infoFor()),WebSocketImpl:closed.Transport});assert.equal(r.reason,'socket_closed');
  const h=await harness(t,(s,p)=>normalJoin(s,p));
  const a=new AbortController();r=await runDirect(configFor(),{fetchImpl:async()=>response(infoFor()),WebSocketImpl:h.Transport,signal:a.signal,onReport:e=>{if(e.kind==='ready')a.abort()}});assert.equal(r.reason,'supervisor_stopped');
  const b=await harness(t,(s,p)=>{normalJoin(s,p);if(p.code===2)s.send(encodePacket(88))});r=await runDirect(configFor(),{fetchImpl:async()=>response(infoFor()),WebSocketImpl:b.Transport});assert.equal(r.reason,'broadcast_closed');
});
test('401 cannot open socket or disclose credentials',async()=>{
  const c=configFor();const r=await runDirect(c,{fetchImpl:async()=>new Response('',{status:401}),WebSocketImpl:class{constructor(){assert.fail('socket must not open')}}});
  assert.equal(r.reason,'auth_rejected');assert.ok(!JSON.stringify(r).includes(c.accessToken));assert.ok(!JSON.stringify(r).includes(c.clientSecret));
});
