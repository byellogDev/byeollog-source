import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MembershipRevalidationUnavailableError,
  createSessionToken,
  requireCapabilityLive,
  revalidateMembership
} from '../lib/auth.js';

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

function session(){return {mode:'beta',user_id:userId,workspace_id:workspaceId,role:'owner'}}
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
