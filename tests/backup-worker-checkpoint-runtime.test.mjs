import {auditURL as _auditURL} from './resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';import assert from 'node:assert/strict';import {gzipSync,gunzipSync} from 'node:zlib';
import {retainBackupFile} from '../apps/backup-worker/lib/backup-retention.js';
test('backup worker checkpoint archive rewrite preserves unrelated history, verifies saved bytes, and is idempotent',async()=>{
 const original=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'],env=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.SUPABASE_URL='https://retention.invalid';process.env.SUPABASE_SECRET_KEY='fake';process.env.SUPABASE_SERVICE_ROLE_KEY='fake';
 const path='manual/legacy.json.gz',input={format:'bangsel-db-backup',backup_version:6,tables:{bangsel_tasks:[{id:'keep',total_qty:12}],byeollog_wallpaper_tiles:[{id:'old',received_at:'2020-01-01T00:00:00Z',session_id:'s'}],byeollog_wallpaper_sessions:[{id:'s',state:'closed',closed_at:'2020-01-02T00:00:00Z'}]}};
 let bytes=gzipSync(JSON.stringify(input)),writes=0;
 globalThis.fetch=async(url,init={})=>{const u=auditURL(typeof url==='string'?url:url.url);assert.equal(u.origin,'https://retention.invalid');if(u.pathname.endsWith('/byeollog_backup_retention_inventory_v1'))return Response.json([{name:path,updated_at:'2026-09-26T00:00:00Z'}]);if((init.method||'GET')==='GET')return new Response(bytes);assert.equal(init.method,'PUT');assert.notEqual(init.headers?.['x-upsert'],'true');bytes=Buffer.from(init.body);writes++;return Response.json({Key:path})};
 try{const r=await retainBackupFile(path);assert.equal(r.removedTiles,1);assert.equal(r.removedBroadcasts,1);assert.equal(writes,1);const after=JSON.parse(gunzipSync(bytes));assert.deepEqual(after.tables.bangsel_tasks,input.tables.bangsel_tasks);assert.equal(after.backup_version,6);const second=await retainBackupFile(path);assert.equal(second.changed,false);assert.equal(second.checkpoint.version,1);assert.equal(second.checkpoint.sourceVersion,'2026-09-26T00:00:00Z');assert.ok(second.checkpoint.nextReviewAt>Date.now());assert.equal(r.checkpoint,null);assert.equal(writes,1);await assert.rejects(retainBackupFile('../bad.json.gz'));await assert.rejects(retainBackupFile('manual/missing.json.gz'));}
 finally{globalThis.fetch=original;for(const k of keys)if(env[k]===undefined)delete process.env[k];else process.env[k]=env[k]}
});
