// Customer/cron authorization remains in api/backups.js. This bridge only calls
// the isolated backup service; it never falls back to administrator DB access.
async function request(operation,args={}){
 const secret=process.env.BYEOLLOG_BACKUP_WORKER_SECRET||'',raw=process.env.BYEOLLOG_BACKUP_WORKER_URL||'';
 let url;try{url=new URL(raw)}catch{throw Error('Backup worker is not configured')}
 if(url.protocol!=='https:'||!/^byeollog-backup-worker(?:-[a-z0-9-]+)?\.vercel\.app$/.test(url.hostname)||url.port||url.pathname!=='/api/backup'||url.search||url.hash||url.username||url.password||!/^[a-f0-9]{64}$/.test(secret))throw Error('Backup worker configuration invalid');
 const res=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+secret,'Content-Type':'application/json'},body:JSON.stringify({operation,...args}),redirect:'error',cache:'no-store',signal:AbortSignal.timeout(280000)});
 if(!res.ok)throw Error('Backup worker request failed');
 const length=Number(res.headers.get('content-length')||0);if(length>48*1024*1024)throw Error('Backup worker response exceeds limit');
 const reader=res.body.getReader(),parts=[];let size=0;
 for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>48*1024*1024){await reader.cancel();throw Error('Backup worker response exceeds limit')}parts.push(Buffer.from(value))}
 const body=JSON.parse(Buffer.concat(parts).toString());if(body?.ok!==true||!Object.hasOwn(body,'result'))throw Error('Backup worker response invalid');return body.result;
}
export const createBackup=(reason,workspaceId)=>{if(reason!=='manual')throw Error('Unsupported backup reason');return request('manual',{workspaceId})};
export const createDailyBackups=()=>request('daily');
export const listBackups=workspaceId=>request('list',{workspaceId});
export const dailyBackupTargets=()=>request('targets');
export const createDailyWorkspaceBackup=workspaceId=>request('workspace',{workspaceId});
export const backupRetentionInventory=()=>request('retention-list');
export const retainBackupFile=path=>request('retention-file',{path});
