import test from 'node:test';
import assert from 'node:assert/strict';
import {publicReadConfig,fetchPublicRead} from '../lib/public-read.js';
const token='ab'.repeat(32);
const jwt=role=>'eyJhbGciOiJIUzI1NiJ9.'+Buffer.from(JSON.stringify({role})).toString('base64url')+'.synthetic';
const base={SUPABASE_URL:'https://synthetic.invalid/',BYEOLLOG_PUBLIC_READ_TOKEN:token};
test('public reads accept anonymous credentials and refuse administrator credentials or fallback',()=>{
 assert.equal(publicReadConfig({...base,SUPABASE_ANON_KEY:'sb_publishable_synthetic'}).authorization,undefined);
 assert.equal(publicReadConfig({...base,SUPABASE_ANON_KEY:jwt('anon')}).authorization,'Bearer '+jwt('anon'));
 for(const key of [undefined,'','malformed',jwt('service_role'),jwt('authenticated'),'sb_secret_synthetic']){
  assert.equal(publicReadConfig({...base,SUPABASE_ANON_KEY:key,SUPABASE_SECRET_KEY:'sb_secret_synthetic',SUPABASE_SERVICE_ROLE_KEY:jwt('service_role')}),null);
 }
 for(const value of ['',undefined,'short','x'.repeat(64)])assert.equal(publicReadConfig({...base,SUPABASE_ANON_KEY:jwt('anon'),BYEOLLOG_PUBLIC_READ_TOKEN:value}),null);
});
test('public-read transport uses a fixed gateway without service-role headers or secrets in its response',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async(url,options)=>{
   assert.equal(url,'https://synthetic.invalid/rest/v1/rpc/byeollog_public_read_v1');
   assert.equal(options.method,'POST');assert.equal(options.cache,'no-store');
   assert.equal(options.headers.apikey,jwt('anon'));assert.equal(options.headers.Authorization,'Bearer '+jwt('anon'));
   assert.deepEqual(JSON.parse(options.body),{p_token:token,p_operation:'public-workspace',p_args:{p_workspace_slug:'sample'}});
   return new Response('[]',{status:200});
  };
  assert.deepEqual(await fetchPublicRead(publicReadConfig({...base,SUPABASE_ANON_KEY:jwt('anon')}),'public-workspace',{p_workspace_slug:'sample'}),{upstreamStatus:200,text:'[]'});
 }finally{globalThis.fetch=original}
});
