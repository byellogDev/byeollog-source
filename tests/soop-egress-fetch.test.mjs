import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createEgressFetch} from '../services/soop-gateway/services/soop-chat-gateway/direct/egress-fetch.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const url='https://openapi.sooplive.com/broad/access/chatinfo';
const options={method:'POST',body:'access_token=fixture-token'};
const room=port=>({result:1,data:[{id:'fixture',chat_port:port-1,chat_ip:'110.10.76.111',chat_no:123,key:'fixture-ticket'}]});
const config={socketPath:'/run/egress/control.sock',owner:'fixture',baselinePorts:[8041,9001]};
test('disabled controller keeps original fetch identity',()=>{
 const original=()=>{};assert.equal(createEgressFetch({fetchImpl:original}),original);
});
test('approved ports never depend on the controller',async()=>{
 const f=createEgressFetch({...config,fetchImpl:async()=>Response.json(room(8041)),requestImpl:()=>assert.fail('controller called')});
 assert.deepEqual(await (await f(url,options)).json(),room(8041));
});
test('offline status preserves ordinary waiting without controller',async()=>{
 const f=createEgressFetch({...config,fetchImpl:async()=>Response.json({result:-1302}),requestImpl:()=>assert.fail('controller called')});
 assert.equal((await (await f(url,options)).json()).result,-1302);
});
test('unknown port is independently looked up over Unix and uses controller reply',async()=>{
 let calls=0;
 const requestImpl=(args,cb)=>{
  calls++;assert.equal(args.socketPath,config.socketPath);assert.equal(args.path,'/chatinfo');assert.equal(args.hostname,undefined);
  const req=new EventEmitter();req.end=data=>{
   assert.deepEqual(JSON.parse(data),{owner:'fixture',accessToken:'fixture-token'});
   const res=new EventEmitter();res.statusCode=200;cb(res);
   res.emit('data',Buffer.from(JSON.stringify(room(9201))));res.emit('end');
  };return req;
 };
 const f=createEgressFetch({...config,fetchImpl:async()=>Response.json(room(9101)),requestImpl});
 assert.equal((await (await f(url,options)).json()).data[0].chat_port,9200);assert.equal(calls,1);
});
test('unknown port fails closed on controller outage without exposing tokens',async()=>{
 const requestImpl=()=>{const req=new EventEmitter();req.end=()=>req.emit('error',new Error('fixture-token'));return req};
 const f=createEgressFetch({...config,fetchImpl:async()=>Response.json(room(9101)),requestImpl});
 await assert.rejects(f(url,options),{message:'egress_controller_unavailable'});
});
test('provider owner mismatch never requests firewall access',async()=>{
 const value=room(9101);value.data[0].id='other';
 const f=createEgressFetch({...config,fetchImpl:async()=>Response.json(value),requestImpl:()=>assert.fail('controller called')});
 await assert.rejects(f(url,options),{code:'chatinfo_owner_mismatch'});
});
test('OAuth refresh is not routed through controller',async()=>{
 let received;const f=createEgressFetch({...config,fetchImpl:async(...args)=>{received=args;return 'unchanged'}});
 assert.equal(await f('https://openapi.sooplive.com/auth/token',options),'unchanged');assert.equal(received[0],'https://openapi.sooplive.com/auth/token');
});
test('provider response size is bounded before controller dispatch',async()=>{
 const f=createEgressFetch({...config,fetchImpl:async()=>new Response('a'.repeat(65537)),requestImpl:()=>assert.fail('controller called')});
 await assert.rejects(f(url,options),{code:'chatinfo_too_large'});
});
test('auto egress policy recovery and security regressions',()=>{
 const script=fileURLToPath(new URL('../operations/iwinv/auto-egress/policy.test.py',import.meta.url));
 const result=spawnSync(process.env.PYTHON||'python',['-B',script],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
});
test('auto egress monitor redaction regressions',()=>{
 const script=fileURLToPath(new URL('../operations/iwinv/auto-egress/monitor.test.py',import.meta.url));
 const result=spawnSync(process.env.PYTHON||'python',['-B',script],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(result.status,0,result.stderr||result.error?.message||result.stdout);
});
