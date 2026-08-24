import {requireSession, requireCapabilityLive} from '../lib/auth.js';
import {sb} from '../lib/supabase-rest.js';
import {workspaceForSession,q} from '../lib/workspace.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  if(req.method==='GET'){
    // H-01/H-05: 목록은 현재 editor 이상만 허용한다.
    const session=await requireCapabilityLive(req,res,'device:list');if(!session)return;
    const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
    const rows=await sb('byeollog_collector_devices',`?select=id,device_name,status,collector_version,last_seen_at,last_upload_at,created_at,revoked_at&workspace_id=eq.${q(workspaceId)}&order=created_at.desc`);
    return res.status(200).json({ok:true,devices:Array.isArray(rows)?rows:[]});
  }

  if(req.method==='POST'){
    // H-01/H-05: 폐기(revoke)는 현재 owner만 허용한다.
    const session=await requireCapabilityLive(req,res,'device:manage');if(!session)return;
    const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
    const body=bodyOf(req),id=String(body.device_id||'');
    if(!id)return res.status(400).json({message:'device_id required'});
    const rows=await sb('byeollog_collector_devices',`?id=eq.${q(id)}&workspace_id=eq.${q(workspaceId)}`,{method:'PATCH',body:{status:'revoked',token_hash:null,revoked_at:new Date().toISOString()}});
    return res.status(200).json({ok:true,updated:Array.isArray(rows)?rows.length:0});
  }
  const session=requireSession(req,res);if(!session)return;
  return res.status(405).json({message:'Method not allowed'});
}
