import {createClient} from '@supabase/supabase-js';
import crypto from 'node:crypto';
import {gzipSync, gunzipSync} from 'node:zlib';
import {sb as serviceRest} from './supabase-rest.js';
import {normalizeStorageManifest} from './storage-manifest.js';

export const BACKUP_FORMAT_VERSION = 7;
export const BACKUP_BUCKET = 'bangsel-backups';

export const BACKUP_TABLES = [
  {name:'bangsel_tasks', conflict:'id', order:['id']},
  {name:'bangsel_fan_stations', conflict:'workspace_id,fan', order:['fan']},
  {name:'bangsel_fans', conflict:'workspace_id,soop_id', order:['soop_id']},
  {name:'bangsel_roulette_rules', conflict:'workspace_id,result_text', order:['result_text']},
  {name:'bangsel_donations', conflict:'workspace_id,source_event_key', order:['source_event_key']},
  {name:'bangsel_task_import_items', conflict:'workspace_id,source_event_key', order:['source_event_key']},
  {name:'bangsel_roulette_invalidations', conflict:'workspace_id,source_uid', order:['source_uid']}
];

const RETENTION = {daily:30, manual:10, safety:10};
const BACKUP_LEASE_SECONDS = 1800;
const BACKUP_OPERATION_TIMEOUT_MS = 20*60*1000;
const LEASE_RPC_TIMEOUT_MS = 10*1000;
const STORAGE_REMOVE_CHUNK = 100;
const BACKUP_PAGE_SIZE = 500;
const BACKUP_MAX_ROWS_PER_TABLE = 100000;
const BACKUP_MAX_WORKSPACES = 10000;

function env(name){
  const v=process.env[name]||'';
  if(!v) throw new Error(`${name} is not configured`);
  return v;
}

function client(operationSignal){
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

async function readTablePaged(sb,cfg,workspaceId){
  const rows=[];
  const seenKeys=new Set();
  let expectedCount=null;

  while(true){
    let query=sb.from(cfg.name)
      .select('*',{count:'exact'})
      .eq('workspace_id',workspaceId);
    for(const column of cfg.order){
      query=query.order(column,{ascending:true,nullsFirst:false});
    }
    const start=rows.length;
    const {data,error,count}=await query.range(start,start+BACKUP_PAGE_SIZE-1);
    if(error) throw new Error(`${cfg.name} 백업 조회 실패: ${error.message}`);
    if(!Number.isSafeInteger(count) || count<0 || count>BACKUP_MAX_ROWS_PER_TABLE){
      throw new Error(`${cfg.name} 백업 전체 행 수를 확인할 수 없습니다.`);
    }
    if(expectedCount===null) expectedCount=count;
    if(count!==expectedCount){
      throw new Error(`${cfg.name} 백업 중 행 수가 변경되었습니다. 다시 시도해주세요.`);
    }

    const page=Array.isArray(data)?data:[];
    for(const row of page){
      const stableKey=JSON.stringify(cfg.order.map(column=>row?.[column]));
      if(cfg.order.some(column=>row?.[column]===null || row?.[column]===undefined)
        || seenKeys.has(stableKey)){
        throw new Error(`${cfg.name} 백업 정렬 키가 누락되었거나 중복되었습니다.`);
      }
      seenKeys.add(stableKey);
      rows.push(row);
    }

    if(rows.length>expectedCount){
      throw new Error(`${cfg.name} 백업 행 수가 예상값을 초과했습니다.`);
    }
    if(rows.length===expectedCount) break;
    if(page.length!==BACKUP_PAGE_SIZE){
      throw new Error(`${cfg.name} 백업이 중간에서 잘렸습니다.`);
    }
  }

  if(rows.length!==expectedCount){
    throw new Error(`${cfg.name} 백업 행 수 검증에 실패했습니다.`);
  }
  return rows;
}

async function readAllTables(sb,workspaceId){
  const entries=await Promise.all(BACKUP_TABLES.map(async cfg=>{
    const rows=await readTablePaged(sb,cfg,workspaceId);
    return [cfg.name,rows];
  }));
  return Object.fromEntries(entries);
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
    note:'DB metadata only. Browser-local media files are not included.',
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
  const sb=client(operationSignal);
  await ensureBucket(sb);

  const tables=await readAllTables(sb,workspaceId);
  const payload=buildPayload(tables,reason,workspaceId);
  const raw=Buffer.from(JSON.stringify(payload),'utf8');
  const gz=gzipSync(raw,{level:9});

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
      p_reason:reason,
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
    result=await operation(operationController.signal);
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

  const sb=client(AbortSignal.timeout(2*60*1000));
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
  const sb=client();
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
  const compressed=Buffer.from(await data.arrayBuffer());
  const raw=gunzipSync(compressed).toString('utf8');
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
  for(const cfg of BACKUP_TABLES){
    const rows=backup.tables[cfg.name]||[];
    for(const row of rows){
      if(!row || row.workspace_id!==workspaceId){
        throw new Error(`${cfg.name}에 현재 워크스페이스와 다른 데이터가 포함되어 있습니다.`);
      }
    }
  }
}

export async function createDailyBackups(){
  const sb=client();
  const workspaces=await readActiveWorkspacesPaged(sb);
  const items=[];
  for(const workspace of workspaces){
    try{
      items.push({ok:true,slug:workspace.slug,...await createBackup('daily',workspace.id)});
    }catch(e){
      items.push({ok:false,workspace_id:workspace.id,slug:workspace.slug,error:String(e?.message||e)});
    }
  }
  const failed=items.filter(x=>!x.ok).length;
  return {created:items.length-failed,failed,items};
}

export async function restoreBackupMerge(path,workspaceId){
  workspaceId=assertWorkspaceId(workspaceId);
  return withWorkspaceBackupLease('pre-restore',workspaceId,async signal=>{
    const sb=client(signal);
    await ensureBucket(sb);

    const backup=await loadBackup(sb,path,workspaceId);
    validateWorkspaceRows(backup,workspaceId);
    const safety=await createBackupWhileLeased('pre-restore',workspaceId,signal);
    const restored={};

    for(const cfg of BACKUP_TABLES){
      const rows=backup.tables[cfg.name]||[];
      validateTableRows(cfg.name,rows);

      if(!rows.length){
        restored[cfg.name]=0;
        continue;
      }

      for(let i=0;i<rows.length;i+=500){
        const chunk=rows.slice(i,i+500);
        const {error}=await sb.from(cfg.name).upsert(chunk,{
          onConflict:cfg.conflict,
          ignoreDuplicates:false
        });
        if(error){
          throw new Error(
            `${cfg.name} 복구 실패: ${error.message}. `+
            `복구 직전 안전 백업은 ${safety.path} 에 저장되었습니다.`
          );
        }
      }
      restored[cfg.name]=rows.length;
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
