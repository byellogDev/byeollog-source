import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {handleReferrerSearch,handleSignup} from '../../apps/web/lib/signup.js';
import {BACKUP_TABLES} from '../../apps/web/lib/backup.js';

const source=path=>readFile(auditURL(`../${path}`,import.meta.url),'utf8');

function request(body){
  return {
    method:'POST',
    headers:{
      origin:'https://byeollog.com',
      host:'byeollog.com',
      'x-forwarded-proto':'https',
      'sec-fetch-site':'same-origin',
      'content-type':'application/json'
    },
    socket:{remoteAddress:'127.0.0.1'},
    body:{consents:{termsVersion:"2026-10-11",privacyVersion:"2026-10-11",termsAgreed:true,collectionAgreed:true,age14Confirmed:true},...body}
  };
}

function response(){
  return {
    statusCode:0,body:null,headers:{},
    setHeader(name,value){this.headers[name]=value},
    status(code){this.statusCode=code;return this},
    json(body){this.body=body;return this}
  };
}

const noLimit=async()=>false;
const verifiedSignup={tokenHash:'a'.repeat(64),userId:'verified_streamer'};
const signupDeps=overrides=>({
  rateLimit:noLimit,pendingResolver:async()=>verifiedSignup,
  createAuthUser:async()=>({id:'20000000-0000-4000-8000-000000000002'}),
  deleteAuthUserImpl:async()=>{},sendSetupEmail:async()=>true,...overrides
});

test('referrer search returns only the minimal public result shape',async()=>{
  const calls=[];
  const sbImpl=async(resource,query,options)=>{
    calls.push({resource,query,options});
    return [
      {workspace_slug:'starfriend-a',streamer_name:'별친구A',private_value:'never expose'},
      {workspace_slug:'INVALID SPACE',streamer_name:'제외'}
    ];
  };
  const res=response();
  await handleReferrerSearch(request({query:'별친'}),res,{sbImpl,rateLimit:noLimit});
  assert.equal(res.statusCode,200);
  assert.deepEqual(res.body,{streamers:[{key:'starfriend-a',name:'별친구A'}]});
  assert.equal(calls[0].resource,'rpc/byeollog_search_referrable_streamers_v1');
  assert.deepEqual(calls[0].options.body,{p_query:'별친',p_limit:10});
});

test('signup resolves a selected streamer and atomically provisions the verified SOOP identity',async()=>{
  const calls=[];
  const sbImpl=async(resource,query,options={})=>{
    calls.push({resource,query,options});
    if(resource==='rpc/byeollog_resolve_referrable_streamer_v1')return [{
      workspace_id:'11111111-1111-4111-8111-111111111111',
      workspace_slug:'starfriend-a',
      streamer_name:'별친구A'
    }];
    if(resource==='rpc/byeollog_complete_oauth_signup_v2')return [{application_id:'application-id',workspace_id:'workspace-id',workspace_slug:'verified_streamer'}];
    if(resource==='rpc/byeollog_record_setup_email')return [];
    throw new Error(`unexpected call: ${resource}`);
  };
  const res=response();
  await handleSignup(request({
    email:'new@example.com',streamer_name:'신규',
    referrer_workspace_slug:'starfriend-a',note:''
  }),res,signupDeps({sbImpl}));
  assert.equal(res.statusCode,201);
  const resolver=calls.find(call=>call.resource==='rpc/byeollog_resolve_referrable_streamer_v1');
  assert.deepEqual(resolver.options.body,{p_workspace_slug:'starfriend-a'});
  const complete=calls.find(call=>call.resource==='rpc/byeollog_complete_oauth_signup_v2');
  assert.equal(complete.options.body.p_pending_token_hash,'a'.repeat(64));
  assert.equal(complete.options.body.p_referrer_workspace_slug,'starfriend-a');
  assert.equal(Object.hasOwn(complete.options.body,'p_soop_id'),false);
});

test('signup without a referrer completes without inventing referral data',async()=>{
  const calls=[];
  const sbImpl=async(resource,query,options={})=>{
    calls.push({resource,query,options});
    if(resource==='rpc/byeollog_complete_oauth_signup_v2')return [{application_id:'application-id',workspace_id:'workspace-id',workspace_slug:'verified_streamer'}];
    if(resource==='rpc/byeollog_record_setup_email')return [];
    throw new Error(`unexpected call: ${resource}`);
  };
  const res=response();
  await handleSignup(request({
    email:'new@example.com',streamer_name:'신규'
  }),res,signupDeps({sbImpl}));
  assert.equal(res.statusCode,201);
  assert.equal(calls.some(call=>call.resource==='rpc/byeollog_resolve_referrable_streamer_v1'),false);
  const complete=calls.find(call=>call.resource==='rpc/byeollog_complete_oauth_signup_v2');
  assert.equal(complete.options.body.p_referrer_workspace_slug,null);
});

test('signup rejects a stale or forged referral selection without creating an application',async()=>{
  const calls=[];
  const sbImpl=async(resource,query,options={})=>{
    calls.push({resource,query,options});
    if(resource==='rpc/byeollog_resolve_referrable_streamer_v1')return [];
    throw new Error('application insert must not run');
  };
  const res=response();
  await handleSignup(request({
    email:'new@example.com',streamer_name:'신규',
    referrer_workspace_slug:'removed-streamer',note:''
  }),res,signupDeps({sbImpl}));
  assert.equal(res.statusCode,400);
  assert.match(res.body.message,/다시 선택/);
  assert.equal(calls.some(call=>call.options.method==='POST'&&call.resource==='byeollog_signup_applications'),false);
});

test('referral migration awards 500 credits once, keeps direct clients out, and clears deleted referrers',async()=>{
  const migration=await source('supabase/migrations/20260906105042_add_streamer_referral_credits.sql');
  assert.match(migration,/create table if not exists public\.byeollog_credit_ledger/);
  assert.match(migration,/credit_delta,entry_type,source_key[\s\S]*500,'signup_referral','signup_referral:' \|\| a\.id::text/);
  assert.match(migration,/constraint byeollog_credit_ledger_source_key_key unique\(source_key\)/);
  assert.match(migration,/on conflict\(source_key\) do nothing/);
  assert.match(migration,/create or replace function public\.byeollog_approve_signup_application/);
  assert.match(migration,/for update/);
  assert.match(migration,/alter table public\.byeollog_credit_ledger enable row level security/);
  assert.match(migration,/to anon,authenticated[\s\S]*using \(false\)[\s\S]*with check \(false\)/);
  assert.match(migration,/grant execute on function public\.byeollog_search_referrable_streamers_v1\(text,integer\)[\s\S]*to service_role/);
  assert.match(migration,/before delete on public\.byeollog_workspaces[\s\S]*byeollog_clear_referrer_snapshot_on_workspace_delete_v1/);
  assert.ok(BACKUP_TABLES.some(table=>table.name==='byeollog_credit_ledger'&&table.conflict==='source_key'));
  assert.match(migration,/'byeollog_credit_ledger',coalesce\(\(select jsonb_agg/);
  assert.match(migration,/\(19,'byeollog_credit_ledger','source_key',false\)/);
});

test('automatic signup migration is atomic, service-only, and binds the verified SOOP identity',async()=>{
  const migration=await source('supabase/migrations/20260907150000_oauth_verified_automatic_signup.sql');
  assert.match(migration,/create table if not exists public\.byeollog_soop_signup_oauth_pending/);
  assert.match(migration,/alter table public\.byeollog_soop_signup_oauth_pending enable row level security/);
  assert.match(migration,/for all to anon,authenticated[\s\S]*using\(false\) with check\(false\)/);
  assert.match(migration,/revoke all on function public\.byeollog_approve_signup_application\(uuid,uuid\)[\s\S]*from public,anon,authenticated,service_role/);
  assert.match(migration,/create or replace function public\.byeollog_complete_oauth_signup_v1/);
  assert.match(migration,/security definer[\s\S]*set search_path=''/);
  assert.match(migration,/where p\.token_hash=p_pending_token_hash[\s\S]*for update/);
  assert.match(migration,/insert into public\.byeollog_workspaces[\s\S]*pending\.provider_user_id/);
  assert.match(migration,/insert into public\.byeollog_soop_connections[\s\S]*pending\.access_token_ciphertext/);
  assert.match(migration,/delete from public\.byeollog_soop_signup_oauth_pending/);
  assert.match(migration,/revoke all on function public\.byeollog_complete_oauth_signup_v1[\s\S]*grant execute[\s\S]*to service_role/);
});

test('signup UI requires an actual search selection and explains the current credit scope',async()=>{
  const [html,client,loginApi,privacy,terms]=await Promise.all([
    source('signup.html'),source('assets/signup-page.js'),source('api/login.js'),source('privacy.html'),source('terms.html')
  ]);
  assert.match(html,/id="referrerSearch"/);
  assert.match(html,/<label for="referrerSearch">추천한 스트리머\s*<span class="signupOptional">선택<\/span><\/label>/);
  assert.match(html,/500크레딧/);
  assert.match(html,/SOOP 계정 연결하기/);
  assert.doesNotMatch(html,/id="soopId"|id="stationUrl"|관리자 승인 후/);
  assert.match(client,/operation=referrer-search/);
  assert.match(client,/\/api\/auth\/soop\/signup\/status/);
  assert.match(client,/referrer_workspace_slug:selectedReferrer\?\.key\|\|''/);
  assert.doesNotMatch(client,/soop_id:\$\('soopId'\)/);
  assert.match(client,/검색 결과에서 추천한 스트리머를 선택/);
  assert.match(loginApi,/operation==='referrer-search'/);
  assert.match(privacy,/선택한 추천 스트리머/);
  assert.match(terms,/추천인에게 500크레딧/);
  assert.match(terms,/현재 적립 기록으로만 제공/);
});

test('signup refuses unverified manual SOOP input before creating an Auth user',async()=>{
  let authCreated=false;
  const res=response();
  await handleSignup(request({email:'new@example.com',streamer_name:'신규',soop_id:'attacker_supplied'}),res,signupDeps({
    pendingResolver:async()=>null,createAuthUser:async()=>{authCreated=true;return {id:'never'}}
  }));
  assert.equal(res.statusCode,409);
  assert.equal(res.body.code,'soop_signup_connection_required');
  assert.equal(authCreated,false);
});

test('signup rejects missing, outdated and false consents before creating any Auth account',async()=>{
 for(const consents of [null,{}, {termsVersion:'2026-09-06',privacyVersion:'2026-09-09',termsAgreed:true,collectionAgreed:true,age14Confirmed:true}, {termsVersion:'2026-10-11',privacyVersion:'2026-10-11',termsAgreed:true,collectionAgreed:true,age14Confirmed:false}]){
  let created=false;const res=response();await handleSignup(request({email:'consent@example.com',streamer_name:'합성',consents}),res,signupDeps({createAuthUser:async()=>{created=true;throw Error('must not create')}}));assert.equal(res.statusCode,400);assert.equal(created,false);assert.equal(res.body.code,'signup_consent_required');
 }
});
