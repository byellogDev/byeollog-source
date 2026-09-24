import test from 'node:test';
import assert from 'node:assert/strict';
import {MemoryGameLinkStore,SupabaseGameLinkStore} from '../apps/admin-runtime/lib/game-link-store.mjs';
import {sha256} from '../apps/admin-runtime/lib/game-link-security.mjs';
import {createGameLinkHandler} from '../apps/admin-runtime/lib/game-link-service.mjs';
import {handleSoopOAuthStart,handleSoopSignupOAuthStart,handleSoopOAuthCallback,ATTEMPT_COOKIE} from '../apps/admin-runtime/lib/soop-oauth.js';
import {handleSoopGatewayIngress} from '../apps/admin-runtime/lib/soop-gateway-api.js';
import {signSoopGatewayRequest} from '../apps/admin-runtime/lib/soop-chat-gateway.js';
import {encryptSoopToken} from '../apps/admin-runtime/lib/soop-oauth.js';
import {createInternalRuntimeHandler,allowAdminLogin} from '../apps/admin-runtime/lib/runtime-isolation.js';
import {selectLoginRuntime} from '../apps/web/lib/runtime-isolation.js';
import {allowCollectorLogin} from '../apps/collector-runtime/lib/runtime-isolation.js';

function response(){const h={};return {statusCode:200,setHeader(k,v){h[k.toLowerCase()]=v},getHeader(k){return h[k.toLowerCase()]},status(v){this.statusCode=v;return this},json(v){this.body=v;return this},send(v){this.body=v;return this},end(){return this}}}
const env={SOOP_OAUTH_ENABLED:'true',SOOP_CLIENT_ID:'synthetic-client-identifier',SOOP_CLIENT_SECRET:'synthetic-secret-value-for-testing',SESSION_SECRET:'s'.repeat(64),SOOP_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,4).toString('base64'),GAME_LINK_DATA_KEY:Buffer.alloc(32,5).toString('base64')};
async function pending(store,id='fixture_user'){
 const tokenHash=sha256('session-'+id),state=sha256('state');
 await store.createSession({tokenHash,soopStateHash:state,expiresAt:new Date(Date.now()+60000)});
 await store.recordSoopIdentity({tokenHash,stateHash:state,soopId:id});
 await store.prepareMicrosoft({tokenHash,microsoftStateHash:state,pkceVerifierCiphertext:'synthetic'});
 return {tokenHash,microsoftStateHash:state,minecraftUuid:'a'.repeat(32),minecraftName:'Fixture'};
}
test('same-identity OAuth completion preserves suspension and session state',async()=>{
 const store=new MemoryGameLinkStore(),b={soop_user_id:'fixture_user',minecraft_uuid:'a'.repeat(32),minecraft_name:'Fixture',status:'suspended'};
 store.bindingsBySoop.set(b.soop_user_id,b);store.bindingsByMinecraft.set(b.minecraft_uuid,b);
 const input=await pending(store);await assert.rejects(store.completeSession(input),e=>e.code==='game_link_suspended');
 assert.equal(b.status,'suspended');assert.equal((await store.getSession(input.tokenHash)).status,'microsoft_pending');assert.equal(store.audit.length,0);
});
test('suspended Minecraft identity cannot be claimed by a different SOOP identity',async()=>{
 const store=new MemoryGameLinkStore();store.bindingsByMinecraft.set('a'.repeat(32),{status:'suspended',soop_user_id:'other'});
 await assert.rejects(store.completeSession(await pending(store)),e=>e.code==='game_link_suspended');
});
test('normal new completion remains active',async()=>{const s=new MemoryGameLinkStore();assert.equal((await s.completeSession(await pending(s))).status,'active')});
test('production-store suspension error becomes an explicit conflict',async()=>{
 const store=new SupabaseGameLinkStore({url:'https://example.invalid',serviceRoleKey:'synthetic',fetchImpl:async()=>Response.json({message:'game_link_suspended'},{status:400})});
 await assert.rejects(store.completeSession({}),e=>e.code==='game_link_suspended'&&e.status===409);
});

function applyCookies(jar,res){for(const line of [].concat(res.getHeader('set-cookie')||[])){const [pair]=line.split(';'),i=pair.indexOf('=');if(line.includes('Max-Age=0'))delete jar[pair.slice(0,i)];else jar[pair.slice(0,i)]=pair.slice(i+1)}}
const cookie=jar=>Object.entries(jar).map(([k,v])=>k+'='+v).join('; ');
for(const type of ['signup','existing'])test(`${type} start retires game cookie and accepts normal state-less callback path`,async()=>{
 const jar={byeollog_game_link:'g'.repeat(43)},start=response();
 if(type==='signup')await handleSoopSignupOAuthStart({method:'GET',headers:{},query:{}},start,{env});
 else await handleSoopOAuthStart({method:'GET',headers:{}},start,{env,resolveSession:async()=>({mode:'beta',user_id:'10000000-0000-4000-8000-000000000001',workspace_id:'20000000-0000-4000-8000-000000000002',session_epoch:1})});
 applyCookies(jar,start);assert.equal(start.statusCode,302);assert.equal(jar.byeollog_game_link,undefined);assert.ok(jar[ATTEMPT_COOKIE]);
 let delegated=false,entered=false;const res=response();
 await handleSoopOAuthCallback({method:'GET',headers:{cookie:cookie(jar)},query:{code:'synthetic'}},res,{env,gameLinkHandler(){delegated=true},revalidateSession:async()=>{entered=true;return null},fetchImpl:async()=>{entered=true;return Response.json({error:'synthetic'},{status:400})}});
 assert.equal(delegated,false);assert.equal(entered,true);assert.notEqual(res.statusCode,400);
});
test('game start clears normal attempt and same-site failure cannot clear another flow',async()=>{
 const store=new MemoryGameLinkStore(),handler=createGameLinkHandler({store,env,oauth:{buildSoopAuthorizationUrl:()=> 'https://example.invalid/auth'}});
 const cross=response();await handler({method:'GET',url:'/api/game-link/soop/start',headers:{'sec-fetch-site':'cross-site'}},cross);assert.equal(cross.statusCode,403);assert.equal(cross.getHeader('set-cookie'),undefined);
 const res=response();await handler({method:'GET',url:'/api/game-link/soop/start',headers:{}},res);
 const jar={[ATTEMPT_COOKIE]:'old'};applyCookies(jar,res);assert.equal(jar[ATTEMPT_COOKIE],undefined);assert.ok(jar.byeollog_game_link);
});
test('returned mismatched state remains rejected after cookie selection',async()=>{
 const start=response();await handleSoopSignupOAuthStart({method:'GET',headers:{},query:{}},start,{env});const jar={};applyCookies(jar,start);
 const res=response();await handleSoopOAuthCallback({method:'GET',headers:{cookie:cookie(jar)},query:{code:'synthetic',state:'wrong'}},res,{env,fetchImpl(){assert.fail('must not exchange invalid state')}});assert.equal(res.statusCode,400);
});

const workspaceId='10000000-0000-4000-8000-000000000001';
for(const remaining of [90000,120000,-1000,NaN,3600000])test(`observe never refreshes or writes with remaining ${remaining}ms`,async()=>{
 const e={...env,BYEOLLOG_RUNTIME:'admin',BYEOLLOG_RUNTIME_TOKEN:'r'.repeat(64),SUPABASE_URL:'https://example.invalid',SUPABASE_SECRET_KEY:'synthetic',SUPABASE_SERVICE_ROLE_KEY:'synthetic',SOOP_GATEWAY_INGRESS_ENABLED:'true',SOOP_GATEWAY_INGRESS_SECRET:'q'.repeat(64)};
 const body={kind:'observe',workspaceId,instanceId:'synthetic-observer'},timestamp=String(Date.now()),nonce=sha256(String(remaining)).slice(0,32);
 const signature=signSoopGatewayRequest({secret:e.SOOP_GATEWAY_INGRESS_SECRET,timestamp,nonce,body});const res=response();let reads=0;
 const request={method:'POST',query:{operation:'soop-gateway'},headers:{'x-byeollog-runtime-token':e.BYEOLLOG_RUNTIME_TOKEN,'content-type':'application/json','x-byeollog-soop-gateway-timestamp':timestamp,'x-byeollog-soop-gateway-nonce':nonce,'x-byeollog-soop-gateway-signature':signature},body};
 assert.equal(selectLoginRuntime(request),'admin');assert.equal(allowCollectorLogin(request),false);
 const handler=createInternalRuntimeHandler((req,res)=>handleSoopGatewayIngress(req,res,{env:e,refreshConnection(){assert.fail('observation must not refresh')},sbImpl:async(table,path,opt={})=>{
  assert.ok(!opt.method||opt.method==='GET');reads++;
  if(table==='byeollog_soop_runtime_controls')return [{gateway_enabled:true,core_collection_enabled:true}];
  if(table==='byeollog_workspaces')return [{id:workspaceId,soop_id:'fixture_user',status:'active'}];
  assert.equal(table,'byeollog_soop_connections');assert.ok(path.includes('workspace_id=eq.'+workspaceId));assert.ok(!path.includes('refresh_token'));
  return [{access_token_ciphertext:encryptSoopToken('synthetic-access',{env:e}),access_token_expires_at:Number.isFinite(remaining)?new Date(Date.now()+remaining).toISOString():null}];
 }}),{runtime:'admin',allowRequest:allowAdminLogin,env:e});
 await handler(request,res);
 assert.equal(reads,3);
 if(remaining>120000){assert.equal(res.statusCode,200);assert.equal(res.body.kind,'observe');assert.equal(res.body.leaseToken,undefined);assert.equal(res.body.refreshed,false)}
 else{assert.equal(res.statusCode,409);assert.equal(res.body.code,'soop_observation_token_wait')}
});
