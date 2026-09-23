import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionToken,getSession,revalidateMembership} from '../lib/auth.js';
import {ATTEMPT_COOKIE,createSoopOAuthAttempt,encryptSoopToken,decryptSoopToken,handleSoopOAuthCallback,refreshSoopConnection,requestSoopTokens} from '../lib/soop-oauth.js';

const workspace='10000000-0000-4000-8000-000000000001',user='20000000-0000-4000-8000-000000000001';
const env={SESSION_SECRET:'strict-audit-test-secret-not-production'.repeat(2),SOOP_OAUTH_ENABLED:'true',SOOP_CLIENT_ID:'strict-test-client-id',SOOP_CLIENT_SECRET:'strict-test-client-secret',SOOP_TOKEN_ENCRYPTION_KEY:'ab'.repeat(32)};
process.env.SESSION_SECRET=env.SESSION_SECRET;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const response=()=>({headers:{},statusCode:0,setHeader(k,v){this.headers[k]=v},status(v){this.statusCode=v;return this},send(v){this.body=v;return this}});
function fixture(){
  let row={workspace_id:workspace,connected_by_user_id:user,status:'connected',access_token_ciphertext:encryptSoopToken('old-access',{env}),refresh_token_ciphertext:encryptSoopToken('old-refresh',{env}),access_token_expires_at:new Date(0).toISOString()};
  const writes=[];
  return {get row(){return row},set row(v){row=v},writes,
    async sbImpl(table,path,options){
      assert.equal(table,'byeollog_soop_connections');
      if(!options)return row&&row.status==='connected'?[{...row}]:[];
      assert.equal(options.method,'PATCH','refresh must never recreate a deleted row');
      const q=new URLSearchParams(path.slice(1));
      assert.equal(q.get('workspace_id'),'eq.'+workspace);
      for(const column of ['status','access_token_ciphertext','refresh_token_ciphertext']){
        assert.ok(q.has(column),'missing compare-and-swap predicate '+column);
        if(!row||q.get(column)!=='eq.'+row[column])return [];
      }
      writes.push(options.body);row={...row,...options.body};return [{...row}];
    }
  };
}
test('broken unrelated cookies preserve login; malformed own cookie fails closed',()=>{
  const token=createSessionToken({user_id:user,workspace_id:workspace,role:'owner'});
  for(const suffix of ['; unrelated=%E0%A4%A','; %E0%A4%A=value','; unrelated=ok']){
    assert.equal(getSession({headers:{cookie:'bangsel_admin_session='+token+suffix}})?.user_id,user);
  }
  assert.equal(getSession({headers:{cookie:'bangsel_admin_session=%E0%A4%A'}}),null);
  assert.equal(getSession({headers:{cookie:'bangsel_admin_session='+token+'; bangsel_admin_session=%E0%A4%A'}}),null);
});

test('callback revalidates current capability without logging out normal owner/editor',async()=>{
  for(const role of ['owner','editor','viewer']){
    const attempt=createSoopOAuthAttempt({user_id:user,workspace_id:workspace,session_epoch:7},{env});
    let exchanges=0,writes=0;
    const res=response();
    await handleSoopOAuthCallback({method:'GET',query:{code:'test-code',state:attempt.state},headers:{cookie:ATTEMPT_COOKIE+'='+attempt.token}},res,{
      env,revalidateSession:s=>revalidateMembership(s,{sbImpl:async table=>table==='byeollog_workspace_members'?[{role,workspace_id:workspace,web_session_epoch:7}]:[{id:workspace,status:'active'}]}),
      fetchImpl:async()=>{exchanges++;return {ok:true,json:async()=>({access_token:'test-access',refresh_token:'test-refresh',expires_in:3600})}},
      sbImpl:async()=>{writes++;return [{}]}
    });
    assert.equal(res.statusCode,role==='viewer'?403:200);
    assert.equal(writes,role==='viewer'?0:2);
    assert.equal(exchanges,role==='viewer'?0:1);
    assert.doesNotMatch(String(res.headers['Set-Cookie']),/bangsel_admin_session/);
  }
});

test('refresh cannot resurrect a connection deleted while provider response was pending',async()=>{
  const f=fixture(),started=deferred(),finish=deferred();
  const operation=refreshSoopConnection(workspace,{env,sbImpl:f.sbImpl,force:true,fetchImpl:async()=>{started.resolve();await finish.promise;return {ok:true,json:async()=>({access_token:'late',refresh_token:'late-refresh',expires_in:3600})}}});
  await started.promise;f.row=null;finish.resolve();
  await assert.rejects(operation,e=>e.code==='soop_connection_changed');
  assert.equal(f.row,null);assert.equal(f.writes.length,0);
});

for(const outcome of ['success','invalid-grant','network-failure']){
  test('late refresh '+outcome+' cannot overwrite or invalidate a newer connection',async()=>{
    const f=fixture(),started=deferred(),finish=deferred();
    const operation=refreshSoopConnection(workspace,{env,sbImpl:f.sbImpl,force:true,fetchImpl:async()=>{
      started.resolve();await finish.promise;
      if(outcome==='network-failure')throw Error('offline');
      return outcome==='invalid-grant'?{ok:false,status:401,json:async()=>({})}:{ok:true,json:async()=>({access_token:'late',refresh_token:'late-refresh',expires_in:3600})};
    }});
    await started.promise;
    f.row={...f.row,access_token_ciphertext:encryptSoopToken('new-login-access',{env}),refresh_token_ciphertext:encryptSoopToken('new-login-refresh',{env}),access_token_expires_at:new Date(Date.now()+3600000).toISOString()};
    finish.resolve();const result=await operation;
    assert.equal(result.accessToken,'new-login-access');assert.equal(f.row.status,'connected');
    assert.equal(f.writes.length,0);assert.equal(decryptSoopToken(f.row.refresh_token_ciphertext,{env}),'new-login-refresh');
  });
}

test('token deadline remains active during stalled response body, not only headers',async()=>{
  const original=globalThis.setTimeout;
  // Exercise the actual internally-created ten-second timer without a ten-second test.
  globalThis.setTimeout=(fn,ms,...args)=>original(fn,ms===10000?25:ms,...args);
  try{
    let observed;
    await assert.rejects(requestSoopTokens({grant_type:'authorization_code',code:'test'},{env,fetchImpl:async(_url,{signal})=>{
      observed=signal;return {ok:true,json:()=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('body aborted')),{once:true}))};
    }}),e=>e.code==='soop_token_network_failed');
    assert.equal(observed.aborted,true);
  }finally{globalThis.setTimeout=original}
});
