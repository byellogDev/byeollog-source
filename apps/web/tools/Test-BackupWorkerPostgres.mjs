import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
import {BACKUP_TABLES} from '../lib/backup.js';
const runtime=await isolatedSpecialPostgres(),root=new URL('../',import.meta.url);
const machine='10000000-0000-4000-8000-000000000001',human='20000000-0000-4000-8000-000000000002',session='30000000-0000-4000-8000-000000000003',ws='40000000-0000-4000-8000-000000000004',lease='50000000-0000-4000-8000-000000000005';
let checks=0;
const q=v=>"'"+String(v).replaceAll("'","''")+"'";
async function asUser(sql,user=machine){
 const values=await runtime.sql(`begin;set local role authenticated;select set_config('request.jwt.claims',${q(JSON.stringify({sub:user,session_id:session}))},true);${sql};commit;`);return values[3];
}
async function denied(sql,user=machine){await assert.rejects(()=>asUser(sql,user));checks++}
const call=(op,args={})=>`select public.byeollog_backup_worker_v1(${q(op)},${q(JSON.stringify(args))}::jsonb) as value`;
try{
 await runtime.sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text);create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id));
 create function auth.uid() returns uuid language sql stable as $$select (current_setting('request.jwt.claims',true)::jsonb->>'sub')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select current_setting('request.jwt.claims',true)::jsonb$$;
 insert into auth.users values('${machine}','machine@example.invalid'),('${human}','human@example.invalid');insert into auth.sessions values('${session}','${machine}');
 create table public.byeollog_workspaces(id uuid primary key,slug text,status text,owner_email text);
 alter table public.byeollog_workspaces enable row level security;
 insert into public.byeollog_workspaces values('${ws}','synthetic','active','PRIVATE_EMAIL');
 create table public.byeollog_workspace_members(user_id uuid,email text);
 create table public.byeollog_workspace_backup_leases(workspace_id uuid,lease_id uuid,reason text,expires_at timestamptz,created_at timestamptz,updated_at timestamptz);
 create table public.byeollog_account_withdrawal_intents(workspace_id uuid,is_workspace_owner boolean,expires_at timestamptz);
 create table storage.buckets(id text primary key);create table storage.objects(id integer primary key,bucket_id text,name text);
 alter table storage.buckets enable row level security;alter table storage.objects enable row level security;
 grant usage on schema storage to authenticated;grant select,insert,update,delete on storage.objects to authenticated;
 insert into storage.buckets values('bangsel-backups'),('private-images');insert into storage.objects values(1,'bangsel-backups','workspaces/synthetic/manual/backup.json.gz'),(2,'private-images','PRIVATE_IMAGE');
 `);
 for(const table of BACKUP_TABLES){
  const columns=[...new Set([...table.order,...(table.name==='byeollog_wallpaper_sessions'?['started_at']:[]),...(table.name==='byeollog_wallpaper_tiles'?['session_id','sequence_no']:[])])].filter(c=>c!=='workspace_id');
  await runtime.sql(`create table public.${table.name}(workspace_id uuid${columns.map(c=>', '+c+' text').join('')});alter table public.${table.name} enable row level security;insert into public.${table.name} values('${ws}'${columns.map(()=>", 'synthetic'").join('')});`);
 }
 await runtime.sql(await readFile(new URL('test/fixtures/isolated-backup-baseline.sql',root),'utf8'));
 await runtime.sql('revoke execute on all functions in schema public from public,anon,authenticated;grant execute on all functions in schema public to service_role');
 await runtime.sql(await readFile(new URL('supabase/migrations/20260920155615_isolated_backup_worker.sql',root),'utf8'));
 await runtime.sql(`insert into byeollog_worker_security.accounts values('${machine}','backup',true)`);
 assert.equal((await asUser(call('probe'))).rows[0].value,true);checks++;
 const exported=(await asUser(call('export',{p_workspace_id:ws}))).rows[0].value;
 assert.deepEqual(Object.keys(exported).sort(),BACKUP_TABLES.map(x=>x.name).sort());assert(Object.values(exported).every(rows=>rows.length===1));checks++;
 const begun=(await asUser(call('begin',{p_workspace_id:ws,p_lease_id:lease,p_reason:'automatic',p_lease_seconds:1800}))).rows[0].value;assert.equal(begun[0].lease_id,lease);checks++;
 assert.equal((await asUser(call('release',{p_workspace_id:ws,p_lease_id:lease}))).rows[0].value,true);checks++;
 assert.deepEqual((await asUser(call('inventory'))).rows[0].value,[{name:'workspaces/synthetic/manual/backup.json.gz'}]);checks++;
 assert.equal((await asUser('select id,slug,status from public.byeollog_workspaces')).rows.length,1);checks++;
 assert.equal((await asUser('select id,slug from public.byeollog_workspaces',human)).rows.length,0);checks++;
 assert.equal((await asUser('select id from storage.objects')).rows.length,1);checks++;
 assert.equal((await asUser('select id from storage.objects',human)).rows.length,0);checks++;
 await asUser("insert into storage.objects values(3,'bangsel-backups','synthetic.new.json.gz')");checks++;
 for(const user of [machine,human]){
  await denied('select email from auth.users',user);
  await denied('select email from public.byeollog_workspace_members',user);
  await denied('select owner_email from public.byeollog_workspaces',user);
  await denied('select * from public.bangsel_tasks',user);
  await denied('delete from public.bangsel_tasks',user);
  await denied('select * from byeollog_worker_security.accounts',user);
  await denied("insert into storage.objects values(4,'private-images','injected')",user);
  await denied(`select public.byeollog_export_backup_v10('${ws}')`,user);
 }
 await denied(call('probe'),human);await denied(call('restore',{p_workspace_id:ws}));
 await denied(call('begin',{p_workspace_id:ws,p_lease_id:lease,p_reason:'pre_restore',p_lease_seconds:1800}));
 await denied("insert into storage.objects values(5,'bangsel-backups','injected')",human);
 await runtime.sql(`update byeollog_worker_security.accounts set enabled=false where user_id='${machine}'`);
 await denied(call('probe'));assert.equal((await asUser('select id from storage.objects')).rows.length,0);checks++;
 await runtime.sql(`update byeollog_worker_security.accounts set enabled=true;delete from auth.sessions where id='${session}'`);
 await denied(call('probe'));
 const roles=(await runtime.sql("select rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname='byeollog_backup_reader'")).rows[0];assert(Object.values(roles).every(x=>x===false));checks++;
 const report={passed:true,checks,roles};await writeFile(new URL('output/runtime-isolation-20260921/backup-postgres.json',root),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await runtime.stop()}
