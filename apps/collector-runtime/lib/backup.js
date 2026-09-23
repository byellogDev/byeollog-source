import {createClient} from '@supabase/supabase-js';
import crypto from 'node:crypto';
import {gzip, gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {sb as legacyServiceRest} from './supabase-rest.js';
import {backupWorkerClient,backupWorkerRest} from './backup-worker-client.js';
const serviceRest=(...args)=>process.env.BYEOLLOG_RUNTIME==='backup'?backupWorkerRest(...args):legacyServiceRest(...args);
import {normalizeStorageManifest} from './storage-manifest.js';
import {sealBackup} from './backup-seal.js';
import {pruneWallpaperArchive} from './wallpaper-retention.js';

export const BACKUP_FORMAT_VERSION = 10;
export const BACKUP_BUCKET = 'bangsel-backups';

export const BACKUP_TABLES = [
  {name:'byeollog_reverse_fan_days', conflict:'workspace_id,id', order:['id']},
  {name:'byeollog_soop_core_donations', conflict:'id', order:['id']},
  {name:'bangsel_fans', conflict:'workspace_id,soop_id', order:['soop_id']},
  {name:'bangsel_fan_stations', conflict:'workspace_id,fan', order:['fan']},
  {name:'bangsel_roulette_rules', conflict:'workspace_id,result_text', order:['result_text']},
  {name:'bangsel_tasks', conflict:'id', order:['id']},
  {name:'bangsel_donations', conflict:'workspace_id,source_event_key', order:['source_event_key']},
  {name:'bangsel_task_import_items', conflict:'workspace_id,source_event_key', order:['source_event_key']},
  {name:'bangsel_collector_staging', conflict:'workspace_id,source_scope,source_uid', order:['source_scope','source_uid']},
  {name:'bangsel_roulette_invalidations', conflict:'workspace_id,source_uid', order:['source_uid']},
  {name:'byeollog_workspace_settings', conflict:'workspace_id', order:['workspace_id']},
  {name:'byeollog_signature_balloons', conflict:'workspace_id,balloon_count', order:['balloon_count']},
  {name:'byeollog_default_donation_images', conflict:'workspace_id,id', order:['id']},
  {name:'byeollog_fixed_upbo_rules', conflict:'workspace_id,balloons,event_name,upbo_type', order:['balloons','event_name','upbo_type']},
  {name:'byeollog_roulette_classification_rules', conflict:'workspace_id,roulette_name,result_text', order:['roulette_name','result_text']},
  {name:'byeollog_roulette_amount_mappings', conflict:'workspace_id,balloons', order:['balloons']},
  {name:'byeollog_special_roulette_rules', conflict:'workspace_id,result_text', order:['result_text']},
  {name:'byeollog_wallpaper_sessions', conflict:'id', order:['id']},
  {name:'byeollog_wallpaper_tiles', conflict:'id', order:['id']},
  {name:'byeollog_wallpaper_user_settings', conflict:'workspace_id,user_id', order:['user_id']},
  {name:'byeollog_wallpaper_overlay_states', conflict:'workspace_id', order:['workspace_id']},
  {name:'byeollog_credit_ledger', conflict:'source_key', order:['source_key']}
];

const RETENTION = {daily:30, manual:10, safety:10};
const BACKUP_LEASE_SECONDS = 1800;
const BACKUP_OPERATION_TIMEOUT_MS = 230*1000;
const LEASE_RPC_TIMEOUT_MS = 10*1000;
const STORAGE_REMOVE_CHUNK = 100;
const BACKUP_PAGE_SIZE = 500;
const BACKUP_MAX_ROWS_PER_TABLE = 100000;
const BACKUP_MAX_WORKSPACES = 10000;
const BACKUP_MAX_COMPRESSED_BYTES = 32*1024*1024;
const BACKUP_MAX_RAW_BYTES = 64*1024*1024;
const compressBackup = promisify(gzip);
const decompressBackup = promisify(gunzip);

function env(name){
  const v=process.env[name]||'';
  if(!v) throw new Error(`${name} is not configured`);
  return v;
}

function client(operationSignal){
  if(process.env.BYEOLLOG_RUNTIME==='backup')return backupWorkerClient(operationSignal);
  return createClient(env('SUPABASE_URL'), env('SUPABASE_SECRET_KEY'), {
    auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
    ...(operationSignal?{
      global:{
        fetch:(input,init={})=>fetch(input,{
          ...init,
          signal:init.signal
            ? AbortSignal.any([init.signal,operationSignal])
            : operationSignal
        })
      }
    }:{})
  });
}

function backupKind(reason){
  if(reason==='daily') return 'daily';
  if(reason==='pre-restore') return 'safety';
  return 'manual';
}

function assertBackupReason(reason){
  const value=String(reason||'').trim();
  if(!['daily','manual','pre-restore'].includes(value)){
    throw new Error('유효한 백업 사유가 필요합니다.');
  }
  return value;
}

function assertWorkspaceId(workspaceId){
  const value=String(workspaceId||'').trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)){
    throw new Error('유효한 워크스페이스가 필요합니다.');
  }
  return value;
}

function safeBackupErrorCode(error){
  const candidate=String(error?.code??error?.status??'backup_failed');
  return /^[A-Za-z0-9_-]{1,64}$/.test(candidate)?candidate:'backup_failed';
}

function workspaceRoot(workspaceId){
  return `workspaces/${assertWorkspaceId(workspaceId)}`;
}

function folderFor(workspaceId,reason){
  return `${workspaceRoot(workspaceId)}/${backupKind(reason)}`;
}

function safeIso(iso){
  return iso.replace(/[:.]/g,'-');
}

async function ensureBucket(sb){
  const {data,error}=await sb.storage.listBuckets();
  if(error) throw error;
  if((data||[]).some(b=>b.id===BACKUP_BUCKET || b.name===BACKUP_BUCKET)) return;

  const {error:createError}=await sb.storage.createBucket(BACKUP_BUCKET,{
    public:false,
    allowedMimeTypes:['application/gzip','application/json','application/octet-stream']
  });
  if(createError && !String(createError.message||'').toLowerCase().includes('already')){
    throw createError;
  }
}

async function readConsistentSnapshot(workspaceId,operationSignal){
  const tables=await serviceRest('rpc/byeollog_export_backup_v10','',{
    method:'POST',
    body:{p_workspace_id:workspaceId},
    signal:AbortSignal.any([operationSignal,AbortSignal.timeout(30000)])
  });
  if(!tables || typeof tables!=='object' || Array.isArray(tables)){
    throw new Error('일관된 백업 스냅샷을 확인할 수 없습니다.');
  }
  for(const cfg of BACKUP_TABLES){
    if(!Object.hasOwn(tables,cfg.name)){
      throw new Error(`${cfg.name} 백업 스냅샷이 누락되었습니다.`);
    }
  }
  validateWorkspaceRows({tables},workspaceId);
  return pruneWallpaperArchive({format:'bangsel-db-backup',tables}).backup.tables;
}

async function readActiveWorkspacesPaged(sb){
  const workspaces=[];
  const seenIds=new Set();
  let expectedCount=null;
  while(true){
    const start=workspaces.length;
    const {data,error,count}=await sb.from('byeollog_workspaces')
      .select('id,slug',{count:'exact'})
      .eq('status','active')
      .order('id',{ascending:true})
      .range(start,start+BACKUP_PAGE_SIZE-1);
    if(error) throw error;
    if(!Number.isSafeInteger(count) || count<0 || count>BACKUP_MAX_WORKSPACES){
      throw new Error('일일 백업 대상 워크스페이스 수를 확인할 수 없습니다.');
    }
    if(expectedCount===null) expectedCount=count;
    if(count!==expectedCount){
      throw new Error('일일 백업 대상 워크스페이스가 조회 중 변경되었습니다.');
    }
    const page=Array.isArray(data)?data:[];
    for(const workspace of page){
      const id=String(workspace?.id||'');
      if(!id || seenIds.has(id)){
        throw new Error('일일 백업 대상 워크스페이스 ID가 누락되었거나 중복되었습니다.');
      }
      seenIds.add(id);
      workspaces.push(workspace);
    }
    if(workspaces.length>expectedCount){
      throw new Error('일일 백업 대상 워크스페이스 수가 예상값을 초과했습니다.');
    }
    if(workspaces.length===expectedCount) break;
    if(page.length!==BACKUP_PAGE_SIZE){
      throw new Error('일일 백업 대상 워크스페이스 조회가 중간에서 잘렸습니다.');
    }
  }
  return workspaces;
}

function buildPayload(tables,reason,workspaceId){
  const createdAt=new Date().toISOString();
  const tableMeta={};
  for(const [name,rows] of Object.entries(tables)){
    const cols=new Set();
    for(const row of rows) Object.keys(row||{}).forEach(k=>cols.add(k));
    tableMeta[name]={row_count:rows.length,observed_columns:[...cols].sort()};
  }
  return {
    format:'bangsel-db-backup',
    backup_version:BACKUP_FORMAT_VERSION,
    created_at:createdAt,
    reason,
    workspace_id:workspaceId,
    restore_strategy:'merge-upsert',
    note:'Consistent DB metadata snapshot. Referenced private Storage binaries and browser-local media files are not included.',
    table_meta:tableMeta,
    tables
  };
}

async function pruneFolder(sb,folder,kind){
  const keep=RETENTION[kind]??10;
  const {data,error}=await sb.storage.from(BACKUP_BUCKET).list(folder,{
    limit:100,
    sortBy:{column:'created_at',order:'desc'}
  });
  if(error) throw error;
  const extras=(data||[]).filter(x=>x.name && !x.name.endsWith('/')).slice(keep);
  if(!extras.length) return;
  const {error:removeError}=await sb.storage.from(BACKUP_BUCKET).remove(
    extras.map(x=>`${folder}/${x.name}`)
  );
  if(removeError) throw removeError;
}

async function createBackupWhileLeased(reason,workspaceId,operationSignal){
  workspaceId=assertWorkspaceId(workspaceId);
  const sb=await client(operationSignal);
  await ensureBucket(sb);

  const tables=await readConsistentSnapshot(workspaceId,operationSignal);
  const payload=buildPayload(tables,reason,workspaceId);
  const raw=Buffer.from(JSON.stringify(payload),'utf8');
  if(raw.length>BACKUP_MAX_RAW_BYTES) throw new Error('백업 데이터가 복구 안전 크기를 초과했습니다.');
  const gz=await compressBackup(raw,{level:9});
  if(gz.length>BACKUP_MAX_COMPRESSED_BYTES) throw new Error('백업 압축 파일이 복구 안전 크기를 초과했습니다.');
  operationSignal?.throwIfAborted();

  const kind=backupKind(reason);
  const folder=folderFor(workspaceId,reason);
  const filename=`${safeIso(payload.created_at)}__${reason}.json.gz`;
  const path=`${folder}/${filename}`;

  const {error}=await sb.storage.from(BACKUP_BUCKET).upload(path,gz,{
    contentType:'application/gzip',
    upsert:false,
    cacheControl:'3600'
  });
  if(error) throw error;

  await pruneFolder(sb,folder,kind);

  return {
    path,
    created_at:payload.created_at,
    reason,
    workspace_id:workspaceId,
    compressed_bytes:gz.length,
    uncompressed_bytes:raw.length,
    counts:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,rows.length]))
  };
}

async function withWorkspaceBackupLease(reason,workspaceId,operation){
  workspaceId=assertWorkspaceId(workspaceId);
  reason=assertBackupReason(reason);
  const leaseId=crypto.randomUUID();
  const leaseRows=await serviceRest('rpc/begin_workspace_backup_v1','',{
    method:'POST',
    body:{
      p_workspace_id:workspaceId,
      p_lease_id:leaseId,
      // SQL lease vocabulary differs from the persisted v7 backup vocabulary.
      // Keep existing folders/payloads intact; translate only at the RPC boundary.
      p_reason:reason==='daily'?'automatic':reason==='pre-restore'?'pre_restore':'manual',
      p_lease_seconds:BACKUP_LEASE_SECONDS
    },
    signal:AbortSignal.timeout(LEASE_RPC_TIMEOUT_MS)
  });
  if(!Array.isArray(leaseRows) || leaseRows.length!==1
    || String(leaseRows[0]?.lease_id||'').toLowerCase()!==leaseId.toLowerCase()
    || !Number.isFinite(Date.parse(String(leaseRows[0]?.expires_at||'')))){
    throw new Error('백업 lease 생성을 확인할 수 없습니다.');
  }

  const operationController=new AbortController();
  let leaseUncertain=false;
  const deadline=setTimeout(()=>{
    leaseUncertain=true;
    operationController.abort(new Error('백업/복구 안전 시간을 초과했습니다.'));
  },BACKUP_OPERATION_TIMEOUT_MS);
  deadline.unref?.();

  let result;
  let operationError=null;
  try{
    result=await operation(operationController.signal,leaseId);
  }catch(e){
    operationError=e;
    // Storage may have committed an upload even when its HTTP response was
    // lost. Keep the lease until natural expiry on every failed operation so
    // withdrawal cannot race a late object into existence.
    leaseUncertain=true;
  }
  clearTimeout(deadline);

  let releaseError=null;
  if(!leaseUncertain){
    try{
      const released=await serviceRest('rpc/release_workspace_backup_lease_v1','',{
        method:'POST',
        body:{p_workspace_id:workspaceId,p_lease_id:leaseId},
        signal:AbortSignal.timeout(LEASE_RPC_TIMEOUT_MS)
      });
      if(released!==true) throw new Error('백업 lease 해제를 확인할 수 없습니다.');
    }catch(e){
      releaseError=e;
    }
  }

  if(operationError && releaseError){
    throw new AggregateError(
      [operationError,releaseError],
      `백업 실패 후 lease 해제도 실패했습니다: ${operationError.message}`
    );
  }
  if(operationError) throw operationError;
  if(leaseUncertain){
    throw new Error('백업 lease를 재검증할 수 없어 작업을 안전하게 종료했습니다.');
  }
  if(releaseError) throw releaseError;
  return result;
}

export async function createBackup(reason='manual',workspaceId){
  reason=assertBackupReason(reason);
  workspaceId=assertWorkspaceId(workspaceId);
  return withWorkspaceBackupLease(reason,workspaceId,signal=>
    createBackupWhileLeased(reason,workspaceId,signal)
  );
}

export async function removeStorageManifest(manifest){
  const entries=normalizeStorageManifest(manifest);
  const grouped=new Map();
  for(const item of entries){
    const names=grouped.get(item.bucketId)||[];
    names.push(item.name);
    grouped.set(item.bucketId,names);
  }

  const sb=await client(AbortSignal.timeout(2*60*1000));
  let removed=0;
  for(const [bucketId,names] of grouped){
    for(let index=0;index<names.length;index+=STORAGE_REMOVE_CHUNK){
      const chunk=names.slice(index,index+STORAGE_REMOVE_CHUNK);
      const {error}=await sb.storage.from(bucketId).remove(chunk);
      if(error) throw error;
      removed+=chunk.length;
    }
  }
  return {removed};
}

async function listFolder(sb,folder){
  const {data,error}=await sb.storage.from(BACKUP_BUCKET).list(folder,{
    limit:100,
    sortBy:{column:'created_at',order:'desc'}
  });
  if(error){
    if(String(error.message||'').toLowerCase().includes('not found')) return [];
    throw error;
  }
  return (data||[])
    .filter(x=>x.name && !x.name.endsWith('/'))
    .map(x=>({
      path:`${folder}/${x.name}`,
      folder:folder.split('/').pop(),
      name:x.name,
      created_at:x.created_at||null,
      updated_at:x.updated_at||null,
      size:x.metadata?.size??null
    }));
}

export async function listBackups(workspaceId){
  workspaceId=assertWorkspaceId(workspaceId);
  const sb=await client();
  await ensureBucket(sb);
  const groups=await Promise.all(['daily','manual','safety'].map(kind=>listFolder(sb,`${workspaceRoot(workspaceId)}/${kind}`)));
  return groups.flat().sort((a,b)=>String(b.created_at||b.name).localeCompare(String(a.created_at||a.name)));
}

function allowedBackupPath(path,workspaceId){
  const root=workspaceRoot(workspaceId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  return new RegExp(`^${root}\/(daily|manual|safety)\/[A-Za-z0-9_.-]+\\.json\\.gz$`).test(String(path||''));
}

async function loadBackup(sb,path,workspaceId){
  if(!allowedBackupPath(path,workspaceId)) throw new Error('현재 워크스페이스에 허용되지 않은 백업 경로입니다.');
  const {data,error}=await sb.storage.from(BACKUP_BUCKET).download(path);
  if(error) throw error;
  if(data.size>BACKUP_MAX_COMPRESSED_BYTES) throw new Error('백업 압축 파일이 복구 안전 크기를 초과했습니다.');
  const compressed=Buffer.from(await data.arrayBuffer());
  const raw=(await decompressBackup(compressed,{maxOutputLength:BACKUP_MAX_RAW_BYTES})).toString('utf8');
  return migrateBackup(JSON.parse(raw));
}

export function migrateBackup(input){
  if(!input || input.format!=='bangsel-db-backup'){
    throw new Error('지원하지 않는 백업 파일 형식입니다.');
  }
  const b=structuredClone(input);
  const version=Number(b.backup_version||0);

  if(version>BACKUP_FORMAT_VERSION){
    throw new Error(`이 백업은 더 새로운 버전(v${version})에서 생성되었습니다.`);
  }

  // v1은 SOOP ID 유저 마스터 도입 전 백업입니다.
  // 기존 작업은 그대로 유지하고 새 유저 마스터만 빈 배열로 보완합니다.
  if(Number(b.backup_version)===1){
    b.tables=b.tables||{};
    if(!Array.isArray(b.tables.bangsel_fans)) b.tables.bangsel_fans=[];
    b.backup_version=2;
  }
  if(Number(b.backup_version)===2){
    b.tables=b.tables||{};
    if(!Array.isArray(b.tables.bangsel_roulette_rules)) b.tables.bangsel_roulette_rules=[];
    b.backup_version=3;
  }
  if(Number(b.backup_version)===3){
    b.tables=b.tables||{};
    if(!Array.isArray(b.tables.bangsel_donations)) b.tables.bangsel_donations=[];
    b.backup_version=4;
  }
  if(Number(b.backup_version)===4){
    b.tables=b.tables||{};
    if(!Array.isArray(b.tables.bangsel_task_import_items)) b.tables.bangsel_task_import_items=[];
    b.backup_version=5;
  }
  if(Number(b.backup_version)===5 || Number(b.backup_version)===6){
    // v7부터 백업 파일 자체에 워크스페이스 소유권을 기록합니다.
    // 구형 파일은 새 워크스페이스 전용 경로에서 로드된 경우에만 현재 워크스페이스로 귀속합니다.
    b.backup_version=7;
  }

  if(Number(b.backup_version)===7){
    b.tables=b.tables||{};
    for(const cfg of BACKUP_TABLES){
      if(!Object.hasOwn(b.tables,cfg.name)) b.tables[cfg.name]=[];
    }
    b.backup_version=8;
    b.migrated_from_version=7;
  }

  if(Number(b.backup_version)===8){
    b.tables=b.tables||{};
    if(!Object.hasOwn(b.tables,'byeollog_soop_core_donations')) b.tables.byeollog_soop_core_donations=[];
    b.backup_version=9;
  }

  if(Number(b.backup_version)===9){
    b.tables=b.tables||{};
    if(!Object.hasOwn(b.tables,'byeollog_reverse_fan_days'))b.tables.byeollog_reverse_fan_days=[];
    b.backup_version=10;
  }

  // 향후 v5->v6 같은 스키마 변경도 같은 방식으로 단계별 변환을 추가합니다.
  if(Number(b.backup_version)!==BACKUP_FORMAT_VERSION){
    throw new Error(`지원되지 않는 백업 버전입니다: ${b.backup_version}`);
  }

  b.tables=b.tables||{};
  return b;
}

function validateTableRows(name,rows){
  if(!Array.isArray(rows)) throw new Error(`${name} 데이터가 배열이 아닙니다.`);
  if(rows.length>100000) throw new Error(`${name} 행 수가 비정상적으로 많습니다.`);
}

function validateWorkspaceRows(backup,workspaceId){
  if(backup.workspace_id && backup.workspace_id!==workspaceId){
    throw new Error('다른 워크스페이스의 백업은 복구할 수 없습니다.');
  }
  if(!backup.tables || typeof backup.tables!=='object' || Array.isArray(backup.tables)){
    throw new Error('백업 테이블 형식이 올바르지 않습니다.');
  }
  for(const name of Object.keys(backup.tables)){
    if(!BACKUP_TABLES.some(cfg=>cfg.name===name)) throw new Error('지원하지 않는 백업 테이블입니다.');
  }
  for(const cfg of BACKUP_TABLES){
    const rows=backup.tables[cfg.name]??[];
    validateTableRows(cfg.name,rows);
    const keys=new Set();
    for(const row of rows){
      if(!row || typeof row!=='object' || Array.isArray(row) || row.workspace_id!==workspaceId){
        throw new Error(`${cfg.name}에 현재 워크스페이스와 다른 데이터가 포함되어 있습니다.`);
      }
      if(cfg.order.some(column=>row[column]===null||row[column]===undefined)){
        throw new Error(`${cfg.name}의 복구 식별자가 누락되었습니다.`);
      }
      const key=JSON.stringify(cfg.order.map(column=>row[column]));
      if(keys.has(key)) throw new Error(`${cfg.name}의 복구 식별자가 중복되었습니다.`);
      keys.add(key);
    }
  }
}

export async function createDailyBackups(){
  const sb=await client();
  const workspaces=await readActiveWorkspacesPaged(sb);
  const items=[];
  for(const workspace of workspaces){
    try{
      items.push({ok:true,slug:workspace.slug,...await createBackup('daily',workspace.id)});
    }catch(e){
      items.push({ok:false,workspace_id:workspace.id,slug:workspace.slug,error_code:safeBackupErrorCode(e)});
    }
  }
  const failed=items.filter(x=>!x.ok).length;
  return {created:items.length-failed,failed,items};
}

// A server-side operator can resume at workspace granularity. Each request has
// its own function deadline; there is no long chain of nested HTTP functions.
export async function dailyBackupTargets(){
  return (await readActiveWorkspacesPaged(await client(AbortSignal.timeout(20000)))).map(({id})=>id);
}

export async function createDailyWorkspaceBackup(workspaceId,publicKey){
  workspaceId=assertWorkspaceId(workspaceId);
  // Validate before creating a snapshot or writing anything.
  sealBackup(Buffer.alloc(0),publicKey);
  const storage=await client(AbortSignal.timeout(250000));
  const folder=folderFor(workspaceId,'daily');
  const {data,error}=await storage.storage.from(BACKUP_BUCKET).list(folder,{limit:1,sortBy:{column:'created_at',order:'desc'}});
  if(error)throw error;
  const latest=(data||[])[0],created=Date.parse(latest?.created_at||'');
  const reusable=latest?.name&&/^[A-Za-z0-9_.-]+\.json\.gz$/.test(latest.name)&&Number.isFinite(created)&&Date.now()-created>=0&&Date.now()-created<18*60*60*1000;
  let result=reusable?{path:`${folder}/${latest.name}`,created_at:latest.created_at,workspace_id:workspaceId,reused:true}:await createBackup('daily',workspaceId);
  const readArchive=async path=>{
    if(!allowedBackupPath(path,workspaceId))throw Error('Invalid backup archive path');
    const download=await storage.storage.from(BACKUP_BUCKET).download(path);
    if(download.error)throw download.error;
    if(download.data.size>3*1024*1024)throw Error('Independent backup transport exceeds safe size');
    const bytes=Buffer.from(await download.data.arrayBuffer());
    const raw=await decompressBackup(bytes,{maxOutputLength:BACKUP_MAX_RAW_BYTES});
    return {bytes,input:JSON.parse(raw.toString('utf8'))};
  };
  let archive=await readArchive(result.path);
  // Do not keep reusing an older archive which lacks the new recovery table.
  if(result.reused&&Number(archive.input.backup_version)<BACKUP_FORMAT_VERSION){
    result=await createBackup('daily',workspaceId);archive=await readArchive(result.path);
  }
  const {bytes,input}=archive;
  // An independent copy is accepted only after validating archive ownership and
  // format using the same restore validator as the user-facing restore flow.
  const payload=migrateBackup(input);
  if(payload.workspace_id!==workspaceId)throw Error('Backup archive ownership mismatch');
  validateWorkspaceRows(payload,workspaceId);
  return {workspace_id:workspaceId,created_at:result.created_at,backup_version:Number(input.backup_version),reused:result.reused===true,archive:sealBackup(bytes,publicKey)};
}

export async function restoreBackupMerge(path,workspaceId){
  workspaceId=assertWorkspaceId(workspaceId);
  return withWorkspaceBackupLease('pre-restore',workspaceId,async (signal,leaseId)=>{
    const sb=await client(signal);
    await ensureBucket(sb);

    let backup=await loadBackup(sb,path,workspaceId);
    validateWorkspaceRows(backup,workspaceId);
    backup=pruneWallpaperArchive(backup).backup;
    const safety=await createBackupWhileLeased('pre-restore',workspaceId,signal);
    let restored;
    try{
      // Never fall back to sequential upserts: a late constraint/connection
      // failure must not leave a partially restored account.
      restored=await serviceRest('rpc/byeollog_restore_backup_v4','',{
        method:'POST',body:{p_workspace_id:workspaceId,p_lease_id:leaseId,p_tables:backup.tables},
        signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])
      });
      for(const cfg of BACKUP_TABLES){
        if(restored?.[cfg.name] !== (backup.tables[cfg.name]??[]).length){
          throw new Error('복원 결과를 확인할 수 없습니다. 다시 실행하기 전에 현재 데이터를 확인해주세요.');
        }
      }
    }catch(e){
      throw new Error(`백업 복구를 완료하지 못했습니다: ${e.message}. 복구 직전 안전 백업: ${safety.path}`);
    }

    return {
      source:path,
      workspace_id:workspaceId,
      backup_created_at:backup.created_at||null,
      safety_backup:safety.path,
      strategy:'merge-upsert',
      restored
    };
  });
}
