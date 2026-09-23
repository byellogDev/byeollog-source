import {requireCapabilityLive} from '../lib/auth.js';
import {workspaceForSession} from '../lib/workspace.js';
import {processPendingCollectorRows} from '../lib/collector-processor.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  // H-01: Collector 처리는 editor 이상
  const session=await requireCapabilityLive(req,res,'collector:process');
  if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  try{
    const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
    const sourceUids=Array.isArray(body.source_uids)?body.source_uids.map(String).filter(Boolean).slice(0,500):undefined;
    // short/over 우회 승인은 클릭 당시의 source_uid + uploaded_at 쌍에만 묶습니다.
    // 같은 UID가 처리 직전에 새 수집 내용으로 갱신되면 일치하지 않아 자동으로 다시 검토 대기가 됩니다.
    const validationReviewApprovals=new Map();
    if(Array.isArray(body.validation_review_approvals)){
      for(const item of body.validation_review_approvals.slice(0,500)){
        const uid=String(item?.source_uid||'').trim();
        const uploadedAt=String(item?.uploaded_at||'').trim();
        if(uid&&uploadedAt&&sourceUids?.includes(uid))validationReviewApprovals.set(uid,uploadedAt);
      }
    }
    const result=await processPendingCollectorRows({
      sourceUids,
      includeFailed:body.include_failed!==false,
      validationReviewApprovals,
      limit:Number(body.limit)||500,
      workspaceId
    });
    return res.status(result.ok?200:207).json(result);
  }catch(e){
    return res.status(500).json({message:'Collector server processing failed'});
  }
}
