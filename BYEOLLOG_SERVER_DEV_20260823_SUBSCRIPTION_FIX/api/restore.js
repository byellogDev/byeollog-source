import {requireCapabilityLive} from '../lib/auth.js';
import {restoreBackupMerge} from '../lib/backup.js';
import {workspaceForSession} from '../lib/workspace.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  const session=await requireCapabilityLive(req,res,'backup:restore');
  if(!session) return;
  if(req.method!=='POST'){
    res.setHeader('Allow','POST');
    return res.status(405).json({message:'Method not allowed'});
  }

  const path=String(req.body?.path||'');
  const confirm=String(req.body?.confirm||'');
  if(confirm!=='복구'){
    return res.status(400).json({message:'복구 확인 문자열이 올바르지 않습니다.'});
  }

  try{
    const workspaceId=await workspaceForSession(session);
    if(!workspaceId) return res.status(403).json({message:'Workspace not resolved'});
    return res.status(200).json(await restoreBackupMerge(path,workspaceId));
  }catch(e){
    console.error('restore failed',e);
    return res.status(500).json({message:'복구 실패'});
  }
}
