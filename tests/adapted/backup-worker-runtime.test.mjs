import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {backupWorkerConfiguration,backupWorkerRest} from '../../apps/admin-runtime/lib/backup-worker-client.js';
import handler from '../../apps/admin-runtime/lib/backup-worker-handler.js';
import {dailyBackupTargets,listBackups,createBackup} from '../../apps/admin-runtime/lib/backup-service.js';
const secret='a'.repeat(64),workspace='11111111-1111-4111-8111-111111111111';
const config={BYEOLLOG_RUNTIME:'backup',SUPABASE_URL:'https://synthetic.invalid',SUPABASE_ANON_KEY:'sb_publishable_synthetic',BYEOLLOG_BACKUP_ACCOUNT_EMAIL:'synthetic@example.invalid',BYEOLLOG_BACKUP_ACCOUNT_PASSWORD:'p'.repeat(40)};
const keys=[...Object.keys(config),'SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET','SOOP_CLIENT_SECRET','SOOP_TOKEN_ENCRYPTION_KEY','BYEOLLOG_BACKUP_WORKER_SECRET','BYEOLLOG_BACKUP_WORKER_URL'];
async function sandbox(fn){const before=Object.fromEntries(keys.map(k=>[k,process.env[k]])),fetch=globalThis.fetch;for(const k of keys)delete process.env[k];Object.assign(process.env,config,{BYEOLLOG_BACKUP_WORKER_SECRET:secret,BYEOLLOG_BACKUP_WORKER_URL:'https://byeollog-backup-worker.vercel.app/api/backup'});try{await fn()}finally{globalThis.fetch=fetch;for(const k of keys)if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k]}}
async function invoke(body,authorization='Bearer '+secret,method='POST'){let status,payload;const res={setHeader(){},status(n){status=n;return this},json(x){payload=x;return this}};await handler({headers:{authorization},method,body},res);return {status,payload}}
test('backup worker refuses privileged environment and non-anonymous API keys',()=>{
 assert.equal(backupWorkerConfiguration(config).email,config.BYEOLLOG_BACKUP_ACCOUNT_EMAIL);
 for(const key of ['SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET','SOOP_CLIENT_SECRET','SOOP_TOKEN_ENCRYPTION_KEY'])assert.throws(()=>backupWorkerConfiguration({...config,[key]:'forbidden'}));
 for(const override of [{BYEOLLOG_RUNTIME:'admin'},{SUPABASE_ANON_KEY:'sb_secret_forbidden'},{BYEOLLOG_BACKUP_ACCOUNT_PASSWORD:'short'}])assert.throws(()=>backupWorkerConfiguration({...config,...override}));
});
test('worker rejects unauthenticated, restore, malformed and caller-selected encryption before network',()=>sandbox(async()=>{
 globalThis.fetch=()=>{throw Error('must not contact a server')};
 assert.equal((await invoke({operation:'probe'},'')).status,401);
 assert.equal((await invoke({operation:'probe'},'Bearer bad')).status,401);
 assert.equal((await invoke({operation:'probe'},'Bearer '+secret,'GET')).status,405);
 for(const body of [{operation:'restore',workspaceId:workspace},{operation:'workspace',workspaceId:'bad'},{operation:'workspace',workspaceId:workspace,publicKey:'attacker'},[],null,'bad json'])assert.equal((await invoke(body)).status,400);
 process.env.SUPABASE_SECRET_KEY='forbidden';assert.equal((await invoke({operation:'probe'})).status,502);
}));
test('backup DB requests use machine session and a fixed RPC allowlist',()=>sandbox(async()=>{
 const calls=[];globalThis.fetch=async(input,init)=>{const url=auditURL(typeof input==='string'?input:input.url);calls.push(url.pathname);if(url.pathname==='/auth/v1/token'){assert.equal(init.headers.apikey,config.SUPABASE_ANON_KEY);return Response.json({access_token:'synthetic-machine-token',expires_in:3600})}assert.equal(url.pathname,'/rest/v1/rpc/byeollog_backup_worker_v1');assert.equal(new Headers(init.headers).get('authorization'),'Bearer synthetic-machine-token');const body=JSON.parse(init.body);assert.equal(body.p_operation,'inventory');return Response.json([])};
 assert.deepEqual(await backupWorkerRest('rpc/byeollog_backup_retention_inventory_v1','',{method:'POST',body:{}}),[]);
 assert.deepEqual(calls,['/auth/v1/token','/rest/v1/rpc/byeollog_backup_worker_v1']);
 for(const table of ['bangsel_tasks','rpc/restore_workspace_backup_v1','rpc/arbitrary'])await assert.rejects(backupWorkerRest(table,'',{method:'POST'}),/outside/);
 await assert.rejects(backupWorkerRest('rpc/byeollog_export_backup_v10','?extra=1',{method:'POST'}),/outside/);
}));
test('bridge forwards only to the isolated origin, preserves operation result and never falls back',()=>sandbox(async()=>{
 let calls=0;globalThis.fetch=async(url,init)=>{calls++;assert.equal(url.origin,'https://byeollog-backup-worker.vercel.app');assert.equal(init.headers.Authorization,'Bearer '+secret);assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{operation:'list',workspaceId:workspace});return Response.json({ok:true,result:[{path:'synthetic'}]})};
 assert.deepEqual(await listBackups(workspace),[{path:'synthetic'}]);assert.equal(calls,1);
 for(const url of ['https://attacker.invalid/api/backup','http://byeollog-backup-worker.vercel.app/api/backup','https://byeollog-backup-worker.vercel.app:444/api/backup','https://byeollog-backup-worker.vercel.app/api/backup?secret=x']){process.env.BYEOLLOG_BACKUP_WORKER_URL=url;await assert.rejects(dailyBackupTargets())}assert.equal(calls,1);
 process.env.BYEOLLOG_BACKUP_WORKER_URL='https://byeollog-backup-worker.vercel.app/api/backup';process.env.BYEOLLOG_BACKUP_WORKER_SECRET=secret+'suffix';await assert.rejects(dailyBackupTargets());assert.equal(calls,1);
 process.env.BYEOLLOG_BACKUP_WORKER_SECRET=secret;globalThis.fetch=async()=>{calls++;return new Response('upstream error',{status:503})};await assert.rejects(dailyBackupTargets(),/request failed/);assert.equal(calls,2);
 assert.throws(()=>createBackup('pre-restore',workspace),/Unsupported/);
}));
