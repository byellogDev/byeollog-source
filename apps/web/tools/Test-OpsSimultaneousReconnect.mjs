// Actual browser/session adapter in a disposable module copy. Substitute only
// SDK_URL and allow this fixture's loopback ws origin in the copy's CSP.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {WebSocketServer} from 'ws';
import {readFile,writeFile,mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {reduceSoopSdkSession} from '../lib/soop-sdk-relay.js';
const root=resolve('../.tmp');await mkdir(root,{recursive:true});const directory=await mkdtemp(join(root,'reconnect-'));
const server=createServer((req,res)=>{res.setHeader('Content-Type','application/javascript');res.end(sdk)});
const wss=new WebSocketServer({server});const clients=new Map();
wss.on('connection',(ws,req)=>{const room=new URL(req.url,'http://127.0.0.1').searchParams.get('room');clients.set(room,ws);ws.on('close',()=>{if(clients.get(room)===ws)clients.delete(room)});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const sdk=`window.SOOP={ChatSDK:class{constructor(id){this.id=id}handleReady(f){this.ready=f}handleMessageReceived(f){this.message=f}handleError(f){this.error=f}handleChatClosed(f){this.closed=f}getRoomInfo(){return {bjId:this.id,chatNumber:101}}setAuth(){}connect(){return new Promise(resolve=>{this.ws=new WebSocket('ws://127.0.0.1:${port}/?room='+encodeURIComponent(this.id));this.ws.onopen=()=>{this.ready({});resolve()};this.ws.onmessage=e=>this.message('BALLOON_GIFT',JSON.parse(e.data));this.ws.onclose=()=>this.closed();this.ws.onerror=()=>this.error('fixture_network_error','fixture')})}disconnect(){this.ws?.close()}}};`;
let adapter;const controllers=[];const report={startedAt:new Date().toISOString(),rows:[],passed:false,limitations:'Real local Chromium and WebSocket disconnects; fixture SDK, no real SOOP server, access tokens, gateway lease API or production DB. Production retry reducer is used; retry wall-clock waits accelerated to 30ms.'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f,timeout=30000){const end=Date.now()+timeout;while(!f()){if(Date.now()>end)throw Error('Fixture condition timed out');await pause(20)}}
try{
 const source=await readFile(new URL('../services/soop-chat-gateway/browser-session.mjs',import.meta.url),'utf8');const pattern=/const SDK_URL='[^']+';/g;assert.equal([...source.matchAll(pattern)].length,1);
 assert.equal(source.split('connect-src https: wss:;').length,2);
 const path=join(directory,'adapter.mjs');await writeFile(path,source.replace(pattern,`const SDK_URL='http://127.0.0.1:${port}/sdk.js';`).replace('connect-src https: wss:;',`connect-src https: wss: ws://127.0.0.1:${port};`));adapter=await import(pathToFileURL(path));
 for(const channels of [3,5,10,20]){
  const states=Array.from({length:channels},()=>({status:'idle'})),events=Array.from({length:channels},()=>[]);let peakReconnectMs=0;
  for(let round=0;round<3;round++){
   const start=performance.now();const promises=Array.from({length:channels},(_,i)=>{
    const controller=new AbortController();controllers.push(controller);states[i]=reduceSoopSdkSession(states[i],{type:'connect_requested'});
    return adapter.runSoopBrowserSession({clientId:'fixture-'+i,clientSecret:'synthetic',accessToken:'synthetic',expectedBroadcasterId:'fixture-'+i,signal:controller.signal,
     onState:s=>{if(s.state==='connected')states[i]=reduceSoopSdkSession(states[i],{type:'connected'})},
     onEvent:e=>{assert.equal(e.room.bjId,'fixture-'+i);events[i].push(e.message.fixtureId)}});
   });
   await until(()=>states.every(s=>s.status==='connected')&&clients.size===channels);peakReconnectMs=Math.max(peakReconnectMs,performance.now()-start);
   for(let i=0;i<channels;i++)for(let n=0;n<3;n++)clients.get('fixture-'+i).send(JSON.stringify({fixtureId:round*3+n,userId:'fixture-donor',userNickname:'fixture',count:1,message:''}));
   await until(()=>events.every(a=>a.length===(round+1)*3));
   // Terminate all local sockets together, including TCP without close frame.
   for(const ws of clients.values())ws.terminate();const ended=await Promise.all(promises);
   assert.ok(ended.every(r=>r.reason==='closed'&&r.ready));
   for(let i=0;i<channels;i++){states[i]=reduceSoopSdkSession(states[i],{type:'connection_closed'});assert.equal(states[i].status,'retry_wait');assert.ok(states[i].nextRetryMs>0&&states[i].nextRetryMs<=30000)}
   await until(()=>clients.size===0);await pause(30);
  }
  for(const a of events)assert.deepEqual(a,Array.from({length:9},(_,i)=>i));
  assert.ok(states.every(s=>s.reconnectCount===3));
  const row={channels,simultaneousDisconnectRounds:3,receivedEvents:channels*9,missing:0,duplicate:0,crossRoom:0,recoveredAfterDrops:2,peakConnectMs:Math.round(peakReconnectMs)};report.rows.push(row);console.log(JSON.stringify(row));
  await adapter.closeSoopBrowserHost();
 }
 report.passed=true;
}catch(e){report.failure={code:e.code||null,message:String(e.message).slice(0,200)};process.exitCode=1;}
finally{
 for(const c of controllers)c.abort();for(const ws of clients.values())ws.terminate();await adapter?.closeSoopBrowserHost();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));
 const p=await realpath(directory);assert.equal(dirname(p),await realpath(root));await rm(p,{recursive:true,force:true});report.fixtureRemoved=true;report.finishedAt=new Date().toISOString();await writeFile('../output/operations-20260909/simultaneous-reconnect.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,failure:report.failure}));
}
