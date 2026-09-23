import {sb} from './supabase-rest.js';
import {processPendingCollectorRows} from './collector-processor.js';

const WAIT_REASONS=new Set(['unknown_rule','validation_review','no_roulette_result']);

export async function runUpboRetry({sbImpl=sb,processImpl=processPendingCollectorRows,signal=AbortSignal.timeout(45000)}={}){
  // At most one claimed item per tick. SQL durably reserves it, so overlap is safe.
  const rows=await sbImpl('rpc/byeollog_claim_upbo_retries_v1','',{method:'POST',body:{p_limit:1},signal});
  const row=Array.isArray(rows)?rows[0]:null;
  if(!row)return {claimed:0,failed:0};
  if(row.upbo_retry_protocol!==1||!row.workspace_id||!row.source_uid)throw new Error('Retry claim contract mismatch');
  const finish=(outcome,reason)=>sbImpl('rpc/byeollog_finish_upbo_retry_v1','',{method:'POST',body:{
    p_workspace_id:row.workspace_id,p_source_uid:row.source_uid,p_uploaded_at:row.uploaded_at,
    p_retry_attempt:row.upbo_retry_attempts,p_outcome:outcome,p_reason:reason
  },signal:AbortSignal.timeout(5000)});
  let result;
  try{
    result=await processImpl({sourceUids:[row.source_uid],workspaceId:row.workspace_id,includeFailed:true,skipStaleRecovery:true,signal});
  }catch(error){
    // Even a failure before processOne claims the row needs a durable reason.
    // The original lease still bounds retries if this final write also fails.
    await finish('failed','processor_exception').catch(()=>{});
    throw error;
  }
  const item=result?.results?.find(item=>item.uid===row.source_uid);
  if(item?.status==='pending'&&WAIT_REASONS.has(item.reason)){
    // Refund this reservation only, not previous technical failures. The RPC
    // compares row version + attempt and never overwrites newer work.
    const waiting=await finish('waiting',item.reason);
    return {claimed:1,failed:0,waiting:waiting===true?1:0};
  }
  if(item?.status==='failed'||(item?.status==='pending'&&item.reason==='invalid_special_roulette_decision')){
    await finish('failed',item.reason==='invalid_special_roulette_decision'?'invalid_special_roulette_decision':'processor_failed');
    return {claimed:1,failed:1};
  }
  // A crash/changed row keeps the bounded lease; success is already committed
  // by the processor. Do not infer a human wait from a generic pending status.
  return {claimed:1,failed:result?.ok===false?1:0};
}
