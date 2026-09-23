import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync,gzipSync} from 'node:zlib';
import {generateKeyPairSync,privateDecrypt,createDecipheriv,createHash,constants} from 'node:crypto';
import {createBackup,createDailyBackups,createDailyWorkspaceBackup,BACKUP_TABLES} from '../lib/backup.js';
const recipient=generateKeyPairSync('rsa',{modulusLength:3072,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});

const workspace='10000000-0000-4000-8000-000000000001';
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});

async function withStorageFixture(run,{denyLease=false,failUpload=false,rowCount=3}={}){
  const originalFetch=globalThis.fetch;
  const names=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'];
  const originals=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  process.env.SUPABASE_URL='https://backup-test.invalid';
  process.env.SUPABASE_SECRET_KEY='test-only-key';
  process.env.SUPABASE_SERVICE_ROLE_KEY='test-only-role';
  const calls=[],uploads=[],leases=[],exports=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url||String(input));
    assert.equal(url.origin,'https://backup-test.invalid','tests must never reach a real service');
    const path=url.pathname;
    calls.push(path);
    if(path.endsWith('/rpc/begin_workspace_backup_v1')){
      const body=JSON.parse(init.body);leases.push(body);
      // Matches the deployed RPC contract, not the caller's own assumptions.
      if(!['automatic','manual','pre_restore'].includes(body.p_reason))return json({message:'backup lease request is invalid',code:'22023'},400);
      if(denyLease)return json({message:'account withdrawal is in progress',code:'55000'},400);
      assert.equal(body.p_workspace_id,workspace);
      return json([{lease_id:body.p_lease_id,expires_at:new Date(Date.now()+1800000).toISOString()}]);
    }
    if(path.endsWith('/rpc/release_workspace_backup_lease_v1'))return json(true);
    if(path.endsWith('/rpc/byeollog_export_backup_v10')){
      const body=JSON.parse(init.body);
      assert.equal(body.p_workspace_id,workspace);
      const tables=Object.fromEntries(BACKUP_TABLES.map(cfg=>{
        const tableRowCount=cfg.order.every(column=>column==='workspace_id')?1:rowCount;
        return [cfg.name,
        Array.from({length:tableRowCount},(_,i)=>({
          ...Object.fromEntries(cfg.order.map(column=>[column,`fixture-${i}`])),
          workspace_id:workspace,
          ...(cfg.name==='byeollog_wallpaper_tiles'?{received_at:new Date().toISOString(),session_id:`fixture-${i}`}:{})
        }))];
      }));
      exports.push(tables);
      return json(tables);
    }
    if(path==='/storage/v1/bucket')return json([{id:'bangsel-backups',name:'bangsel-backups'}]);
    if(path==='/rest/v1/byeollog_workspaces')return json([{id:workspace,slug:'test'}],200,{'content-range':'0-0/1'});
    if(path.startsWith('/storage/v1/object/list/'))return json(uploads.map(x=>({name:x.path.split('/').at(-1),created_at:x.payload.created_at})));
    if(path.startsWith('/storage/v1/object/bangsel-backups/')){
      if((init.method||'GET').toUpperCase()==='GET'){
        const uploaded=uploads.find(x=>x.path===path);assert.ok(uploaded);return new Response(uploaded.bytes,{headers:{'content-type':'application/gzip'}});
      }
      if(failUpload)return json({message:'injected upload failure'},400);
      uploads.push({path,bytes:Buffer.from(init.body),payload:JSON.parse(gunzipSync(Buffer.from(init.body)).toString('utf8'))});
      return json({Key:path});
    }
    throw Error('Unexpected fixture request: '+path);
  };
  try{return await run({calls,uploads,leases,exports});}
  finally{
    globalThis.fetch=originalFetch;
    for(const name of names){if(originals[name]===undefined)delete process.env[name];else process.env[name]=originals[name];}
  }
}

for(const [reason,leaseReason,folder] of [['daily','automatic','daily'],['manual','manual','manual'],['pre-restore','pre_restore','safety']]){
  test(`real backup flow maps ${reason} lease while preserving stored format and folder`,()=>withStorageFixture(async f=>{
    const result=await createBackup(reason,workspace);
    assert.equal(f.leases[0].p_reason,leaseReason);
    assert.equal(f.uploads.length,1);
    assert.equal(f.uploads[0].payload.reason,reason);
    assert.equal(f.uploads[0].payload.backup_version,10);
    for(const cfg of BACKUP_TABLES){
      assert.equal(f.uploads[0].payload.tables[cfg.name].length,cfg.order.every(column=>column==='workspace_id')?1:3);
    }
    assert.equal(f.exports.length,1);
    assert.ok(result.path.startsWith(`workspaces/${workspace}/${folder}/`));
    assert.equal(f.calls.filter(p=>p.endsWith('/release_workspace_backup_lease_v1')).length,1);
  }));
}
test('daily runner completes the actual per-workspace backup flow',()=>withStorageFixture(async f=>{
  const result=await createDailyBackups();
  assert.equal(result.failed,0);assert.equal(result.created,1);assert.equal(f.uploads.length,1);
}));
test('withdrawal lease rejection prevents table reads and uploads',()=>withStorageFixture(async f=>{
  await assert.rejects(createBackup('daily',workspace),/withdrawal/);
  assert.equal(f.exports.length,0);assert.equal(f.uploads.length,0);
},{denyLease:true}));
test('uncertain upload keeps the safety lease instead of releasing it early',()=>withStorageFixture(async f=>{
  await assert.rejects(createBackup('manual',workspace),/injected upload failure/);
  assert.equal(f.calls.filter(p=>p.endsWith('/release_workspace_backup_lease_v1')).length,0);
},{failUpload:true}));
test('invalid backup reason makes no external request',()=>withStorageFixture(async f=>{
  await assert.rejects(createBackup('unexpected',workspace));assert.equal(f.calls.length,0);
}));
test('one database snapshot preserves every table row across compression',()=>withStorageFixture(async f=>{
  await createBackup('daily',workspace);
  assert.equal(f.exports.length,1);
  for(const cfg of BACKUP_TABLES){
    const rows=f.uploads[0].payload.tables[cfg.name];
    const expected=cfg.order.every(column=>column==='workspace_id')?1:1001;
    assert.equal(rows.length,expected);
    if(expected>1)assert.equal(rows.at(-1)[cfg.order[0]],'fixture-1000');
  }
},{rowCount:1001}));

test('independent backup encrypts a real valid v9 archive and retry reuses it',()=>withStorageFixture(async f=>{
  const first=await createDailyWorkspaceBackup(workspace,recipient.publicKey);
  const next=await createDailyWorkspaceBackup(workspace,recipient.publicKey);
  assert.equal(first.reused,false);assert.equal(next.reused,true);assert.equal(f.uploads.length,1);
  const a=first.archive,key=privateDecrypt({key:recipient.privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(a.wrappedKey,'base64'));
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(a.iv,'base64'));decipher.setAAD(Buffer.from(a.format));decipher.setAuthTag(Buffer.from(a.tag,'base64'));
  const bytes=Buffer.concat([decipher.update(Buffer.from(a.ciphertext,'base64')),decipher.final()]);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),a.sha256);assert.deepEqual(bytes,f.uploads[0].bytes);
  assert.equal(JSON.parse(gunzipSync(bytes)).workspace_id,workspace);
  assert.doesNotMatch(JSON.stringify(a),/fixture-0/);
}));
test('invalid independent backup recipient makes no network requests',()=>withStorageFixture(async f=>{
  await assert.rejects(createDailyWorkspaceBackup(workspace,'not a public key'));assert.equal(f.calls.length,0);
}));

test('independent mirror replaces a reusable v8 archive with a fresh v9 snapshot once',()=>withStorageFixture(async f=>{
 await createBackup('daily',workspace);const old=f.uploads[0];old.payload.backup_version=8;delete old.payload.tables.byeollog_soop_core_donations;old.bytes=gzipSync(JSON.stringify(old.payload));
 const result=await createDailyWorkspaceBackup(workspace,recipient.publicKey);
 assert.equal(result.backup_version,10);assert.equal(result.reused,false);assert.equal(f.uploads.length,2);assert.ok(f.uploads[1].payload.tables.byeollog_soop_core_donations);
}));
