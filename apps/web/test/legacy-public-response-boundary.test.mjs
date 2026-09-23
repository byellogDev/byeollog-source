import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/data.js';

const workspace={slug:'sample',display_name:'공개 방송명',public_page_enabled:true};
const task={fan:'공개 별명',event:'9월',type:'업보',remaining:3,comment:'공개 코멘트'};
const privateFields={email:'private@example.invalid',real_name:'비공개 합성 이름',memo:'비공개 합성 메모',fan_soop_id:'private_synthetic_id',access_token:'synthetic_private_token',owner:{email:'nested@example.invalid'}};

async function call(operation,upstream,{status=200,enabled=false,raw=false,search='별명'}={}){
 const savedFetch=globalThis.fetch;
 const env={SUPABASE_URL:'https://legacy-test.example.invalid',SUPABASE_ANON_KEY:'sb_publishable_synthetic',BYEOLLOG_PUBLIC_READ_TOKEN:'ab'.repeat(32),SUPABASE_SECRET_KEY:'synthetic-secret',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service',VIEWER_ROULETTE_PUBLIC_ENABLED:String(enabled)};
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
 let request;
 Object.assign(process.env,env);
 globalThis.fetch=async(url,options)=>{request={url:String(url),method:options.method,body:JSON.parse(options.body)};return new Response(raw?upstream:JSON.stringify(upstream),{status,headers:{'content-type':'application/json'}})};
 const res={statusCode:200,headers:{},status(code){this.statusCode=code;return this},setHeader(key,value){this.headers[key.toLowerCase()]=value},send(value){this.body=JSON.parse(value);return this},json(value){this.body=value;return this}};
 try{
  await handler({method:'POST',query:{operation},body:{p_workspace_slug:' Sample ',p_search:search},headers:{}},res);
  return {...res,request};
 }finally{
  globalThis.fetch=savedFetch;
  for(const [key,value] of Object.entries(saved))if(value===undefined)delete process.env[key];else process.env[key]=value;
 }
}

test('legacy workspace excludes additional private fields while preserving public metadata and server feature flag',async()=>{
 for(const enabled of [false,true]){
  const res=await call('public-workspace',[{...workspace,...privateFields,viewer_roulette_enabled:!enabled}],{enabled});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,[{...workspace,viewer_roulette_enabled:enabled}]);
  assert.equal(res.headers['cache-control'],'no-store');
  assert.equal(res.headers['content-type'],'application/json; charset=utf-8');
  assert.deepEqual(res.request.body.p_args,{p_workspace_slug:'sample'});
 }
});

test('legacy tasks exclude private fields and preserve public values, duplicates and row order',async()=>{
 const publicRows=[task,{...task,fan:'두번째 별명',remaining:0,comment:null},task];
 const res=await call('public-bangsel',publicRows.map(row=>({...row,...privateFields})));
 assert.equal(res.statusCode,200);
 assert.deepEqual(res.body,publicRows);
 assert.equal(res.headers['cache-control'],'no-store');
 assert.deepEqual(res.request.body.p_args,{p_workspace_slug:'sample',p_search:'별명'});
 assert.equal(res.request.url,'https://legacy-test.example.invalid/rest/v1/rpc/byeollog_public_read_v1');
});

test('legacy responses preserve nullable text and disabled workspace visibility without private-field fallback',async()=>{
 const res=await call('public-workspace',[{...workspace,display_name:null,public_page_enabled:false,...privateFields}]);
 assert.deepEqual(res.body,[{...workspace,display_name:null,public_page_enabled:false,viewer_roulette_enabled:false}]);
 const nullable={fan:null,event:null,type:null,remaining:0,comment:null};
 assert.deepEqual((await call('public-bangsel',[{...nullable,...privateFields}])).body,[nullable]);
});

for(const operation of ['public-workspace','public-bangsel']){
 test(operation+' preserves empty results',async()=>{
  const res=await call(operation,[]);assert.equal(res.statusCode,200);assert.deepEqual(res.body,[]);
 });
 test(operation+' rejects malformed or nested sensitive values without exposing the upstream body',async()=>{
  const valid=operation==='public-workspace'?workspace:task;
  const textField=operation==='public-workspace'?'display_name':'comment';
  const invalid=[{...privateFields},null,[null],['private'],[valid,{...valid,[textField]:privateFields}],
   [{...valid,[textField]:[privateFields]}],[{...valid,[textField]:undefined}],
   [{...valid,...(operation==='public-workspace'?{public_page_enabled:'true'}:{remaining:'3'})}]];
  for(const upstream of invalid){
   const res=await call(operation,upstream);
   assert.equal(res.statusCode,502);assert.deepEqual(res.body,{message:'Public data service is unavailable'});
  }
  const malformed=await call(operation,'{private-invalid-json',{raw:true});
  assert.equal(malformed.statusCode,502);assert.deepEqual(malformed.body,{message:'Public data service is unavailable'});
 });
 test(operation+' keeps upstream failures generic and preserves status',async()=>{
  const res=await call(operation,privateFields,{status:503});
  assert.equal(res.statusCode,503);assert.deepEqual(res.body,{message:'Public data query failed'});
 });
}
