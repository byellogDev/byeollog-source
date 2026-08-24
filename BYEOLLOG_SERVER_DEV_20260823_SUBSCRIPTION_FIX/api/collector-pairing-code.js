import crypto from 'node:crypto';
import {requireCapabilityLive} from '../lib/auth.js';
import {sb} from '../lib/supabase-rest.js';
import {workspaceForSession,sha256,q} from '../lib/workspace.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

function makeCode(){const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let out='';for(let i=0;i<8;i++)out+=alphabet[crypto.randomInt(0,alphabet.length)];return out;}
function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  // H-01: 페어링 코드 발급은 owner만
  const session=await requireCapabilityLive(req,res,'device:manage');
  if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  const body=bodyOf(req),deviceName=String(body.device_name||'Collector').trim().slice(0,80)||'Collector';
  const code=makeCode(),expires=new Date(Date.now()+10*60*1000).toISOString();
  const rows=await sb('byeollog_collector_devices','',{method:'POST',body:{workspace_id:workspaceId,device_name:deviceName,pairing_code_hash:sha256(code),pairing_expires_at:expires,status:'pending'}});
  const device=Array.isArray(rows)?rows[0]:null;
  await sb('byeollog_audit_log','',{method:'POST',body:{workspace_id:workspaceId,actor_user_id:session.user_id||null,actor_kind:'user',action:'collector_pairing_code_issued',target_type:'collector_device',target_id:device?.id||null,metadata:{device_name:deviceName,expires_at:expires}}}).catch(()=>{});
  return res.status(200).json({ok:true,code,device_id:device?.id||null,expires_at:expires});
}
