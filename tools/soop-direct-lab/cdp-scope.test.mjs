import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createSocketScope,inspectSocketInventory} from './cdp-scope.mjs';
const created=(requestId,url)=>({method:'Network.webSocketCreated',params:{requestId,url}});
const frame=id=>({method:'Network.webSocketFrameReceived',params:{requestId:id}});
const closed=id=>({method:'Network.webSocketClosed',params:{requestId:id}});
const url='wss://chat-7f000001.sooplive.com:8001/Websocket/lab0';
test('existing dedicated socket binds once; unrelated created sockets never enter parser or close it',()=>{
 const s=createSocketScope('lab0');assert.equal(s.accept(frame('old')),false);
 s.authorize({total:1,matched:1,open:1});assert.equal(s.accept(frame('old')),true);
 assert.equal(s.accept(created('other','wss://example.com/')),false);
 assert.equal(s.accept(frame('other')),false);assert.equal(s.accept(closed('other')),false);
 assert.equal(s.accept(frame('unknown-second')),false);assert.equal(s.accept(closed('old')),true);
 assert.throws(()=>s.accept(created('replacement',url)),/socket_replaced/);
});
test('unrelated socket can be created before the existing socket produces its first frame',()=>{
 const s=createSocketScope('lab0');s.authorize({total:1,matched:1,open:1});
 assert.equal(s.accept(closed('old-already-closed')),false);
 s.accept(created('other','wss://example.com/'));assert.equal(s.accept(frame('other')),false);
 assert.equal(s.accept(frame('original')),true);
});
test('inventory proof fails closed for extra sockets, wrong account or closing connection',()=>{
 for(const inventory of [null,{total:2,matched:1,open:1},{total:1,matched:0,open:0},{total:1,matched:1,open:0}])assert.throws(()=>createSocketScope('lab0').authorize(inventory),/inventory/);
 const s=createSocketScope('lab0');s.accept(created('original',url));s.authorize({total:1,matched:1,open:1});assert.equal(s.accept(frame('original')),true);assert.equal(s.accept(frame('other')),false);
});
test('runtime inventory checks actual socket URL and state and always releases remote objects',async()=>{
 let declaration,released=0;
 const client={async send(method,p){
  if(method==='Runtime.evaluate')return {result:{objectId:'prototype'}};
  if(method==='Runtime.queryObjects')return {objects:{objectId:'objects'}};
  if(method==='Runtime.callFunctionOn'){declaration=p.functionDeclaration;const f=vm.runInNewContext('('+declaration+')',{URL});return {result:{value:f.call([{url,readyState:1},{url:'wss://old.invalid',readyState:3}],p.arguments[0].value)}}}
  if(method==='Runtime.releaseObjectGroup')released++;
 }};
 assert.deepEqual(JSON.parse(JSON.stringify(await inspectSocketInventory(client,'lab0'))),{total:1,matched:1,open:1});assert.equal(released,1);
 const f=vm.runInNewContext('('+declaration+')',{URL});
 for(const other of ['wss://chat-7f000001.sooplive.com:8001/Websocket/lab1','wss://chat-7f000001.sooplive.com.evil/Websocket/lab0',url+'?token=private'])assert.equal(f.call([{url:other,readyState:1}],'lab0').matched,0);
});
