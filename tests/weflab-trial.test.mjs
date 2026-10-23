import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TrialOutbox,executeTrialJob} from '../tools/weflab-lab/trial-server.mjs';
import {digest} from '../tools/weflab-lab/browserless-core.mjs';
const body={type:'roulette_result',platform:'afreeca',id:'fixture',uid:'donation-fixture',count:'1'};
const plan={key:'fixture-key',requestHash:digest(body),body,count:1};
test('outbox keeps uncertain delivery and retries the stored response only',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weflab-outbox-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const outbox=new TrialOutbox(dir);const event={action:'complete',key:'k',response:{raw:'original'}};
 outbox.put(event);outbox.put(event);assert.equal(fs.readdirSync(dir).length,1);
 await assert.rejects(()=>outbox.flush(async()=>{throw Error('network');}));assert.equal(fs.readdirSync(dir).length,1);
 await outbox.flush(async q=>{assert.deepEqual(q,event);return {status:'recorded'};});assert.equal(fs.readdirSync(dir).length,0);
});
test('disabled receipt delivery is never silently dropped',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'weflab-disabled-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const box=new TrialOutbox(dir);box.put({action:'ingest',message:{}});
 assert.equal((await box.flush(async()=>({status:'disabled'}))).disabled,true);assert.equal(fs.readdirSync(dir).length,1);
});
test('provider request follows reservation, preserves raw, and returns completion separately',async()=>{
 const records=[],calls=[];
 const result=await executeTrialJob({key:plan.key,token:'lease',rpc:async q=>{calls.push(q.action);return {status:'reserved',plan,attempt:'attempt'};},record:r=>records.push(r),fetchResult:async()=>{
   assert.equal(records[0].kind,'request_started');calls.push('provider');return new Response('{"result":"success","api":"sql","data":"꽝"}');
 }});
 assert.deepEqual(calls,['reserve','provider']);assert.equal(result.action,'complete');assert.equal(result.response.assessment.status,'stored_result_observed');assert.match(records[1].response.raw,/꽝/);
});
test('previously reserved job never calls provider',async()=>{
 const result=await executeTrialJob({key:'k',token:'t',rpc:async()=>({status:'already_reserved'}),record:()=>assert.fail(),fetchResult:()=>assert.fail()});assert.equal(result.status,'already_reserved');
});
test('timeout and save have evidence and need review',async()=>{
 for(const mode of ['timeout','save']){
  const records=[];const result=await executeTrialJob({key:plan.key,token:'t',rpc:async()=>({status:'reserved',plan,attempt:'a'}),record:r=>records.push(r),fetchResult:async()=>{if(mode==='timeout')throw Error('network');return new Response('{"result":"success","api":"save","data":"꽝"}');}});
  assert.equal(result.response.assessment.status,'needs_review');assert.equal(records.length,2);
 }
});
test('private DB contract excludes operating inserts and locks account before claims',()=>{
 const sql=fs.readFileSync(new URL('../supabase/migrations/20261007225033_weflab_shadow_trial.sql',import.meta.url),'utf8');
 assert.match(sql,/for update/);assert.match(sql,/g3a_assert_active_auth_session_v1/);assert.match(sql,/server_secret_hash/);
 assert.doesNotMatch(sql,/insert into public\./i);assert.match(sql,/possible_result_generation/);assert.match(sql,/enable row level security/);
});
