import test from 'node:test';
import assert from 'node:assert/strict';
import {handleSoopOAuthCallback,createSoopOAuthAttempt,createSoopSignupOAuthAttempt,ATTEMPT_COOKIE,decryptSoopToken} from '../apps/admin-runtime/lib/soop-oauth.js';
const workspaceId='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001';
const env={SOOP_OAUTH_ENABLED:'true',SOOP_CLIENT_ID:'isolated-client-1234567890123456',SOOP_CLIENT_SECRET:'isolated-secret-12345678901234567890',SESSION_SECRET:'isolated-session-secret-12345678901234567890',SOOP_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64url')};
function response(){return {statusCode:200,headers:{},status(n){this.statusCode=n;return this},setHeader(k,v){this.headers[k.toLowerCase()]=v},send(body){this.body=body;return this},json(body){this.body=body;return this},end(){return this}}}
async function callback({provider='test_streamer',canonical='test_streamer',member=true,role='owner',signup=false,registered=false,providerStatus=200}={}){
 const session={mode:'beta',user_id:userId,workspace_id:workspaceId,role,session_epoch:4};
 const token=signup?createSoopSignupOAuthAttempt({env}):createSoopOAuthAttempt(session,{env});
 const writes=[],reads=[],requests=[];
 const res=response();
 await handleSoopOAuthCallback({method:'GET',headers:{cookie:ATTEMPT_COOKIE+'='+encodeURIComponent(token.token)},query:{code:'isolated-authorization-code',state:token.state}},res,{
  env,revalidateSession:async()=>member?session:null,
  fetchImpl:async(url,options)=>{requests.push(String(url));return {ok:String(url).endsWith('/auth/token')||providerStatus===200,status:providerStatus,json:async()=>String(url).endsWith('/auth/token')?{access_token:'isolated-access',refresh_token:'isolated-refresh',expires_in:3600}:{data:{user_id:provider,broad_status:'OFF',broad_no:0}}}},
  sbImpl:async(table,path,options={})=>{
   if(options.method){writes.push({table,path,body:options.body});return options.body?[options.body]:[];}
   reads.push({table,path});assert.equal(table,'byeollog_workspaces');
   if(path.includes('soop_id=ilike.'))return registered?[{id:workspaceId}]:[];
   assert.match(path,new RegExp('id=eq.'+workspaceId));return canonical?[{soop_id:canonical}]:[];
  }
 });return {res,writes,reads,requests};
}
test('offline original SOOP account reconnects and persists encrypted tokens',async()=>{
 const {res,writes}=await callback();assert.equal(res.statusCode,200);assert.match(res.body,/계정 연결이 완료되었습니다/);
 const connection=writes.find(x=>x.table==='byeollog_soop_connections');assert.equal(connection.body.workspace_id,workspaceId);
 assert.equal(decryptSoopToken(connection.body.access_token_ciphertext,{env}),'isolated-access');assert.doesNotMatch(JSON.stringify(connection.body),/isolated-access|isolated-refresh/);
 assert.equal(writes.find(x=>x.table==='byeollog_soop_runtime_controls').body.core_collection_enabled,true);
});
test('another SOOP identity is rejected without overwriting original connection',async()=>{
 const {res,writes}=await callback({provider:'another_streamer'});assert.equal(res.statusCode,409);assert.equal(writes.length,0);
});
test('missing workspace identity and unavailable provider fail closed without writes',async()=>{
 for(const options of [{canonical:null},{providerStatus:503}]){const {res,writes}=await callback(options);assert.ok([409,502].includes(res.statusCode));assert.equal(writes.length,0);}
});
test('removed membership and read-only role cannot exchange provider credentials',async()=>{
 for(const options of [{member:false},{role:'viewer'}]){const {res,writes,requests}=await callback(options);assert.ok([401,403].includes(res.statusCode));assert.equal(writes.length,0);assert.equal(requests.length,0);}
});
test('already registered signup identity warns before any pending signup record',async()=>{
 const {res,writes}=await callback({signup:true,registered:true});assert.equal(res.statusCode,303);assert.equal(res.headers.location,'/signup?soop=already-registered');assert.equal(writes.length,0);
});
test('offline unused identity can create only a short-lived encrypted signup proof',async()=>{
 const {res,writes}=await callback({signup:true});assert.equal(res.statusCode,303);assert.equal(res.headers.location,'/signup?soop=connected');
 assert.equal(writes.length,2);assert.match(writes[0].path,/expires_at=lt\./);
 assert.equal(writes[1].body.provider_user_id,'test_streamer');assert.doesNotMatch(JSON.stringify(writes),/isolated-access|isolated-refresh/);
 assert.ok(Date.parse(writes[1].body.expires_at)>Date.now());assert.ok(Date.parse(writes[1].body.expires_at)<Date.now()+3600_000);
});
