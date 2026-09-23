import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
const runtime=await isolatedSpecialPostgres();
const token='ab'.repeat(32),bad='cd'.repeat(32);
const q=value=>"'"+String(value).replaceAll("'","''")+"'";
const root=new URL('../',import.meta.url);
const checks=[];
const call=(op,args,secret=token)=>`public.byeollog_public_read_v1(${q(secret)},${q(op)},${q(JSON.stringify(args))}::jsonb)`;
async function deny(sql){await assert.rejects(()=>runtime.sql(sql));checks.push('denied: '+sql.slice(0,90).replaceAll(token,'[synthetic]'))}
async function asAnon(expr){const results=await runtime.sql(`begin;set local role anon;select ${expr} as value;commit;`);return results[2].rows[0].value}
try{
 await runtime.sql(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 create schema private;create schema extensions;create schema auth;create extension pgcrypto with schema extensions;
 create table auth.users(id uuid,email text);
 create table public.byeollog_workspace_members(user_id uuid,workspace_id uuid,email text);
 create table public.byeollog_workspaces(id uuid primary key,slug text,display_name text,status text,public_page_enabled boolean,public_completed_enabled boolean,owner_user_id uuid,private_email text);
 create table public.bangsel_tasks(id uuid primary key,workspace_id uuid,fan text,event text,type text,total_qty integer,done_qty integer,created_at timestamptz,completed_at timestamptz,fan_soop_id text,public_comment text,memo text);
 create table public.bangsel_fans(workspace_id uuid,soop_id text,alias text,current_nickname text,private_note text);
 create table public.byeollog_roulette_drafts(workspace_id uuid,public_visible boolean,roulette_name text,draft jsonb,updated_at timestamptz);
 alter table public.byeollog_workspaces enable row level security;alter table public.bangsel_tasks enable row level security;alter table public.bangsel_fans enable row level security;alter table public.byeollog_roulette_drafts enable row level security;
 insert into public.byeollog_workspaces values
 ('10000000-0000-4000-8000-000000000001','visible','Public channel','active',true,true,null,'private@example.invalid'),
 ('10000000-0000-4000-8000-000000000002','hidden','Hidden channel','active',false,true,null,'private@example.invalid'),
 ('10000000-0000-4000-8000-000000000003','pending-only','Pending only','active',true,false,null,'private@example.invalid'),
 ('10000000-0000-4000-8000-000000000004','inactive','Inactive','inactive',true,true,null,'private@example.invalid');
 insert into public.bangsel_tasks select gen_random_uuid(),w.id,'Public fan','month','reward',2,case when i%3=0 then 2 else 0 end,
 '2026-01-01'::timestamptz+i*interval '1 minute','2026-01-02',case when i%2=0 then 'synthetic_donor_a' else 'synthetic_donor_b' end,E'Public comment\nsecond line','PRIVATE_MEMO_SENTINEL'
 from public.byeollog_workspaces w cross join generate_series(1,84)i;
 insert into public.bangsel_fans select id,'synthetic_donor_a','alias-match','current-match','PRIVATE_ALIAS_NOTE' from public.byeollog_workspaces;
 insert into public.byeollog_roulette_drafts select id,true,'Public roulette','{"balloonsPerSpin":33,"private":"PRIVATE_DRAFT_SENTINEL","items":[{"resultText":"A","probabilityPpm":500000,"private":"PRIVATE_ITEM_SENTINEL"},{"resultText":"B","probabilityPpm":500000}]}','2026-01-01' from public.byeollog_workspaces;
 `);
 await runtime.sql(await readFile(new URL('test/fixtures/public-read-baseline.sql',root),'utf8'));
 await runtime.sql('revoke execute on all functions in schema public from public,anon,authenticated;grant execute on all functions in schema public to service_role;');
 await runtime.sql(await readFile(new URL('supabase/migrations/20260920152951_public_read_least_privilege.sql',root),'utf8'));
 await runtime.sql(`insert into private.byeollog_public_read_keys(key_id,token_sha256) values('synthetic',encode(sha256(convert_to(${q(token)},'UTF8')),'hex'));`);
 for(const slug of ['visible','hidden','pending-only','inactive','absent']){
  for(const op of ['public-workspace','public-bangsel']){
   const args={p_workspace_slug:slug};
   const name=op==='public-workspace'?'get_public_workspace':'get_public_bangsel';
   const old=(await runtime.sql(`select coalesce(jsonb_agg(to_jsonb(r)),'[]') as value from public.${name}(${q(slug)}) r`)).rows[0].value;
   assert.deepEqual(await asAnon(call(op,args)),old);checks.push(op+': '+slug);
  }
  for(const view of [undefined,'pending','completed'])for(const sort of ['name','newest'])for(const page of [0,1])for(const search of [null,'alias-match']){
   const args={p_workspace_slug:slug,p_page:page,p_sort:sort,p_search:search,...(view?{p_view:view}:{})};
   const oldName=view?'byeollog_public_viewer_snapshot_v2':'byeollog_public_viewer_snapshot_v1';
   const params=[q(slug),search===null?'null':q(search),page,q(sort),...(view?[q(view)]:[])].join(',');
   const old=(await runtime.sql(`select public.${oldName}(${params}) as value`)).rows[0].value;
   const current=await asAnon(call('public-viewer',args));
   for(const item of old.pageData.items){delete item.id;delete item.created_at;delete item.identity}
   for(const item of current.pageData.items){assert.match(item.fan_key,/^[a-f0-9]{64}$/);delete item.fan_key}
   assert.deepEqual(current,old);checks.push('viewer: '+slug+'/'+view+'/'+sort+'/'+page+'/'+search);
  }
 }
 const pending=await asAnon(call('public-viewer',{p_workspace_slug:'visible'}));
 const legacy=await asAnon(call('public-upbo-page',{p_workspace_slug:'visible'}));
 assert.deepEqual(pending.pageData.items.map(x=>x.fan_key),legacy.items.map(x=>x.fan_key));
 assert.doesNotMatch(JSON.stringify(pending),/synthetic_donor|PRIVATE_|private@example|"identity"|"id"|"created_at"/);
 await runtime.sql(`insert into private.byeollog_public_read_keys(key_id,token_sha256) values('rotation',encode(sha256(convert_to(${q(bad)},'UTF8')),'hex'));`);
 assert.deepEqual(await asAnon(call('public-viewer',{p_workspace_slug:'visible'},bad)),pending);
 await runtime.sql("update private.byeollog_public_read_keys set enabled=false where key_id='rotation'");
 await deny(`set role anon;select ${call('public-workspace',{p_workspace_slug:'visible'},bad)}`);
 for(const op of ['data','backup','member','public-workspace;drop table auth.users'])await deny(`set role anon;select ${call(op,{p_workspace_slug:'visible'})}`);
 for(const args of [{p_workspace_slug:'visible',table:'auth.users'},{p_workspace_slug:'visible',p_page:2001},{p_workspace_slug:'visible',p_search:'x'.repeat(101)}])await deny(`set role anon;select ${call('public-viewer',args)}`);
 for(const sql of ['select memo from public.bangsel_tasks','select * from public.bangsel_tasks','select private_email from public.byeollog_workspaces','select email from auth.users','select email from public.byeollog_workspace_members',"update public.bangsel_tasks set done_qty=0",'delete from public.bangsel_tasks'])await deny('set role byeollog_public_reader;'+sql);
 for(const sql of ['select fan from public.bangsel_tasks','select * from private.byeollog_public_read_keys',"select * from byeollog_public_read.get_public_workspace('visible')","select * from public.get_public_workspace('visible')"])await deny('set role anon;'+sql);
 const roulette=await asAnon(call('public-roulette',{p_workspace_slug:'visible'}));assert.equal(roulette.length,1);assert.doesNotMatch(JSON.stringify(roulette),/PRIVATE_/);
 assert.deepEqual(await asAnon(call('public-roulette',{p_workspace_slug:'hidden'})),[]);
 assert.deepEqual(await asAnon(call('public-roulette',{p_workspace_slug:'inactive'})),[]);
 const role=(await runtime.sql("select rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb from pg_roles where rolname='byeollog_public_reader'")).rows[0];assert(Object.values(role).every(x=>x===false));
 await mkdir(new URL('output/public-read-20260921/',root),{recursive:true});
 await writeFile(new URL('output/public-read-20260921/postgres-verification.json',root),JSON.stringify({passed:true,comparisonAndDenialChecks:checks.length,role,checks},null,2));
 console.log(JSON.stringify({passed:true,comparisonAndDenialChecks:checks.length,role}));
}finally{await runtime.stop()}
