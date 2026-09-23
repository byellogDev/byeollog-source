import {requireSession, requireCapabilityLive, safeEqual} from '../lib/auth.js';
import {createBackup,createDailyBackups,listBackups,dailyBackupTargets,createDailyWorkspaceBackup,backupRetentionInventory,retainBackupFile} from '../lib/backup-service.js';
import {workspaceForSession} from '../lib/workspace.js';
import {sb} from '../lib/supabase-rest.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

function isAuthorizedCron(req,secretName='CRON_SECRET'){
  const secret=process.env[secretName]||'';
  if(!secret) return false;
  const auth=req.headers.authorization||'';
  return safeEqual(auth,`Bearer ${secret}`);
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res,{
    additionalWriteRequest:request=>String(request?.method||'').toUpperCase()==='GET'&&['daily','cleanup'].includes(String(request?.query?.cron||''))
  }))return;

  try{
    if(['retention-list','retention-file'].includes(String(req.query?.cron||''))){
      if(!isAuthorizedCron(req,'BYEOLLOG_BACKUP_RUNNER_SECRET'))return res.status(401).json({message:'Unauthorized'});
      if(req.query.cron==='retention-list'&&req.method==='GET')return res.status(200).json({ok:true,items:await backupRetentionInventory()});
      if(req.query.cron==='retention-file'&&req.method==='POST'){
        const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
        if(!body||typeof body.path!=='string')return res.status(400).json({message:'Invalid archive path'});
        return res.status(200).json({ok:true,...await retainBackupFile(body.path)});
      }
      return res.status(405).json({message:'Method not allowed'});
    }
    if(req.query?.cron==='cleanup'&&req.method==='GET'){
      if(!isAuthorizedCron(req))return res.status(401).json({message:'Unauthorized'});
      const cleanup=await sb('rpc/byeollog_cleanup_operational_data','',{method:'POST',body:{},signal:AbortSignal.timeout(30000)});
      return res.status(200).json({ok:true,cleanup});
    }
    if(['targets','workspace'].includes(String(req.query?.cron||''))){
      if(!isAuthorizedCron(req,'BYEOLLOG_BACKUP_RUNNER_SECRET'))return res.status(401).json({message:'Unauthorized'});
      if(req.query.cron==='targets'&&req.method==='GET')return res.status(200).json({ok:true,workspaces:await dailyBackupTargets()});
      if(req.query.cron==='workspace'&&req.method==='POST'){
        const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
        const publicKey=process.env.BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY||'';
        if(!publicKey)return res.status(503).json({message:'Backup recipient unavailable'});
        if(!body||typeof body.workspaceId!=='string'||(body.publicKey!==undefined&&body.publicKey!==publicKey))return res.status(400).json({message:'Invalid backup request'});
        const targets=await dailyBackupTargets();
        if(!targets.includes(body.workspaceId))return res.status(404).json({message:'Workspace unavailable'});
        return res.status(200).json({ok:true,...await createDailyWorkspaceBackup(body.workspaceId,publicKey)});
      }
      return res.status(405).json({message:'Method not allowed'});
    }
    // Vercel Cron: GET /api/backups?cron=daily
    if(req.method==='GET' && String(req.query?.cron||'')==='daily'){
      if(!isAuthorizedCron(req)){
        return res.status(401).json({message:'Unauthorized'});
      }
      const started=Date.now();
      console.info('[backup] daily started');
      const result=await createDailyBackups();
      const cleanup=await sb('rpc/byeollog_cleanup_operational_data','',{method:'POST',body:{}});
      console.info('[backup] daily completed',{
        created:result.created,failed:result.failed,durationMs:Date.now()-started
      });
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
    const rawCode=String(e?.code??e?.status??'backup_failed');
    const code=/^[A-Za-z0-9_-]{1,64}$/.test(rawCode)?rawCode:'backup_failed';
    console.error('[backup] request failed',{
      code,
      method:String(req.method||'').slice(0,8),
      cron:String(req.query?.cron||'')==='daily'
    });
    return res.status(500).json({message:'백업 처리 실패'});
  }
}
