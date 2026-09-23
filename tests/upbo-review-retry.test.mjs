import test from 'node:test';
import assert from 'node:assert/strict';
import {runUpboRetry} from '../apps/collector-runtime/lib/upbo-retry.js';
import {assessCollectorRow} from '../apps/collector-runtime/lib/collector-processor.js';

const row={workspace_id:'00000000-0000-4000-8000-000000000001',source_uid:'retry-test',
  uploaded_at:'2026-09-23T00:00:00Z',upbo_retry_protocol:1,upbo_retry_attempts:1};
function harness(item,{claimed=row,finishResult=true,processError=null}={}){
  const calls=[];
  return {calls,options:{
    sbImpl:async(table,path,opt)=>{calls.push({table,...opt});return table.endsWith('claim_upbo_retries_v1')?(claimed?[claimed]:[]):finishResult;},
    processImpl:async opt=>{assert.equal(opt.workspaceId,row.workspace_id);assert.deepEqual(opt.sourceUids,[row.source_uid]);
      if(processError)throw processError;return {ok:item?.status!=='failed',results:[{uid:row.source_uid,...item}]};}
  }};
}
for(const reason of ['unknown_rule','validation_review','no_roulette_result']){
  test(`explicit ${reason} releases the retry reservation as a wait`,async()=>{
    const h=harness({status:'pending',reason});
    assert.deepEqual(await runUpboRetry(h.options),{claimed:1,failed:0,waiting:1});
    assert.deepEqual(h.calls[1].body,{p_workspace_id:row.workspace_id,p_source_uid:row.source_uid,
      p_uploaded_at:row.uploaded_at,p_retry_attempt:1,p_outcome:'waiting',p_reason:reason});
  });
}
test('unclassified SOOP result follows the real assessment into a wait',async()=>{
  const input={raw_payload:{source_provider:'soop_chat_sdk',type:'SENDBALLOON',roulette_enabled:true},
    event_name:'test roulette',validation:'matched',roulette_results:[{result:'new result'}],fixed_rewards:[]};
  const assessment=assessCollectorRow(input,new Map(),new Map());
  assert.equal(assessment.reason,'unknown_rule');
  const h=harness({status:'pending',reason:assessment.reason});
  assert.equal((await runUpboRetry(h.options)).waiting,1);
  const classified=assessCollectorRow(input,new Map([['new result',{action:'include',output_types:['test task']}]]),new Map());
  assert.equal(classified.processable,true);
});
test('a changed or concurrently processed row is not reported as settled',async()=>{
  const h=harness({status:'pending',reason:'unknown_rule'},{finishResult:false});
  assert.equal((await runUpboRetry(h.options)).waiting,0);
});
test('previous technical attempts are not reset by the caller',async()=>{
  const h=harness({status:'pending',reason:'unknown_rule'},{claimed:{...row,upbo_retry_attempts:4}});
  await runUpboRetry(h.options);assert.equal(h.calls[1].body.p_retry_attempt,4);
  assert.equal(Object.hasOwn(h.calls[1].body,'upbo_retry_attempts'),false);
});
test('invalid stored roulette decision is a technical failure',async()=>{
  const h=harness({status:'pending',reason:'invalid_special_roulette_decision'});
  assert.equal((await runUpboRetry(h.options)).failed,1);assert.equal(h.calls[1].body.p_outcome,'failed');
});
test('pre-claim processor failure is persisted without clearing its budget',async()=>{
  const h=harness({status:'failed',error:'request failed'});
  assert.equal((await runUpboRetry(h.options)).failed,1);assert.equal(h.calls[1].body.p_reason,'processor_failed');
});
test('processor exception is recorded with an independent settlement timeout',async()=>{
  const error=new Error('private diagnostic');const h=harness(null,{processError:error});
  const signal=AbortSignal.abort();h.options.signal=signal;
  await assert.rejects(runUpboRetry(h.options),error);
  assert.equal(h.calls[1].body.p_reason,'processor_exception');assert.equal(h.calls[1].signal.aborted,false);
  assert.equal(JSON.stringify(h.calls[1].body).includes(error.message),false);
});
test('settlement failure does not pretend the wait was saved',async()=>{
  const h=harness({status:'pending',reason:'unknown_rule'});
  const original=h.options.sbImpl;h.options.sbImpl=async(...args)=>{
    if(args[0].endsWith('finish_upbo_retry_v1'))throw new Error('DB unavailable');return original(...args);
  };
  await assert.rejects(runUpboRetry(h.options),/DB unavailable/);
});
for(const item of [{status:'processed'},{status:'ignored'},{status:'skipped'},
  {status:'pending',reason:'row_changed_during_processing'},{status:'pending',reason:'unrecognized'}]){
  test(`does not rewrite ${item.status}/${item.reason||'terminal'} outcome`,async()=>{
    const h=harness(item);await runUpboRetry(h.options);assert.equal(h.calls.length,1);
  });
}
test('empty retry queue performs no settlement',async()=>{
  const h=harness(null,{claimed:null});assert.deepEqual(await runUpboRetry(h.options),{claimed:0,failed:0});
  assert.equal(h.calls.length,1);
});
