import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  ATTEMPT_COOKIE,
  createSoopOAuthAttempt,
  decryptSoopToken,
  encryptSoopToken,
  getSoopOAuthReadiness,
  handleSoopOAuthCallback,
  handleSoopOAuthDiagnose,
  handleSoopOAuthDisconnect,
  handleSoopOAuthStart,
  refreshSoopConnection,
  requestSoopTokens,
  verifySoopOAuthAttempt
} from '../lib/soop-oauth.js';

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
  const location=new URL(res.headers.location);
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
  let stored;
  const res=response();
  await handleSoopOAuthCallback({
    method:'GET',query:{authCode:'one-time-code',state:'returned-state'},
    headers:{cookie:`${ATTEMPT_COOKIE}=${encodeURIComponent(attempt.token)}`}
  },res,{
    env,
    fetchImpl:async()=>({ok:true,json:async()=>({access_token:'plaintext-access',refresh_token:'plaintext-refresh',expires_in:3600})}),
    revalidateSession:async()=>({mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner'}),
    sbImpl:async(table,path,options)=>{stored={table,path,options};return [{...options.body}]}
  });
  assert.equal(res.statusCode,200);
  assert.equal(stored.table,'byeollog_soop_connections');
  assert.equal(stored.options.body.workspace_id,workspaceId);
  assert.doesNotMatch(JSON.stringify(stored.options.body),/plaintext-access|plaintext-refresh|one-time-code/);
  assert.equal(decryptSoopToken(stored.options.body.access_token_ciphertext,{env}),'plaintext-access');
  assert.equal(decryptSoopToken(stored.options.body.refresh_token_ciphertext,{env}),'plaintext-refresh');
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
    if(options.method==='POST'){saved=options.body;return [{...options.body}]}
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

test('disconnect deletes only the signed-in workspace connection',async()=>{
  let call;
  const res=response();
  await handleSoopOAuthDisconnect({
    method:'POST',
    headers:{origin:'https://byeollog.com',host:'byeollog.com','x-forwarded-proto':'https','content-type':'application/json','sec-fetch-site':'same-origin'}
  },res,{
    resolveSession:async()=>({user_id:userId,workspace_id:workspaceId,role:'owner'}),
    sbImpl:async(table,path,options)=>{call={table,path,options};return []}
  });
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{ok:true,connected:false,status:'not_connected'});
  assert.equal(call.table,'byeollog_soop_connections');
  assert.match(call.path,new RegExp(`workspace_id=eq\\.${workspaceId}`));
  assert.equal(call.options.method,'DELETE');
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
  const sql=await readFile(new URL('../supabase/dormant-migrations/20260828160441_add_soop_oauth_connections.sql',import.meta.url),'utf8');
  assert.match(sql,/create table public\.byeollog_soop_connections/i);
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/for all to anon, authenticated[\s\S]*using \(false\) with check \(false\)/i);
  assert.match(sql,/revoke all[\s\S]*from public,anon,authenticated,service_role/i);
  assert.match(sql,/grant select,insert,update,delete[\s\S]*to service_role/i);
});
