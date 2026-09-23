import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MembershipRevalidationUnavailableError,
  createSessionToken,
  requireCapabilityLive,
  revalidateMembership
} from '../../apps/admin-runtime/lib/auth.js';

const userId='20000000-0000-4000-8000-000000000001';
const workspaceId='10000000-0000-4000-8000-000000000001';

function response(){
  return {
    headers:{},statusCode:200,body:null,ended:false,
    setHeader(name,value){this.headers[String(name).toLowerCase()]=value},
    status(code){this.statusCode=code;return this},
    json(value){this.body=value;this.ended=true;return this},
    end(){this.ended=true;return this}
  };
}

function session(){return {mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner',session_epoch:0}}
function requestWithSession(value=session()){
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='test-session-secret-that-is-longer-than-32-characters';
  const token=createSessionToken(value);
  if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous;
  return {headers:{cookie:`bangsel_admin_session=${encodeURIComponent(token)}`}};
}

test('membership revalidation retries a transient Supabase failure without expiring the session',async()=>{
  let calls=0;
  const result=await revalidateMembership(session(),{
    retryDelayMs:0,
    sbImpl:async table=>{
      calls+=1;
      if(calls===1){const error=new Error('temporary upstream failure');error.status=503;throw error}
      if(table==='byeollog_workspace_members')return [{workspace_id:workspaceId,role:'owner'}];
      return [{id:workspaceId,status:'active'}];
    }
  });
  assert.equal(result.workspace_id,workspaceId);
  assert.equal(result.role,'owner');
  assert.equal(calls,3);
});

test('membership revalidation distinguishes a confirmed missing membership from an unavailable backend',async()=>{
  const missing=await revalidateMembership(session(),{retryDelayMs:0,sbImpl:async()=>[]});
  assert.equal(missing,null);
  await assert.rejects(
    revalidateMembership(session(),{retryDelayMs:0,sbImpl:async()=>{const error=new Error('network down');error.status=503;throw error}}),
    error=>error instanceof MembershipRevalidationUnavailableError&&error.code==='session_revalidation_unavailable'
  );
});

test('membership revalidation rejects a cookie from an older web session epoch without another query',async()=>{
  let calls=0;
  const revoked=await revalidateMembership({...session(),session_epoch:2},{
    retryDelayMs:0,
    sbImpl:async table=>{
      calls+=1;
      if(table==='byeollog_workspace_members')return [{workspace_id:workspaceId,role:'owner',web_session_epoch:3}];
      return [{id:workspaceId,status:'active'}];
    }
  });
  assert.equal(revoked,null);
  assert.equal(calls,1,'epoch rejection must reuse the existing membership query');
});

test('collector handoff revalidation restores the device owner identity for existing cookies',async()=>{
  const deviceId='30000000-0000-4000-8000-000000000001';
  const tables=[];
  const result=await revalidateMembership({
    mode:'collector_handoff',workspace_id:workspaceId,collector_device_id:deviceId,role:'owner',session_epoch:4
  },{
    retryDelayMs:0,
    sbImpl:async table=>{
      tables.push(table);
      if(table==='byeollog_collector_devices')return [{
        id:deviceId,workspace_id:workspaceId,status:'active',created_by_user_id:userId
      }];
      if(table==='byeollog_workspace_members')return [{workspace_id:workspaceId,role:'editor',web_session_epoch:4}];
      if(table==='byeollog_workspaces')return [{id:workspaceId,status:'active'}];
      return [];
    }
  });
  assert.equal(result.user_id,userId);
  assert.equal(result.role,'editor');
  assert.deepEqual(tables,[
    'byeollog_collector_devices','byeollog_workspace_members','byeollog_workspaces'
  ]);
});

test('collector handoff revalidation rejects devices without a bound active member',async()=>{
  const deviceId='30000000-0000-4000-8000-000000000002';
  const missingOwner=await revalidateMembership({
    mode:'collector_handoff',workspace_id:workspaceId,collector_device_id:deviceId,role:'owner'
  },{
    retryDelayMs:0,
    sbImpl:async table=>table==='byeollog_collector_devices'
      ?[{id:deviceId,workspace_id:workspaceId,status:'active',created_by_user_id:null}]
      :[]
  });
  assert.equal(missingOwner,null);

  const missingMembership=await revalidateMembership({
    mode:'collector_handoff',workspace_id:workspaceId,collector_device_id:deviceId,role:'owner'
  },{
    retryDelayMs:0,
    sbImpl:async table=>table==='byeollog_collector_devices'
      ?[{id:deviceId,workspace_id:workspaceId,status:'active',created_by_user_id:userId}]
      :[]
  });
  assert.equal(missingMembership,null);
});

test('live authorization keeps the cookie and returns retryable 503 when membership storage is unavailable',async()=>{
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='test-session-secret-that-is-longer-than-32-characters';
  try{
    const res=response();
    await requireCapabilityLive(requestWithSession(),res,'roulette:configure',{
      revalidateSession:async()=>{throw new MembershipRevalidationUnavailableError(Object.assign(new Error('upstream'),{status:503}))}
    });
    assert.equal(res.statusCode,503);
    assert.equal(res.body.code,'session_revalidation_unavailable');
    assert.equal(res.body.retryable,true);
    assert.equal(res.headers['set-cookie'],undefined);
  }finally{if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous}
});

test('SOOP navigation redirects safely instead of exposing JSON and does not clear a valid cookie on transient failure',async()=>{
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='test-session-secret-that-is-longer-than-32-characters';
  try{
    const res=response();
    await requireCapabilityLive(requestWithSession(),res,'roulette:configure',{
      navigation:true,
      retryPath:'/dashboard?soop=retry',
      revalidateSession:async()=>{throw new MembershipRevalidationUnavailableError(new Error('upstream'))}
    });
    assert.equal(res.statusCode,303);
    assert.equal(res.headers.location,'/dashboard?soop=retry');
    assert.equal(res.headers['set-cookie'],undefined);
  }finally{if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous}
});

test('SOOP navigation clears the cookie only when membership absence is confirmed',async()=>{
  const previous=process.env.SESSION_SECRET;
  process.env.SESSION_SECRET='test-session-secret-that-is-longer-than-32-characters';
  try{
    const res=response();
    await requireCapabilityLive(requestWithSession(),res,'roulette:configure',{
      navigation:true,
      revalidateSession:async()=>null
    });
    assert.equal(res.statusCode,303);
    assert.equal(res.headers.location,'/login?expired=1');
    assert.match(String(res.headers['set-cookie']),/Max-Age=0/);
  }finally{if(previous===undefined)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=previous}
});

test('all dashboard HTML entry points use navigation auth while API operations keep JSON auth',async()=>{
  const {readFile}=await import('node:fs/promises');
  const [admin,rollout,changePassword,withdraw,loginPage]=await Promise.all([
    readFile(auditURL('../api/admin.js',import.meta.url),'utf8'),
    readFile(auditURL('../lib/agent-rollout-html.js',import.meta.url),'utf8'),
    readFile(auditURL('../assets/change-password-page.js',import.meta.url),'utf8'),
    readFile(auditURL('../assets/withdraw-page.js',import.meta.url),'utf8'),
    readFile(auditURL('../assets/login-page.js',import.meta.url),'utf8')
  ]);
  assert.match(admin,/DASHBOARD_NAVIGATION_AUTH=\{navigation:true,loginPath:'\/login\?expired=1',retryPath:'\/login\?check=retry'\}/);
  assert.match(admin,/handleAgentRolloutPage[\s\S]*requireCapabilityLive\(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH\)/);
  assert.match(admin,/handleProductControlPage[\s\S]*requireCapabilityLive\(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH\)/);
  assert.match(admin,/const pageStartedAt[\s\S]*requireCapabilityLive\(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH\)/);
  assert.match(admin,/const isBrowserPage=!operation\|\|view==='agent-rollout'\|\|\['roulette','actions','signatures','wallpaper','roulette-rules'\]\.includes\(view\)/);
  assert.match(admin,/if\(!isBrowserPage\)return res\.status\(401\)\.json\(\{message:'Unauthorized'\}\)/);
  assert.match(admin,/operation==='context'[\s\S]*requireCapabilityLive\(req,res,'data:read'\)/);
  assert.match(rollout,/response\.status===401[\s\S]*location\.replace\('\/login\?expired=1'\)/);
  for(const source of [changePassword,withdraw]){
    assert.match(source,/fetch\('\/api\/admin\?operation=context'/);
    assert.match(source,/response\.status===401[\s\S]*location\.replace\('\/login\?expired=1'\)/);
  }
  assert.match(loginPage,/loginParams\.get\('check'\)==='retry'/);
});
