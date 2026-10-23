import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {buildBundle} from './build-bundle.mjs';
import {encodePacket} from './protocol.mjs';
import {fixtures} from './fixtures.mjs';

test('built original monitor emits private semantic and field records from received CDP frames',()=>{
 const f=fixtures().find(x=>x.code===18),fields=[...f.fields];fields[4]='777';
 const packets=[encodePacket(18,f.fields),encodePacket(18,fields)].map(b=>b.toString('base64'));
 let source=buildBundle().bundle.monitor;
 source=source.replace("import fs from 'node:fs';",'')
  .replace(/^import \{signSoopGatewayRequest\}[^\n]+\n/m,'')
  .replace(/^import \{cdpClient\}[^\n]+\n/m,'');
 const mock=`
 const nativeTimeout=globalThis.setTimeout;
 globalThis.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms/1000,...args);
 const signSoopGatewayRequest=()=>'';
 const fs={readFileSync:p=>p.includes('worker-state')?JSON.stringify({heartbeatAt:new Date().toISOString(),channels:[{workspace:crypto.createHash('sha256').update('synthetic-workspace').digest('hex').slice(0,12),state:'connected'}],queue:{pending:0,deadLetters:0}}):'chromium --remote-debugging-port=1234',readdirSync:()=>['123']};
 globalThis.fetch=async url=>({ok:true,status:200,json:async()=>[{type:'page',webSocketDebuggerUrl:'synthetic'}],text:async()=>JSON.stringify({kind:'observe',workspaceId:'synthetic-workspace',providerAccountId:'lab0',clientId:'private-client',clientSecret:'private-secret',accessToken:'private-token',providerTokenExpiresAt:new Date(Date.now()+600000).toISOString()})});
 const cdpClient=(_url,receive)=>({close(){},async send(method,args){
  if(method==='Runtime.evaluate')return {result:args.expression==='WebSocket.prototype'?{objectId:'prototype'}:{value:args.expression.endsWith('.chatNumber')?1000:true}};
  if(method==='Runtime.queryObjects')return {objects:{objectId:'objects'}};
  if(method==='Runtime.callFunctionOn'){
   nativeTimeout(()=>{for(const payloadData of ${JSON.stringify(packets)})receive({method:'Network.webSocketFrameReceived',params:{requestId:'socket',response:{opcode:2,payloadData}}});receive({method:'Network.webSocketClosed',params:{requestId:'socket'}})},5);
   return {result:{value:{total:1,matched:1,open:1}}};
  }return {};
 }});
 `;
 // Input closes after configuration; model a live supervisor for this bounded
 // monitor run. No original credentials, network, Docker or operating files.
 source=source.replace("input.on('close',()=>halt('supervisor_disconnected'));",'');
 const child=spawnSync(process.execPath,['--input-type=module','-e',mock+'\n'+source],{
  input:JSON.stringify({workspaceId:'synthetic-workspace',salt:'synthetic-salt'.repeat(4),durationMs:60000})+'\n',encoding:'utf8',timeout:5000});
 assert.equal(child.status,1,child.stderr);
 const lines=child.stdout.trim().split('\n').map(JSON.parse);
 assert(lines.some(x=>x.kind==='abort'&&x.reason==='original_socket_closed'),child.stdout);
 const frames=lines.filter(x=>x.kind==='frame');assert.equal(frames.length,2);
 assert.equal(frames[0].schema,2);assert.equal(frames[0].digest,frames[1].digest);assert.notEqual(frames[0].rawDigest,frames[1].rawDigest);
 assert.notEqual(frames[0].fields[4].digest,frames[1].fields[4].digest);
 const persisted=JSON.stringify(lines.filter(x=>!x.kind.startsWith('private_')));
 for(const marker of ['private-token','private-secret','synthetic-user','합성시청자'])assert(!persisted.includes(marker));
});
