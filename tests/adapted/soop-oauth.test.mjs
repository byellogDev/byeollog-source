import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import {revalidateMembership} from '../../apps/admin-runtime/lib/auth.js';
import {
  ATTEMPT_COOKIE,
  SIGNUP_COOKIE,
  createSoopOAuthAttempt,
  createSoopSignupOAuthAttempt,
  decryptSoopToken,
  encryptSoopToken,
  getSoopOAuthReadiness,
  handleSoopOAuthCallback as productionSoopOAuthCallback,
  handleSoopOAuthDiagnose,
  handleSoopOAuthDisconnect,
  handleSoopOAuthStart,
  handleSoopSignupOAuthStart,
  handleSoopSignupOAuthStatus,
  getPendingSoopSignup,
  requestSoopAccountIdentity,
  refreshSoopConnection,
  requestSoopTokens,
  verifySoopOAuthAttempt
} from '../../apps/admin-runtime/lib/soop-oauth.js';

const workspaceId='10000000-0000-4000-8000-000000000001';
const userId='20000000-0000-4000-8000-000000000001';

function environment(overrides={}){
  return {
    SOOP_OAUTH_ENABLED:'true',
    SOOP_CLIENT_ID:'client_id_123456789012345678901234',
    SOOP_CLIENT_SECRET:'client_secret_123456789012345678901234567890',
    SOOP_REDIRECT_URI:'https://byeollog.com/api/auth/soop/callback',
    SOOP_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64url'),
    SESSION_SECRET:'session_secret_123456789012345678901234567890',
    ...overrides
  };
}

function response(){
  return {
    statusCode:200,headers:{},body:undefined,
    status(code){this.statusCode=code;return this},
    setHeader(name,value){this.headers[String(name).toLowerCase()]=value;return this},
    getHeader(name){return this.headers[String(name).toLowerCase()]},
    send(value){this.body=value;return this},
    json(value){this.body=value;return this},
    end(){return this}
  };
}

test('OAuth readiness remains dormant unless all server-only values are present',()=>{
  assert.deepEqual(getSoopOAuthReadiness({SOOP_OAUTH_ENABLED:'false'}),{
    enabled:false,configured:false,code:'soop_client_id_missing'
  });
  assert.deepEqual(getSoopOAuthReadiness(environment()),{enabled:true,configured:true});
});

test('SOOP tokens use authenticated encryption and reject tampering',()=>{
  const env=environment();
  const token='sensitive-access-token-value';
  const ciphertext=encryptSoopToken(token,{env});
  assert.match(ciphertext,/^v1\./);
  assert.doesNotMatch(ciphertext,new RegExp(token));
  assert.equal(decryptSoopToken(ciphertext,{env}),token);
  const tamperedParts=ciphertext.split('.');
  tamperedParts[3]=(tamperedParts[3][0]==='a'?'b':'a')+tamperedParts[3].slice(1);
  const tampered=tamperedParts.join('.');
  assert.throws(()=>decryptSoopToken(tampered,{env}),error=>error?.code==='soop_token_decryption_failed');
});

test('signed OAuth attempt binds a short-lived callback to one user and workspace',()=>{
  const env=environment();
  const now=Date.UTC(2026,7,29,1,0,0);
  const created=createSoopOAuthAttempt({user_id:userId,workspace_id:workspaceId},{env,now,nonce:'fixed-state-value'});
  const verified=verifySoopOAuthAttempt(created.token,{env,now:now+60_000});
  assert.equal(verified.user_id,userId);
  assert.equal(verified.workspace_id,workspaceId);
  assert.equal(verified.nonce,'fixed-state-value');
  assert.equal(verifySoopOAuthAttempt(created.token,{env,now:now+11*60_000}),null);
  assert.equal(verifySoopOAuthAttempt(created.token+'x',{env,now}),null);
});

test('signup OAuth attempt carries no user-supplied account or workspace identity',()=>{
  const env=environment(),now=Date.UTC(2026,8,7,1,0,0);
  const created=createSoopSignupOAuthAttempt({env,now,nonce:'signup-state'});
  const verified=verifySoopOAuthAttempt(created.token,{env,now:now+1000});
  assert.equal(verified.flow,'signup');
  assert.equal(verified.nonce,'signup-state');
  assert.equal(Object.hasOwn(verified,'user_id'),false);
  assert.equal(Object.hasOwn(verified,'workspace_id'),false);
});

test('official SOOP live-status response is the only accepted signup identity source',async()=>{
  let captured;
  const result=await requestSoopAccountIdentity('access-token',{fetchImpl:async(url,options)=>{
    captured={url,options};return {ok:true,status:200,json:async()=>({result:1,data:{user_id:'Verified_Streamer',status:'streamend'}})};
  }});
  assert.deepEqual(result,{userId:'verified_streamer'});
  assert.equal(captured.url,'https://openapi.sooplive.com/validate/live/status');
  assert.equal(new URLSearchParams(captured.options.body).get('access_token'),'access-token');
});

test('signup start and callback store encrypted short-lived identity then return to signup',async()=>{
  const env=environment(),start=response();
  await handleSoopSignupOAuthStart({method:'GET',headers:{'sec-fetch-site':'same-origin'}},start,{env});
  assert.equal(start.statusCode,302);
  const attemptCookie=String(start.headers['set-cookie']).split(';')[0];
  const writes=[];
  const callback=response();
  await handleSoopOAuthCallback({
    method:'GET',query:{code:'signup-code',state:auditURL(start.headers.location).searchParams.get('state')},headers:{cookie:attemptCookie}
  },callback,{
    env,
    fetchImpl:async url=>String(url).endsWith('/auth/token')
      ?{ok:true,status:200,json:async()=>({access_token:'signup-access',refresh_token:'signup-refresh',expires_in:3600})}
      :{ok:true,status:200,json:async()=>({data:{user_id:'verified_streamer',status:'streamend'}})},
    sbImpl:async(resource,query,options={})=>{writes.push({resource,query,options});return []}
  });
  assert.equal(callback.statusCode,303);
  assert.equal(callback.headers.location,'/signup?soop=connected');
  assert.match(String(callback.headers['set-cookie']),new RegExp(SIGNUP_COOKIE));
  const insert=writes.find(call=>call.resource==='byeollog_soop_signup_oauth_pending'&&call.options.method==='POST');
  assert.equal(insert.options.body.provider_user_id,'verified_streamer');
  assert.match(insert.options.body.access_token_ciphertext,/^v1\./);
  assert.doesNotMatch(insert.options.body.access_token_ciphertext,/signup-access/);
});

test('signup status accepts only a live server-side pending OAuth proof',async()=>{
  const token='x'.repeat(43),hash=crypto.createHash('sha256').update(token).digest('hex');
  const req={method:'GET',headers:{cookie:`${SIGNUP_COOKIE}=${token}`}};
  const pending=await getPendingSoopSignup(req,{sbImpl:async()=>[{token_hash:hash,provider_user_id:'verified_streamer',expires_at:'2026-09-07T01:20:00Z'}],now:new Date('2026-09-07T01:00:00Z')});
  assert.equal(pending.userId,'verified_streamer');
  const res=response();
  await handleSoopSignupOAuthStatus(req,res,{sbImpl:async()=>[{token_hash:hash,provider_user_id:'verified_streamer',expires_at:'2026-09-07T01:20:00Z'}],now:new Date('2026-09-07T01:00:00Z')});
  assert.deepEqual(res.body,{connected:true,soopId:'verified_streamer',expiresAt:'2026-09-07T01:20:00Z'});
});

// Exercise the real membership validator: stubbing it to always succeed hid the
// missing epoch in OAuth attempts for accounts whose sessions had been revoked.
async function callbackWithEpoch({epoch=1,currentEpoch=epoch,legacy=false,member=true,active=true}={}){
  const env=environment();
  const session={mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner',session_epoch:epoch};
  const start=response();
  await handleSoopOAuthStart({method:'GET',headers:{}},start,{env,resolveSession:async()=>session});
  const cookie=String(start.headers['set-cookie']).split(';')[0];
  let token=decodeURIComponent(cookie.slice(cookie.indexOf('=')+1));
  if(legacy){
    const value=JSON.parse(Buffer.from(token.split('.')[0],'base64url').toString());
    delete value.session_epoch;
    const encoded=Buffer.from(JSON.stringify(value)).toString('base64url');
    token=encoded+'.'+crypto.createHmac('sha256',env.SESSION_SECRET).update(encoded).digest('hex');
  }
  let exchanges=0;
  const writes=[];
  const res=response();
  await handleSoopOAuthCallback({method:'GET',query:{code:'isolated-code',state:auditURL(start.headers.location).searchParams.get('state')},headers:{cookie:ATTEMPT_COOKIE+'='+encodeURIComponent(token)}},res,{
    env,
    revalidateSession:session=>revalidateMembership(session,{sbImpl:async table=>{
      if(table==='byeollog_workspace_members')return member?[{workspace_id:workspaceId,role:'owner',web_session_epoch:currentEpoch}]:[];
      if(table==='byeollog_workspaces')return active?[{id:workspaceId,status:'active'}]:[];
      throw new Error('Unexpected table');
    }}),
    fetchImpl:async()=>{exchanges++;return {ok:true,json:async()=>({access_token:'isolated-access',refresh_token:'isolated-refresh',expires_in:3600})}},
    sbImpl:async(table,path,options)=>{writes.push({table,path,options});return [{...options.body}]}
  });
  return {res,exchanges,writes,token,env};
}

test('SOOP start-to-callback preserves nonzero login epochs with real membership validation',async()=>{
  for(const epoch of [0,1,7]){
    const {res,exchanges,writes,token,env}=await callbackWithEpoch({epoch});
    assert.equal(verifySoopOAuthAttempt(token,{env}).session_epoch,epoch);
    assert.equal(res.statusCode,200,'valid login epoch '+epoch);
    assert.match(res.body,/계정 연결이 완료되었습니다/);
    assert.equal(exchanges,1);
    assert.equal(writes.length,2);
    assert.equal(writes[0].options.body.workspace_id,workspaceId);
    assert.doesNotMatch(String(res.headers['set-cookie']),/bangsel_admin_session=/);
  }
});

test('SOOP callback still blocks a session revoked during authorization',async()=>{
  for(const epoch of [0,1,7]){
    const {res,exchanges,writes}=await callbackWithEpoch({epoch,currentEpoch:epoch+1});
    assert.equal(res.statusCode,401);
    assert.equal(exchanges,0);
    assert.equal(writes.length,0);
  }
});

test('SOOP callback still blocks removed membership or disabled workspace at nonzero epoch',async()=>{
  for(const options of [{member:false},{active:false}]){
    const {res,exchanges,writes}=await callbackWithEpoch(options);
    assert.equal(res.statusCode,401);
    assert.equal(exchanges,0);
    assert.equal(writes.length,0);
  }
});

test('pre-patch signed attempts without epoch retain only epoch-zero compatibility',async()=>{
  for(const currentEpoch of [0,1]){
    const {res,exchanges}=await callbackWithEpoch({epoch:0,currentEpoch,legacy:true});
    assert.equal(res.statusCode,currentEpoch===0?200:401);
    assert.equal(exchanges,currentEpoch===0?1:0);
  }
});

test('OAuth epoch is signed and malformed epoch values cannot fall back to zero',()=>{
  const env=environment();
  const attempt=createSoopOAuthAttempt({user_id:userId,workspace_id:workspaceId,session_epoch:1},{env});
  const [original,signature]=attempt.token.split('.');
  const payload=JSON.parse(Buffer.from(original,'base64url').toString());
  const altered=Buffer.from(JSON.stringify({...payload,session_epoch:2})).toString('base64url');
  assert.equal(verifySoopOAuthAttempt(altered+'.'+signature,{env}),null);
  for(const epoch of [-1,1.5,'1',null,Number.MAX_SAFE_INTEGER+1]){
    const encoded=Buffer.from(JSON.stringify({...payload,session_epoch:epoch})).toString('base64url');
    const signed=encoded+'.'+crypto.createHmac('sha256',env.SESSION_SECRET).update(encoded).digest('hex');
    assert.equal(verifySoopOAuthAttempt(signed,{env}),null);
  }
  for(const epoch of [-1,1.5,'invalid',Number.MAX_SAFE_INTEGER+1]){
    assert.throws(()=>createSoopOAuthAttempt({user_id:userId,workspace_id:workspaceId,session_epoch:epoch},{env}),error=>error.code==='soop_session_epoch_invalid');
  }
});

test('OAuth start redirects to SOOP without exposing Client Secret',async()=>{
  const env=environment();
  const res=response();
  let resolverOptions;
  await handleSoopOAuthStart(
    {method:'GET',headers:{'sec-fetch-site':'same-origin'}},res,
    {env,resolveSession:async(_req,_res,_capability,options)=>{
      resolverOptions=options;
      return {user_id:userId,workspace_id:workspaceId,role:'owner'};
    }}
  );
  assert.equal(res.statusCode,302);
  const location=auditURL(res.headers.location);
  assert.equal(location.origin,'https://openapi.sooplive.com');
  assert.equal(location.pathname,'/auth/code');
  assert.equal(location.searchParams.get('client_id'),env.SOOP_CLIENT_ID);
  assert.equal(location.searchParams.has('client_secret'),false);
  assert.doesNotMatch(location.href,new RegExp(env.SOOP_CLIENT_SECRET));
  assert.match(String(res.headers['set-cookie']),new RegExp(ATTEMPT_COOKIE));
  assert.match(String(res.headers['set-cookie']),/HttpOnly; Secure; SameSite=Lax/);
  assert.deepEqual(resolverOptions,{
    navigation:true,
    loginPath:'/login?expired=1',
    retryPath:'/dashboard?soop=retry'
  });
});

test('authorization code is exchanged server-side with the official form contract',async()=>{
  const env=environment();
  let captured;
  const result=await requestSoopTokens(
    {grant_type:'authorization_code',code:'one-time-auth-code'},
    {env,fetchImpl:async(url,options)=>{
      captured={url,options};
      return {ok:true,json:async()=>({access_token:'access',refresh_token:'refresh',expires_in:'3600'})};
    }}
  );
  assert.deepEqual(result,{accessToken:'access',refreshToken:'refresh',expiresIn:3600});
  assert.equal(captured.url,'https://openapi.sooplive.com/auth/token');
  const form=new URLSearchParams(captured.options.body);
  assert.equal(form.get('grant_type'),'authorization_code');
  assert.equal(form.get('code'),'one-time-auth-code');
  assert.equal(form.get('client_id'),env.SOOP_CLIENT_ID);
  assert.equal(form.get('client_secret'),env.SOOP_CLIENT_SECRET);
});

test('active callback refuses unsolicited auth codes before token exchange',async()=>{
  const env=environment();
  let networkCalls=0;
  const res=response();
  await handleSoopOAuthCallback(
    {method:'GET',query:{authCode:'attacker-code'},headers:{}},res,
    {env,fetchImpl:async()=>{networkCalls+=1;throw new Error('must not run')}}
  );
  assert.equal(res.statusCode,400);
  assert.equal(networkCalls,0);
  assert.match(res.body,/인증 요청을 확인할 수 없습니다/);
  assert.doesNotMatch(res.body,/attacker-code/);
});

test('active callback accepts the official example code alias and stores the connection',async()=>{
  const env=environment();
  const attempt=createSoopOAuthAttempt({user_id:userId,workspace_id:workspaceId},{env,nonce:'example-code-state'});
  let stored=false;
  const res=response();
  await handleSoopOAuthCallback({
    method:'GET',query:{code:'provider-example-code',state:'example-code-state'},
    headers:{cookie:`${ATTEMPT_COOKIE}=${encodeURIComponent(attempt.token)}`}
  },res,{
    env,
    fetchImpl:async()=>({ok:true,status:200,json:async()=>({access_token:'access',refresh_token:'refresh',expires_in:3600})}),
    revalidateSession:async()=>({mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner'}),
    sbImpl:async()=>{stored=true;return [{status:'connected'}]}
  });
  assert.equal(res.statusCode,200);
  assert.equal(stored,true);
  assert.match(res.body,/계정 연결이 완료되었습니다/);
});

test('active callback rejects conflicting code aliases before token exchange',async()=>{
  const env=environment();
  let networkCalls=0;
  const res=response();
  await handleSoopOAuthCallback({
    method:'GET',query:{authCode:'one-code',code:'different-code'},headers:{}
  },res,{env,fetchImpl:async()=>{networkCalls+=1;throw new Error('must not run')}});
  assert.equal(res.statusCode,400);
  assert.equal(networkCalls,0);
  assert.match(res.body,/인증 요청을 확인할 수 없습니다/);
});

test('active callback keeps the Byeollog session when membership storage is temporarily unavailable',async()=>{
  const env=environment();
  const attempt=createSoopOAuthAttempt({user_id:userId,workspace_id:workspaceId},{env,nonce:'returned-state'});
  const res=response();
  await handleSoopOAuthCallback({
    method:'GET',query:{authCode:'one-time-code',state:'returned-state'},
    headers:{cookie:`${ATTEMPT_COOKIE}=${encodeURIComponent(attempt.token)}`}
  },res,{
    env,
    revalidateSession:async()=>{const error=new Error('temporary');error.code='session_revalidation_unavailable';error.cause={status:503};throw error},
    fetchImpl:async()=>{throw new Error('token exchange must not run')}
  });
  assert.equal(res.statusCode,503);
  assert.match(res.body,/로그인 상태 확인이 잠시 지연되고 있습니다/);
  const cookies=String(res.headers['set-cookie']);
  assert.match(cookies,new RegExp(ATTEMPT_COOKIE));
  assert.doesNotMatch(cookies,/bangsel_admin_session=/);
});

test('active callback stores only encrypted tokens and never reflects secrets',async()=>{
  const env=environment();
  const attempt=createSoopOAuthAttempt({user_id:userId,workspace_id:workspaceId},{env,nonce:'returned-state'});
  const stored=[];
  const res=response();
  await handleSoopOAuthCallback({
    method:'GET',query:{authCode:'one-time-code',state:'returned-state'},
    headers:{cookie:`${ATTEMPT_COOKIE}=${encodeURIComponent(attempt.token)}`}
  },res,{
    env,
    fetchImpl:async()=>({ok:true,json:async()=>({access_token:'plaintext-access',refresh_token:'plaintext-refresh',expires_in:3600})}),
    revalidateSession:async()=>({mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner'}),
    sbImpl:async(table,path,options)=>{stored.push({table,path,options});return [{...options.body}]}
  });
  assert.equal(res.statusCode,200);
  const connection=stored.find(call=>call.table==='byeollog_soop_connections');
  const runtime=stored.find(call=>call.table==='byeollog_soop_runtime_controls');
  assert.ok(connection);
  assert.equal(connection.options.body.workspace_id,workspaceId);
  assert.doesNotMatch(JSON.stringify(connection.options.body),/plaintext-access|plaintext-refresh|one-time-code/);
  assert.equal(decryptSoopToken(connection.options.body.access_token_ciphertext,{env}),'plaintext-access');
  assert.equal(decryptSoopToken(connection.options.body.refresh_token_ciphertext,{env}),'plaintext-refresh');
  assert.equal(runtime.options.body.core_collection_enabled,true);
  assert.equal(runtime.options.body.native_roulette_enabled,false);
  assert.doesNotMatch(res.body,/plaintext|one-time-code|returned-state/);
  assert.match(String(res.headers['set-cookie']),/Max-Age=0/);
});

test('refresh rotates encrypted tokens and keeps the latest refresh token',async()=>{
  const env=environment();
  const row={
    workspace_id:workspaceId,connected_by_user_id:userId,status:'connected',
    access_token_ciphertext:encryptSoopToken('old-access',{env}),
    refresh_token_ciphertext:encryptSoopToken('old-refresh',{env}),
    access_token_expires_at:'2026-08-29T00:00:00.000Z'
  };
  let saved;
  const sbImpl=async(table,path,options)=>{
    if(!options)return [row];
    if(options.method==='PATCH'){
      const query=new URLSearchParams(path.slice(1));
      assert.equal(query.get('refresh_token_ciphertext'),'eq.'+row.refresh_token_ciphertext);
      assert.equal(query.get('access_token_ciphertext'),'eq.'+row.access_token_ciphertext);
      assert.equal(query.get('status'),'eq.connected');
      saved=options.body;return [{...options.body}];
    }
    throw new Error('unexpected storage call');
  };
  const result=await refreshSoopConnection(workspaceId,{
    env,sbImpl,force:true,now:new Date('2026-08-29T01:00:00.000Z'),
    fetchImpl:async(url,options)=>{
      const form=new URLSearchParams(options.body);
      assert.equal(form.get('grant_type'),'refresh_token');
      assert.equal(form.get('refresh_token'),'old-refresh');
      return {ok:true,json:async()=>({access_token:'new-access',refresh_token:'new-refresh',expires_in:7200})};
    }
  });
  assert.equal(result.refreshed,true);
  assert.equal(result.accessToken,'new-access');
  assert.equal(decryptSoopToken(saved.access_token_ciphertext,{env}),'new-access');
  assert.equal(decryptSoopToken(saved.refresh_token_ciphertext,{env}),'new-refresh');
  assert.equal(Object.hasOwn(saved,'connected_at'),false);
});

test('temporary refresh failure preserves the existing connection for automatic recovery',async()=>{
  const env=environment();
  const row={workspace_id:workspaceId,connected_by_user_id:userId,status:'connected',
    access_token_ciphertext:encryptSoopToken('old-access',{env}),
    refresh_token_ciphertext:encryptSoopToken('old-refresh',{env}),
    access_token_expires_at:'2026-08-29T00:00:00.000Z'};
  let patchBody;
  await assert.rejects(refreshSoopConnection(workspaceId,{
    env,force:true,now:new Date('2026-08-29T01:00:00.000Z'),
    fetchImpl:async()=>{throw new Error('provider temporarily unreachable')},
    sbImpl:async(_table,_path,options)=>{if(!options)return [row];patchBody=options.body;return []}
  }),error=>error?.code==='soop_token_network_failed');
  assert.equal(Object.hasOwn(patchBody,'status'),false);
  assert.equal(patchBody.last_error_code,'soop_token_network_failed');
});

test('definitive refresh-token rejection marks only that connection for reauthorization',async()=>{
  const env=environment();
  const row={workspace_id:workspaceId,connected_by_user_id:userId,status:'connected',
    access_token_ciphertext:encryptSoopToken('old-access',{env}),
    refresh_token_ciphertext:encryptSoopToken('old-refresh',{env}),
    access_token_expires_at:'2026-08-29T00:00:00.000Z'};
  let patchBody;
  await assert.rejects(refreshSoopConnection(workspaceId,{
    env,force:true,now:new Date('2026-08-29T01:00:00.000Z'),
    fetchImpl:async()=>({ok:false,status:401,json:async()=>({error:'invalid_grant'})}),
    sbImpl:async(_table,_path,options)=>{if(!options)return [row];patchBody=options.body;return []}
  }),error=>error?.code==='soop_token_exchange_failed'&&error?.upstreamStatus===401);
  assert.equal(patchBody.status,'reauthorization_required');
});

test('self-check validates or refreshes tokens server-side without returning token material',async()=>{
  const env=environment();
  const res=response();
  let requestedWorkspace;
  await handleSoopOAuthDiagnose({
    method:'POST',headers:{origin:'https://byeollog.com',host:'byeollog.com','x-forwarded-proto':'https','content-type':'application/json','sec-fetch-site':'same-origin'}
  },res,{
    env,
    resolveSession:async()=>({user_id:userId,workspace_id:workspaceId,role:'owner'}),
    refreshConnection:async workspace=>{requestedWorkspace=workspace;return {accessToken:'must-never-leak',expiresAt:'2026-08-29T03:00:00.000Z',refreshed:true}}
  });
  assert.equal(requestedWorkspace,workspaceId);
  assert.equal(res.statusCode,200);
  assert.equal(res.body.tokenStatus,'refreshed');
  assert.equal(res.body.chatStatus,'waiting_for_live_verification');
  assert.doesNotMatch(JSON.stringify(res.body),/must-never-leak/);
});

test('self-check rejects cross-site requests before token access',async()=>{
  const res=response();
  let called=false;
  await handleSoopOAuthDiagnose({method:'POST',headers:{'sec-fetch-site':'cross-site','content-type':'application/json'}},res,{
    env:environment(),resolveSession:async()=>{called=true;return null}
  });
  assert.equal(res.statusCode,403);
  assert.equal(called,false);
});

test('disconnect deletes only the signed-in workspace connection and disables collection',async()=>{
  const calls=[];
  const res=response();
  await handleSoopOAuthDisconnect({
    method:'POST',
    headers:{origin:'https://byeollog.com',host:'byeollog.com','x-forwarded-proto':'https','content-type':'application/json','sec-fetch-site':'same-origin'}
  },res,{
    resolveSession:async()=>({user_id:userId,workspace_id:workspaceId,role:'owner'}),
    sbImpl:async(table,path,options)=>{calls.push({table,path,options});return []}
  });
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{ok:true,connected:false,status:'not_connected'});
  const connection=calls.find(call=>call.table==='byeollog_soop_connections');
  const runtime=calls.find(call=>call.table==='byeollog_soop_runtime_controls');
  assert.ok(connection);
  assert.match(connection.path,new RegExp(`workspace_id=eq\\.${workspaceId}`));
  assert.equal(connection.options.method,'DELETE');
  assert.equal(runtime.options.body.core_collection_enabled,false);
  assert.equal(runtime.options.body.gateway_enabled,false);
});

test('disconnect rejects cross-site and non-JSON browser requests',async()=>{
  const crossSite=response();
  await handleSoopOAuthDisconnect({method:'POST',headers:{'sec-fetch-site':'cross-site','content-type':'application/json'}},crossSite,{
    resolveSession:async()=>{throw new Error('must not authenticate')}
  });
  assert.equal(crossSite.statusCode,403);

  const form=response();
  await handleSoopOAuthDisconnect({method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'}},form,{
    resolveSession:async()=>{throw new Error('must not authenticate')}
  });
  assert.equal(form.statusCode,415);
});

test('OAuth token schema remains dormant and denies direct browser access',async()=>{
  const sql=await readFile(auditURL('../supabase/dormant-migrations/20260828160441_add_soop_oauth_connections.sql',import.meta.url),'utf8');
  assert.match(sql,/create table public\.byeollog_soop_connections/i);
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/for all to anon, authenticated[\s\S]*using \(false\) with check \(false\)/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant select,insert,update,delete[\s\S]*to service_role/i);
});

// These legacy cases isolate session epochs, role changes, and encryption.
// The newly required identity stage gets a deterministic fixture; real identity
// parsing and mismatch/no-write behavior are tested in soop-identity-current.test.mjs.
function handleSoopOAuthCallback(req,res,deps={}) {
 return productionSoopOAuthCallback(req,res,{resolveAccountIdentity:async()=>({userId:"fixture_streamer"}),resolveWorkspaceIdentity:async()=>"fixture_streamer",...deps});
}
