import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {assertObserverPacket,assertObserverSocket,observe,observerDuration} from './shadow-observer.mjs';
const frame=code=>Buffer.from('\x1b\t'+String(code).padStart(4,'0')+'00000100\f');
test('long runs require an explicit supervisor ceiling, at most 48 hours',()=>{
  assert.equal(observerDuration(172800000),120000);
  assert.equal(observerDuration(172800000,172800000),172800000);
  assert.throws(()=>observerDuration(200000000,200000000),/invalid/);
});
test('only SDK login/join/keepalive may be sent',()=>{
  for(const code of [0,2,16])assert.doesNotThrow(()=>assertObserverPacket(frame(code)));
  for(const code of [1,5,9,11,18,26,95])assert.throws(()=>assertObserverPacket(frame(code)),/blocked/);
  assert.throws(()=>assertObserverPacket(Buffer.from('bad')),/blocked/);
});
test('only expected broadcaster at an official chat destination is allowed',()=>{
  assert.doesNotThrow(()=>assertObserverSocket('wss://chat-7f000001.sooplive.com:8001/Websocket/lab0','lab0'));
  for(const url of ['ws://chat-7f000001.sooplive.com/Websocket/lab0','wss://example.com/Websocket/lab0','wss://chat-7f000001.sooplive.com/Websocket/other','wss://chat-7f000001.sooplive.com/Websocket/lab0?token=test'])assert.throws(()=>assertObserverSocket(url,'lab0'));
});
test('expired auth never opens a socket and exposes no credentials',async()=>{
  let calls=0;const report=await observe({sdkSource:fs.readFileSync(new URL('../../.local/soop-browserless-lab/sdk.js',import.meta.url),'utf8'),broadcasterId:'lab0',clientId:'synthetic-client',clientSecret:'synthetic-private-value',accessToken:'synthetic-token',salt:'synthetic-hmac-key-for-lab-only-1234',durationMs:1000},{fetchImpl:async()=>{calls++;return {ok:false,status:401}},WebSocketImpl:class{constructor(){assert.fail('must not connect')}}});
  assert.equal(calls,1);assert.equal(report.ready,false);assert.equal(report.reason,'chatinfo_http_401');assert.equal(report.externalSocketAttempts,0);
  assert.equal(JSON.stringify(report).includes('synthetic-private-value'),false);assert.equal(JSON.stringify(report).includes('synthetic-token'),false);
});
test('different account chatinfo is rejected before a socket opens',async()=>{
  const report=await observe({sdkSource:fs.readFileSync(new URL('../../.local/soop-browserless-lab/sdk.js',import.meta.url),'utf8'),broadcasterId:'lab0',clientId:'synthetic-client',clientSecret:'synthetic-private-value',accessToken:'synthetic-token',salt:'synthetic-hmac-key-for-lab-only-1234',durationMs:1000},{fetchImpl:async()=>({ok:true,status:200,json:async()=>({result:1,data:[{id:'other'}]})}),WebSocketImpl:class{constructor(){assert.fail('must not connect')}}});
  assert.equal(report.reason,'chatinfo_owner_mismatch');assert.equal(report.externalSocketAttempts,0);
});
