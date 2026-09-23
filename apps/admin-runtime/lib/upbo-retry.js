import {sb} from './supabase-rest.js';
import {processPendingCollectorRows} from './collector-processor.js';

export async function runUpboRetry({sbImpl=sb,processImpl=processPendingCollectorRows,signal=AbortSignal.timeout(45000)}={}){
  // At most one claimed item per tick. SQL durably reserves it, so overlap is safe.
  const rows=await sbImpl('rpc/byeollog_claim_upbo_retries_v1','',{method:'POST',body:{p_limit:1},signal});
  const row=Array.isArray(rows)?rows[0]:null;
  if(!row)return {claimed:0,failed:0};
  if(row.upbo_retry_protocol!==1||!row.workspace_id||!row.source_uid)throw new Error('Retry claim contract mismatch');
  const result=await processImpl({sourceUids:[row.source_uid],workspaceId:row.workspace_id,includeFailed:true,skipStaleRecovery:true,signal});
  // SQL leaves a durable lease/deadline if processing crashes or times out.
  return {claimed:1,failed:result?.ok===false?1:0};
}
