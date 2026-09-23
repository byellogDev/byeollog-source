import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {uxControlsRequest,historyRange} from '../../apps/web/lib/ux-controls.js';
import {rouletteExceptionsRequest,normalizeExceptionDecision} from '../../apps/web/lib/roulette-exceptions.js';
import handler from '../../apps/admin-runtime/handlers/data.js';
const ws='10000000-0000-4000-8000-000000000001',user='20000000-0000-4000-8000-000000000002',id='30000000-0000-4000-8000-000000000003';
test('history validates calendar dates, bounded periods and KST day boundaries',()=>{
 const r=historyRange({from:'2026-09-08',until:'2026-09-09'});assert.equal(r.p_from,'2026-09-07T15:00:00.000Z');assert.equal(r.p_until,'2026-09-09T15:00:00.000Z');
 for(const query of [{from:'2026-02-30'},{from:'2020-01-01',until:'2026-09-09'},{from:'2026-09-10',until:'2026-09-09'},{cursor:'{"at":"bad","key":"x"}'},{search:'a'.repeat(101)}])assert.throws(()=>historyRange(query));
});
test('UX history and close actions take workspace and user only from the caller session',async()=>{
 const calls=[],sb=async(...args)=>{calls.push(args);return {items:[]}};
 const result=await uxControlsRequest({sb,workspaceId:ws,userId:user,method:'GET',query:{kind:'history',workspace_id:'forged',from:'2026-09-08',until:'2026-09-09'}});assert.equal(result.status,200);assert.equal(calls[0][2].body.p_workspace_id,ws);
 await uxControlsRequest({sb,workspaceId:ws,userId:user,method:'POST',query:{kind:'close-pending'},body:{id,updatedAt:'2026-09-08T12:00:00Z',workspace_id:'forged',user_id:'forged'}});assert.equal(calls[1][2].body.p_user_id,user);assert.equal(calls[1][2].body.p_workspace_id,ws);
 const invalid=await uxControlsRequest({sb,workspaceId:ws,userId:user,method:'POST',query:{kind:'close-pending'},body:{id:'bad'}});assert.equal(invalid.status,400);assert.equal(calls.length,2);
});
test('bulk exceptions reject malformed selection before writing and report individual conflicts',async()=>{
 const calls=[],sb=async(...args)=>{calls.push(args);if(calls.length===2)throw {code:'PT409'};return {status:'excluded'}};
 const options={sb,workspaceId:ws,userId:user,method:'POST'};
 assert.equal((await rouletteExceptionsRequest({...options,body:{action:'bulk-excluded',ids:[id,id]}})).status,400);assert.equal(calls.length,0);
 const result=await rouletteExceptionsRequest({...options,body:{action:'bulk-excluded',ids:[id,ws]}});assert.deepEqual(result.body.results.map(x=>x.ok),[true,false]);for(const args of calls)assert.equal(args[2].body.p_workspace_id,ws);
 assert.throws(()=>normalizeExceptionDecision({id,action:'registered',quantity:1,event:'x',type:'y',soopId:'<bad>',createFan:true,fanName:'fan'}));
 assert.equal(normalizeExceptionDecision({id,action:'undo'}).decision.action,'undo');
});
test('public pagination never exposes raw task or fan identity and preserves separate same-name fans',async()=>{
 const env={SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_ANON_KEY:process.env.SUPABASE_ANON_KEY,BYEOLLOG_PUBLIC_READ_TOKEN:process.env.BYEOLLOG_PUBLIC_READ_TOKEN},oldFetch=globalThis.fetch;
 Object.assign(process.env,{SUPABASE_URL:'https://fixture.invalid',SUPABASE_ANON_KEY:'sb_publishable_synthetic',BYEOLLOG_PUBLIC_READ_TOKEN:'ab'.repeat(32)});
 const requests=[];globalThis.fetch=async(url,options)=>{requests.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({items:['private-a','private-b'].map((identity,index)=>({fan_key:(index?'b':'a').repeat(64),identity,id:'private-task-id',fan:'Same name',event:'E',type:'T',remaining:2,fan_remaining:2,comment:'public',secret:'never'})),totalRows:2,hasMore:false}))};
 const res=()=>({statusCode:0,body:null,setHeader(){},status(n){this.statusCode=n;return this},json(value){this.body=value;return this},send(value){this.body=value;return this}});
 try{const req={method:'POST',query:{operation:'public-upbo-page'},body:{p_workspace_slug:'synthetic',p_page:0,p_sort:'name'}},a=res();await handler(req,a);assert.equal(a.statusCode,200);assert.notEqual(a.body.items[0].fan_key,a.body.items[1].fan_key);assert.doesNotMatch(JSON.stringify(a.body),/private-a|private-b|private-task|never|identity/);const b=res();await handler(req,b);assert.equal(b.body.items[0].fan_key,a.body.items[0].fan_key);const invalid=res();await handler({...req,body:{...req.body,p_page:-1}},invalid);assert.equal(invalid.statusCode,400);assert.equal(requests.length,2)}finally{globalThis.fetch=oldFetch;for(const [key,value]of Object.entries(env))if(value===undefined)delete process.env[key];else process.env[key]=value}
});
