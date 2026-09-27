// Official SDK is an unchanged PRIVATE oracle, never part of the direct candidate.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {WebSocket,WebSocketServer} from '../../node_modules/ws/wrapper.mjs';
import {encodePacket,decodePackets,contentEvent,loginPacket,joinPacket} from './protocol.mjs';
import {configFor,infoFor,fixtures} from './fixtures.mjs';
import {classifySoopChatSdkCallback} from '../../services/soop-gateway/lib/soop-chat-gateway.js';
const sdkSource=fs.readFileSync(new URL('../../.local/soop-browserless-lab/sdk.js',import.meta.url),'utf8');
assert.equal(createHash('sha256').update(sdkSource).digest('hex'),'4d6974d882013e4cae2797010668855d3c2aeb0d2a8f711b08f65578c118a016');
test('direct authentication bytes and business event projections match pinned SDK',async t=>{
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.once('listening',r));
  const timers=new Set(),sockets=new Set(),messages=[],writes=[],errors=[];let ready=false,requests=[];
  t.after(async()=>{for(const h of timers){clearTimeout(h);clearInterval(h)}for(const s of sockets)s.terminate();for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r))});
  const until=async fn=>{const end=Date.now()+3000;while(!fn()){assert.ok(Date.now()<end,'oracle timeout');await new Promise(r=>setTimeout(r,5))}};
  let upstream;
  server.on('connection',s=>{upstream=s;s.on('message',data=>{const p=decodePackets(data)[0];writes.push(Buffer.from(data));if(p.code===16)s.send(encodePacket(1,['lab0','4|0']));if(p.code===2)s.send(encodePacket(2,['1000','lab0','0','20',']']))})});
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,URL,URLSearchParams,TextEncoder,TextDecoder,console:{log(){},info(){},warn(){},error(){},debug(){}},
    setInterval:(fn,ms)=>{const h=setInterval(fn,ms);timers.add(h);return h},clearInterval,
    setTimeout:(fn,ms)=>{const h=setTimeout(fn,ms);timers.add(h);return h},clearTimeout,
    fetch:async(url,options)=>{requests.push({url,options});return {status:200,json:async()=>infoFor()}},
    WebSocket:class extends WebSocket{constructor(url,protocol){assert.equal(url.toLowerCase(),'wss://chat-7f000001.sooplive.com:8001/websocket/lab0');super('ws://127.0.0.1:'+server.address().port,protocol);sockets.add(this)}}});
  new vm.Script(sdkSource).runInContext(context,{timeout:1500});
  const c=configFor(),sdk=new module.exports(c.clientId,c.clientSecret);
  sdk.handleReady(()=>ready=true);sdk.handleError(()=>errors.push('sdk_error'));sdk.handleChatClosed(()=>{});
  sdk.handleMessageReceived((action,message)=>{if(action!=='JOIN')messages.push({action,message})});
  sdk.setAuth(c.accessToken);await sdk.connect();await until(()=>ready);
  assert.equal(requests.length,1);assert.equal(requests[0].url,'https://openapi.sooplive.com/broad/access/chatinfo');
  assert.equal(new URLSearchParams(requests[0].options.body).get('access_token'),c.accessToken);
  assert.deepEqual(writes[0],loginPacket(c.accessToken));
  assert.deepEqual(writes[1],joinPacket({chatNumber:1000,ticket:'synthetic-ticket-lab0'},c.clientId,c.clientSecret));
  const cases=fixtures();
  for(const count of [1,9,10,49,50,99,100,499,500,999,1000]){const f={...fixtures()[2],fields:[...fixtures()[2].fields]};f.fields[3]=String(count);cases.push(f)}
  for(const f of cases)upstream.send(encodePacket(f.code,f.fields));
  await until(()=>messages.length===cases.length);
  const project=(e,i)=>{const classified=classifySoopChatSdkCallback({...e,receivedAt:'2026-09-23T00:00:00Z',connection:{id:'synthetic-connection',sequence:i+1,reconnectCount:0}});return classified.kind==='event'?JSON.parse(JSON.stringify({kind:classified.kind,event:classified.value.relay.event,type:classified.value.relay.eventType})):JSON.parse(JSON.stringify(classified))};
  cases.forEach((f,i)=>{const direct=contentEvent(decodePackets(encodePacket(f.code,f.fields))[0],{broadcasterId:'lab0'});assert.deepEqual(project(direct,i),project(messages[i],i),f.name+' '+f.fields[3])});
  assert.deepEqual(errors,[]);
  // Build independent wire headers: encodePacket emits a 15-byte keepalive and
  // previously hid the zero-body contract used by the provider.
  const empty=code=>Buffer.from('\x1b\t'+String(code).padStart(4,'0')+'00000000');
  for(const code of [0,88])assert.equal(decodePackets(empty(code))[0].code,code);
  upstream.send(empty(0));upstream.send(encodePacket(5,fixtures()[0].fields));
  await until(()=>messages.length===cases.length+1);
  upstream.send(empty(88));await until(()=>requests.length===2);
  assert.deepEqual(errors,[]);
});
