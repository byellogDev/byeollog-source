import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {handleAgentDashboardHandoff} from '../../apps/admin-runtime/lib/agent-dashboard-handoff.js';
import {revalidateMembership,getSession,createSessionToken,setSessionCookie,requireCapabilityLive} from '../../apps/admin-runtime/lib/auth.js';
import {ATTEMPT_COOKIE,handleSoopOAuthStart,handleSoopOAuthCallback as productionSoopOAuthCallback,verifySoopOAuthAttempt} from '../../apps/admin-runtime/lib/soop-oauth.js';

process.env.SESSION_SECRET='isolated-dashboard-test-secret-not-production';
const workspaceId='11111111-1111-4111-8111-111111111111',userId='22222222-2222-4222-8222-222222222222';
function fixture(){
  let clock=Date.now(),role='viewer',epoch=3,active=true,member=true,authStatus=200;
  const rows=new Map(),calls=[];
  async function sbImpl(table,path='',options={}){
    calls.push({table,path,options});
    if(table==='byeollog_workspace_members')return member?[{workspace_id:workspaceId,role,web_session_epoch:epoch}]:[];
    if(table==='byeollog_workspaces')return active?[{id:workspaceId,status:'active'}]:[];
    assert.equal(table,'byeollog_agent_dashboard_handoffs');
    const params=new URLSearchParams(path.replace(/^\?/,''));
    if(options.method==='POST'){rows.set(options.body.code_hash,options.body);return []}
    assert.equal(options.method,'DELETE');
    const key=params.get('code_hash')?.slice(3);
    if(key){
      const row=rows.get(key),cutoff=Date.parse(params.get('expires_at').slice(3));
      if(!row||Date.parse(row.expires_at)<=cutoff)return [];
      rows.delete(key);return [row];
    }
    for(const [key,row] of rows)if(Date.parse(row.expires_at)<clock)rows.delete(key);
    return [];
  }
  const deps={sbImpl,now:()=>clock,rateLimit:async()=>false,authorize:async(token,id)=>{
    assert.equal(token,'current-account-token');
    return {status:id===workspaceId?authStatus:403,code:'agent_workspace_forbidden',user:{id:userId},membership:{web_session_epoch:epoch}};
  },revalidate:session=>revalidateMembership(session,{sbImpl,retryDelayMs:0})};
  async function request(operation,body={},headers={}){
    const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},status(code){this.statusCode=code;return this},json(body){this.body=body;return this}};
    await handleAgentDashboardHandoff({method:'POST',query:{operation},headers:{host:'byeollog.com','x-forwarded-proto':'https','content-type':'application/json',authorization:'Bearer current-account-token',...headers},body},res,deps);
    return res;
  }
  return {request,rows,calls,deps,advance:ms=>clock+=ms,setRole:v=>role=v,setEpoch:v=>epoch=v,setActive:v=>active=v,setMember:v=>member=v,setAuth:v=>authStatus=v};
}
async function issue(f){const result=await f.request('agent-dashboard-handoff',{workspaceId});assert.equal(result.statusCode,200);return result.body.dashboard_url.split('=')[1]}

test('new account with no collector device issues and consumes current-account handoff',async()=>{
  const f=fixture(),code=await issue(f),row=[...f.rows.values()][0];
  assert.equal(code.length,43);assert.notEqual(row.code_hash,code);assert.equal(row.user_id,userId);
  const result=await f.request('agent-dashboard-login',{code});assert.equal(result.statusCode,200);
  const cookie=result.headers['Set-Cookie'];assert.match(String(cookie),/HttpOnly/);assert.match(String(cookie),/Secure/);
  const session=getSession({headers:{cookie:String(cookie).split(';')[0]}});
  assert.equal(session.user_id,userId);assert.equal(session.workspace_id,workspaceId);assert.equal(session.role,'viewer');assert.equal(session.mode,'beta');
  assert.equal(f.rows.size,0);assert.equal(f.calls.some(x=>x.table.includes('collector')),false);
});
test('same code can be consumed once even by concurrent callers',async()=>{
  const f=fixture(),code=await issue(f);
  const results=await Promise.all([f.request('agent-dashboard-login',{code}),f.request('agent-dashboard-login',{code})]);
  assert.deepEqual(results.map(x=>x.statusCode).sort(),[200,401]);
});

test('dashboard shortcut and direct web sessions both preserve epoch through SOOP authorization',async()=>{
  const env={SOOP_OAUTH_ENABLED:'true',SESSION_SECRET:process.env.SESSION_SECRET,
    SOOP_CLIENT_ID:'isolated_client_1234567890123456',SOOP_CLIENT_SECRET:'isolated_secret_1234567890123456789012',
    SOOP_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,19).toString('base64url')};
  const response=()=>({statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},getHeader(k){return this.headers[k]},
    status(n){this.statusCode=n;return this},end(){return this},send(body){this.body=body;return this},json(body){this.body=body;return this}});
  for(const entry of ['agent-shortcut','direct-web'])for(const mode of ['fixed','pre-patch','revoked']){
    const f=fixture();f.setRole('owner');f.setEpoch(1);
    let login;
    if(entry==='agent-shortcut')login=await f.request('agent-dashboard-login',{code:await issue(f)});
    else{
      login=response();
      setSessionCookie(login,createSessionToken({mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner',session_epoch:1}));
    }
    const loginCookie=String(login.headers['Set-Cookie']).split(';')[0];
    assert.equal(getSession({headers:{cookie:loginCookie}}).session_epoch,1,entry);
    const start=response();
    await handleSoopOAuthStart({method:'GET',headers:{cookie:loginCookie,'sec-fetch-site':'same-origin'}},start,{
      env,resolveSession:(req,res,capability,options)=>requireCapabilityLive(req,res,capability,{...options,revalidateSession:f.deps.revalidate})
    });
    assert.equal(start.statusCode,302,entry);
    let attemptToken=decodeURIComponent(String(start.headers['Set-Cookie']).split(';')[0].split('=')[1]);
    const signedAttempt=verifySoopOAuthAttempt(attemptToken,{env});
    assert.equal(signedAttempt.session_epoch,1,entry);
    if(mode==='pre-patch'){
      // Recreate the exact old signed payload, not a mocked validator result.
      const payload=JSON.parse(Buffer.from(attemptToken.split('.')[0],'base64url').toString());
      delete payload.session_epoch;
      const encoded=Buffer.from(JSON.stringify(payload)).toString('base64url');
      attemptToken=encoded+'.'+crypto.createHmac('sha256',env.SESSION_SECRET).update(encoded).digest('hex');
    }
    if(mode==='revoked')f.setEpoch(2);
    const callback=response();let exchangeCount=0,writeCount=0;
    // SOOP cross-site return may omit the Strict web-session cookie. The Lax
    // signed attempt must carry everything needed for live revalidation.
    await handleSoopOAuthCallback({method:'GET',headers:{cookie:ATTEMPT_COOKIE+'='+encodeURIComponent(attemptToken)},query:{code:'isolated-auth-code',state:signedAttempt.nonce}},callback,{
      env,revalidateSession:f.deps.revalidate,
      fetchImpl:async()=>{exchangeCount++;return {ok:true,json:async()=>({access_token:'isolated-access',refresh_token:'isolated-refresh',expires_in:3600})}},
      sbImpl:async(_table,_path,options)=>{writeCount++;assert.equal(options.body.workspace_id,workspaceId);return [{...options.body}]}
    });
    assert.equal(callback.statusCode,mode==='fixed'?200:401,entry+'/'+mode);
    assert.equal(exchangeCount,mode==='fixed'?1:0,entry+'/'+mode);
    assert.equal(writeCount,mode==='fixed'?2:0,entry+'/'+mode);
    if(mode==='fixed')assert.match(callback.body,/계정 연결이 완료되었습니다/);
  }
});
test('expired and fabricated links do not create cookies; expired rows are pruned on next issue',async()=>{
  const f=fixture(),code=await issue(f);f.advance(45001);
  for(const candidate of [code,'x'.repeat(43)]){const res=await f.request('agent-dashboard-login',{code:candidate});assert.equal(res.statusCode,401);assert.equal(res.headers['Set-Cookie'],undefined)}
  await issue(f);assert.equal(f.rows.size,1);
});
test('membership removal, inactive workspace and session revocation invalidate issued links',async()=>{
  for(const mutate of [f=>f.setMember(false),f=>f.setActive(false),f=>f.setEpoch(4)]){
    const f=fixture(),code=await issue(f);mutate(f);
    const res=await f.request('agent-dashboard-login',{code});assert.equal(res.statusCode,403);assert.equal(res.headers['Set-Cookie'],undefined);
  }
});
test('redeem uses current membership role, not a stale or client supplied role',async()=>{
  const f=fixture();f.setRole('owner');const code=await issue(f);f.setRole('viewer');
  const res=await f.request('agent-dashboard-login',{code,role:'owner',user_id:'attacker'});
  const session=getSession({headers:{cookie:String(res.headers['Set-Cookie']).split(';')[0]}});assert.equal(session.role,'viewer');assert.equal(session.user_id,userId);
});
test('invalid bearer, unauthorized workspace and cross-site requests fail without issuance',async()=>{
  const f=fixture();
  assert.equal((await f.request('agent-dashboard-handoff',{workspaceId},{authorization:''})).statusCode,401);
  assert.equal((await f.request('agent-dashboard-handoff',{workspaceId:'33333333-3333-4333-8333-333333333333'})).statusCode,403);
  for(const status of [401,403]){f.setAuth(status);assert.equal((await f.request('agent-dashboard-handoff',{workspaceId})).statusCode,status)}
  assert.equal((await f.request('agent-dashboard-handoff',{workspaceId},{origin:'https://evil.invalid','sec-fetch-site':'cross-site'})).statusCode,403);
  assert.equal(f.rows.size,0);
});
test('cross-site redemption, wrong content type and rate limits cannot create cookies',async()=>{
  const f=fixture(),code=await issue(f);
  assert.equal((await f.request('agent-dashboard-login',{code},{origin:'https://evil.invalid'})).statusCode,403);
  assert.equal((await f.request('agent-dashboard-login',{code},{'content-type':'text/plain'})).statusCode,415);
  f.deps.rateLimit=async()=>true;assert.equal((await f.request('agent-dashboard-login',{code})).statusCode,429);assert.equal(f.rows.size,1);
});
test('browser removes account handoff fragment before exchange and retains legacy route',async()=>{
  const source=await readFile(auditURL('../assets/login-page.js',import.meta.url),'utf8');
  for(const [fragment,operation] of [['agent_handoff','agent-dashboard-login'],['handoff','handoff']]){
    const events=[],elements={loginForm:{querySelectorAll:()=>[],addEventListener(){}},msg:{}};
    vm.runInNewContext(source,{location:{search:'',hash:`#${fragment}=${'a'.repeat(43)}`,replace(){}},history:{replaceState(){events.push('clear')}},document:{getElementById:id=>elements[id]},URLSearchParams,fetch(url,options){events.push(url);assert.equal(JSON.parse(options.body).code,'a'.repeat(43));return new Promise(()=>{})}});
    assert.deepEqual(events,['clear',`/api/login?operation=${operation}`]);
  }
});

// These legacy cases isolate session epochs, role changes, and encryption.
// The newly required identity stage gets a deterministic fixture; real identity
// parsing and mismatch/no-write behavior are tested in soop-identity-current.test.mjs.
function handleSoopOAuthCallback(req,res,deps={}) {
 return productionSoopOAuthCallback(req,res,{resolveAccountIdentity:async()=>({userId:"fixture_streamer"}),resolveWorkspaceIdentity:async()=>"fixture_streamer",...deps});
}
