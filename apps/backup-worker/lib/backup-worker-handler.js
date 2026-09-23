import {createHash,timingSafeEqual} from 'node:crypto';
import {createBackup,createDailyBackups,listBackups,dailyBackupTargets,createDailyWorkspaceBackup} from './backup.js';
import {backupRetentionInventory,retainBackupFile} from './backup-retention.js';
import {backupWorkerClient,backupWorkerConfiguration} from './backup-worker-client.js';
import {backupFailureCode} from './backup-failure.js';
const same=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store, private');
 const secret=process.env.BYEOLLOG_BACKUP_WORKER_SECRET||'';
 if(!/^[a-f0-9]{64}$/.test(secret))return res.status(503).json({message:'Backup worker unavailable'});
 if(!same(String(req.headers?.authorization||''),'Bearer '+secret))return res.status(401).json({message:'Unauthorized'});
 if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
 let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body}catch{return res.status(400).json({message:'Invalid request'})}
 if(!body||Array.isArray(body)||typeof body!=='object'||JSON.stringify(body).length>4096||Object.keys(body).some(k=>!['operation','workspaceId','path'].includes(k)))return res.status(400).json({message:'Invalid request'});
 const operation=body.operation;
 if(!['probe','daily','targets','workspace','list','manual','retention-list','retention-file'].includes(operation))return res.status(400).json({message:'Invalid operation'});
 if(['workspace','list','manual'].includes(operation)&&!UUID.test(body.workspaceId||''))return res.status(400).json({message:'Invalid workspace'});
 try{
  backupWorkerConfiguration();
  let result;
  switch(operation){
   case 'probe':{
    const client=await backupWorkerClient(AbortSignal.timeout(15000));
    const {data,error}=await client.rpc('byeollog_backup_worker_v1',{p_operation:'probe',p_args:{}});
    if(error||data!==true)throw Error('Backup database probe failed');result={databaseReady:true};break;
   }
   case 'daily':result=await createDailyBackups();break;
   case 'targets':result=await dailyBackupTargets();break;
   case 'workspace':{
    const publicKey=process.env.BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY||'';
    if(!publicKey)throw Error('Backup recipient unavailable');
    result=await createDailyWorkspaceBackup(body.workspaceId,publicKey);break;
   }
   case 'manual':result=await createBackup('manual',body.workspaceId);break;
   case 'list':result=await listBackups(body.workspaceId);break;
   case 'retention-list':result=await backupRetentionInventory();break;
   case 'retention-file':result=await retainBackupFile(body.path);break;
  }
  return res.status(200).json({ok:true,result});
 }catch(error){
  console.error('[backup-worker] operation failed',{operation,code:backupFailureCode(error)});
  return res.status(502).json({message:'Backup worker operation failed'});
 }
}
