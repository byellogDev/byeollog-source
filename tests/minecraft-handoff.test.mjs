import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createRuntimeProxyHandler} from '../apps/web/lib/runtime-proxy.js';
import {createInternalRuntimeHandler} from '../apps/admin-runtime/lib/runtime-isolation.js';
import {createMinecraftServerHandler} from '../apps/admin-runtime/lib/minecraft-server-service.mjs';
import {handleSoopOAuthCallback,createSoopSignupOAuthAttempt,ATTEMPT_COOKIE} from '../apps/admin-runtime/lib/soop-oauth.js';
import {createGameLinkHandler} from '../apps/admin-runtime/lib/game-link-service.mjs';
import {MemoryGameLinkStore} from '../apps/admin-runtime/lib/game-link-store.mjs';
import {sha256} from '../apps/admin-runtime/lib/game-link-security.mjs';
import {provision} from '../tools/provision-minecraft-server.mjs';

function response(){const h=new Map();return {statusCode:200,setHeader(k,v){h.set(k.toLowerCase(),v)},getHeader(k){return h.get(k.toLowerCase())},status(v){this.statusCode=v;return this},json(v){this.body=JSON.stringify(v);return this},send(v=''){this.body=String(v);return this},end(v=''){return this.send(v)}};}
const env={BYEOLLOG_RUNTIME:'frontend'};
for(const role of ['ADMIN','PUBLIC','COLLECTOR']){env['BYEOLLOG_'+role+'_RUNTIME_URL']='https://example.vercel.app';env['BYEOLLOG_'+role+'_RUNTIME_TOKEN']='a'.repeat(64);}
const headers={authorization:'Bearer bms_'+'b'.repeat(43),'x-byeollog-server-id':'10000000-0000-4000-8000-000000000001','x-byeollog-request-id':'request_0123456789abcdef','x-byeollog-timestamp':String(Math.floor(Date.now()/1000))};
const body={minecraftUuid:'a'.repeat(32)};
test('frontend passes server auth to isolated admin; external runtime token cannot replace internal token',async()=>{
  const internal=createInternalRuntimeHandler(createMinecraftServerHandler({store:{async authorizePlayer(input){assert.equal(input.serverId,headers['x-byeollog-server-id']);assert.equal(input.apiKeyHash,sha256(headers.authorization.slice(7)));return {soop_user_id:'fixture',minecraft_uuid:body.minecraftUuid,minecraft_name:'Fixture'};}}}),{runtime:'admin',env:{BYEOLLOG_RUNTIME:'admin',BYEOLLOG_RUNTIME_TOKEN:'a'.repeat(64),SUPABASE_URL:'https://example.invalid',SUPABASE_SECRET_KEY:'test',SUPABASE_SERVICE_ROLE_KEY:'test',SESSION_SECRET:'test'}});
  const handler=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/minecraft-server',env,fetcher:async(url,opts)=>{assert.equal(opts.headers.get('x-byeollog-runtime-token'),'a'.repeat(64));assert.equal(opts.headers.get('x-vercel-protection-bypass'),null);const res=response();await internal({method:'POST',url,query:{operation:'player'},headers:Object.fromEntries(opts.headers),body:opts.body},res);return new Response(res.body,{status:res.statusCode});}});
  const res=response();await handler({method:'POST',query:{operation:'player'},headers:{...headers,'x-byeollog-runtime-token':'untrusted','x-vercel-protection-bypass':'untrusted'},body},res);assert.equal(res.statusCode,200);assert.equal(JSON.parse(res.body).player.soopUserId,'fixture');
});
test('server-specific auth headers are not forwarded to other endpoints',async()=>{const handler=createRuntimeProxyHandler({runtime:'admin',endpoint:'/api/login',env,fetcher:async(_,o)=>{for(const key of Object.keys(headers).filter(k=>k.startsWith('x-')))assert.equal(o.headers.get(key),null);return new Response('{}')}});await handler({method:'GET',headers},response());});
for(const [name,value] of [['malformed','{'],['oversized-object',{...body,padding:'a'.repeat(4096)}],['oversized-buffer',Buffer.alloc(4097)],['array',[]],['null','null']])test('invalid input rejected before DB: '+name,async()=>{const handler=createMinecraftServerHandler({store:{authorizePlayer(){assert.fail('must not query DB')}}});const res=response();await handler({method:'POST',url:'/api/minecraft-server/player',headers,body:value},res);assert.equal(res.statusCode,400);assert.equal(JSON.parse(res.body).code,'request_invalid');});
test('stream input limit counts UTF8 bytes',async()=>{const req=Readable.from(['{"padding":"'+'한'.repeat(1500)+'"}']);Object.assign(req,{method:'POST',url:'/api/minecraft-server/player',headers});const res=response();await createMinecraftServerHandler({store:{authorizePlayer(){assert.fail()}}})(req,res);assert.equal(res.statusCode,400);});

const oauthEnv={SESSION_SECRET:'s'.repeat(64),SOOP_OAUTH_ENABLED:'true'};
const attempt=createSoopSignupOAuthAttempt({env:oauthEnv});
const cookies=`${ATTEMPT_COOKIE}=${attempt.token}; byeollog_game_link=${'b'.repeat(43)}`;
test('normal signed SOOP attempt wins over leftover game cookie',async()=>{let delegated=false;const res=response();await handleSoopOAuthCallback({method:'GET',headers:{cookie:cookies},query:{state:attempt.state,error:'access_denied'}},res,{env:oauthEnv,gameLinkHandler(){delegated=true;}});assert.equal(delegated,false);assert.equal(res.statusCode,400);});
test('game state can coexist with normal signed attempt',async()=>{let delegated=false;const res=response();await handleSoopOAuthCallback({method:'GET',headers:{cookie:cookies},query:{state:'different-game-state',code:'code'}},res,{env:oauthEnv,gameLinkHandler(_,res){delegated=true;return res.status(204).end()}});assert.equal(delegated,true);});
test('ambiguous legacy cookies fail safely and retire both flows for explicit restart',async()=>{const res=response();await handleSoopOAuthCallback({method:'GET',headers:{cookie:cookies},query:{code:'code'}},res,{env:oauthEnv,gameLinkHandler(){assert.fail()}});assert.equal(res.statusCode,400);const cleared=res.getHeader('set-cookie');assert.equal(cleared.length,2);assert.ok(cleared.every(x=>x.includes('Max-Age=0')));});
test('duplicate game cookies do not capture normal callback',async()=>{const res=response();await handleSoopOAuthCallback({method:'GET',headers:{cookie:cookies+'; byeollog_game_link='+ 'c'.repeat(43)},query:{state:attempt.state,error:'denied'}},res,{env:oauthEnv,gameLinkHandler(){assert.fail()}});assert.equal(res.statusCode,400);});
test('expired game session does not exchange provider authorization code',async()=>{const store=new MemoryGameLinkStore();const token='t'.repeat(43);await store.createSession({tokenHash:sha256(token),soopStateHash:sha256('state'),expiresAt:new Date(0)});const handler=createGameLinkHandler({store,env:{GAME_LINK_DATA_KEY:Buffer.alloc(32,1).toString('base64')},oauth:{verifySoopCallback(){assert.fail()}}});const res=response();await handler({method:'GET',url:'/api/game-link/soop/callback?state=state&code=code',headers:{cookie:'byeollog_game_link='+token}},res);assert.equal(res.statusCode,400);});

test('provision preserves credential after lost response, resume verifies without key rotation',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'byeollog-provision-'));let committed;let posts=0;let offline=true;
 const fetchImpl=async(url,options)=>{if(options.method==='POST'){posts++;committed=JSON.parse(options.body);throw Error('lost response after commit')}if(offline)throw Error('network down');if(url.includes('server_player_grants'))return Response.json([{binding_id:'fixture'}]);return Response.json([{id:committed.p_server_id,status:'active',api_key_hash:committed.p_api_key_hash}]);};
 const opts={serverKey:'fixture',displayName:'Fixture',minecraftUuid:'a'.repeat(32),directory,env:{SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'test'},fetchImpl};
 try{await assert.rejects(provision(opts),/retained/);const before=await fs.readFile(path.join(directory,'fixture.json'),'utf8');offline=false;assert.equal((await provision({...opts,resume:true})).recovered,true);assert.equal(posts,1);assert.equal(await fs.readFile(path.join(directory,'fixture.json'),'utf8'),before);}finally{await fs.rm(directory,{recursive:true,force:true});}
});
