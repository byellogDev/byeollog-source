import {requireSession, requireCapabilityLive, safeEqual} from '../lib/auth.js';
import {createBackup,createDailyBackups,listBackups} from '../lib/backup.js';
import {workspaceForSession} from '../lib/workspace.js';
import {sb} from '../lib/supabase-rest.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

function isAuthorizedCron(req){
  const secret=process.env.CRON_SECRET||'';
  if(!secret) return false;
  const auth=req.headers.authorization||'';
  return safeEqual(auth,`Bearer ${secret}`);
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res,{
    additionalWriteRequest:request=>String(request?.method||'').toUpperCase()==='GET'&&String(request?.query?.cron||'')==='daily'
  }))return;

  try{
    // Vercel Cron: GET /api/backups?cron=daily
    if(req.method==='GET' && String(req.query?.cron||'')==='daily'){
      if(!isAuthorizedCron(req)){
        return res.status(401).json({message:'Unauthorized'});
      }
      const result=await createDailyBackups();
      const cleanup=await sb('rpc/byeollog_cleanup_operational_data','',{method:'POST',body:{}});
      return res.status(result.failed?500:200).json({ok:result.failed===0,...result,cleanup});
    }

    if(req.method==='GET'){
      // H-01/H-05: 목록은 editor 이상이며 현재 멤버십/역할을 매 요청 재검증한다.
      const session=await requireCapabilityLive(req,res,'backup:list');
      if(!session) return;
      const workspaceId=await workspaceForSession(session);
      if(!workspaceId) return res.status(403).json({message:'Workspace not resolved'});
      return res.status(200).json({items:await listBackups(workspaceId)});
    }
    if(req.method==='POST'){
      // H-01/H-05: 생성은 현재 owner만 허용한다. 만료 전 쿠키만으로
      // lease를 잡아 탈퇴를 방해하는 stale-session 경로를 허용하지 않는다.
      const session=await requireCapabilityLive(req,res,'backup:create');
      if(!session) return;
      const workspaceId=await workspaceForSession(session);
      if(!workspaceId) return res.status(403).json({message:'Workspace not resolved'});
      return res.status(201).json(await createBackup('manual',workspaceId));
    }

    // Keep the previous authentication boundary for unsupported methods.
    const session=requireSession(req,res);
    if(!session) return;
    res.setHeader('Allow','GET, POST');
    return res.status(405).json({message:'Method not allowed'});
  }catch(e){
    console.error('backup api failed',e);
    return res.status(500).json({message:'백업 처리 실패'});
  }
}
