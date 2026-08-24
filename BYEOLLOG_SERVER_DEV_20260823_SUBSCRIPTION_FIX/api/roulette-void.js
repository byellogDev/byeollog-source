import {requireCapabilityLive} from '../lib/auth.js';
import {workspaceForSession} from '../lib/workspace.js';
import {sb} from '../lib/supabase-rest.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  const session=await requireCapabilityLive(req,res,'roulette:void');
  if(!session)return;
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  const source_uid=String(req.body?.source_uid||'').trim(),reason=String(req.body?.reason||'').trim().slice(0,500);
  if(!source_uid)return res.status(400).json({message:'source_uid is required'});
  try{
    const out=await sb('rpc/bangsel_void_roulette_ws','',{method:'POST',body:{p_workspace_id:workspaceId,p_source_uid:source_uid,p_reason:reason||null}});
    const data=Array.isArray(out)?out[0]:out;
    return res.status(200).json(data||{ok:true});
  }catch(e){
    return res.status(e.status||500).json({message:'룰렛 무효 처리 실패'});
  }
}
