import {createClient} from '@supabase/supabase-js';
import {gzip,gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {pruneWallpaperArchive} from './wallpaper-retention.js';
import {sealBackup} from './backup-seal.js';
import {sb as legacyRest} from './supabase-rest.js';
import {backupWorkerClient,backupWorkerRest} from './backup-worker-client.js';
const rest=(...args)=>process.env.BYEOLLOG_RUNTIME==='backup'?backupWorkerRest(...args):legacyRest(...args);
const unzip=promisify(gunzip),zip=promisify(gzip),bucket='bangsel-backups';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const storage=async()=>process.env.BYEOLLOG_RUNTIME==='backup'?(await backupWorkerClient(AbortSignal.timeout(25000))).storage.from(bucket):createClient(process.env.SUPABASE_URL,process.env.SUPABASE_SECRET_KEY,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(url,init={})=>fetch(url,{...init,signal:AbortSignal.timeout(25000)})}}).storage.from(bucket);
export async function backupRetentionInventory(){
  return await rest('rpc/byeollog_backup_retention_inventory_v1','',{method:'POST',body:{},signal:AbortSignal.timeout(15000)});
}
export async function retainBackupFile(path){
  if(typeof path!=='string'||path.length>500||path.includes('..')||path.startsWith('/')||!path.endsWith('.json.gz'))throw Error('Invalid retention archive path');
  const inventory=await backupRetentionInventory();
  if(!inventory.some(item=>item.name===path))throw Error('Archive no longer available');
  const store=await storage();
  const read=async()=>{const {data,error}=await store.download(path);if(error)throw Error('Archive download failed');if(data.size>32*1024*1024)throw Error('Archive too large');return Buffer.from(await data.arrayBuffer());};
  const original=await read();
  const input=JSON.parse((await unzip(original,{maxOutputLength:64*1024*1024})).toString('utf8'));
  const scoped=path.match(/^workspaces\/([a-f0-9-]{36})\//);
  if(scoped&&input.workspace_id&&input.workspace_id!==scoped[1])throw Error('Archive ownership mismatch');
  const result=pruneWallpaperArchive(input);
  let bytes=original;
  if(result.changed){
    bytes=await zip(Buffer.from(JSON.stringify(result.backup)),{level:9});
    // Refuse to overwrite a concurrently changed object. Existing objects are
    // immutable outside this serialized operator job.
    if(hash(await read())!==hash(original))throw Error('Archive changed during retention');
    const {error}=await store.update(path,bytes,{contentType:'application/gzip',cacheControl:'0',upsert:false});
    if(error)throw Error('Archive retention upload failed');
    if(hash(await read())!==hash(bytes))throw Error('Archive retention persistence mismatch');
  }
  const publicKey=process.env.BYEOLLOG_BACKUP_RECIPIENT_PUBLIC_KEY;
  return {path,workspace_id:input.workspace_id??null,created_at:input.created_at??null,backup_version:input.backup_version,changed:result.changed,removedTiles:result.removedTiles,removedBroadcasts:result.removedBroadcasts,cutoff:result.cutoff,archive:path.includes('/daily/')&&publicKey?sealBackup(bytes,publicKey):null};
}
