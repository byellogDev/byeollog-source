import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
const rt=await isolatedSpecialPostgres(),sql=rt.sql;let checks=0;
const a='10000000-0000-4000-8000-000000000001',b='20000000-0000-4000-8000-000000000002',u='30000000-0000-4000-8000-000000000003',viewer='30000000-0000-4000-8000-000000000004',cid='40000000-0000-4000-8000-000000000004';
const lit=s=>"'"+String(s).replaceAll("'","''")+"'";
const call=async(action,p={},ws=a,user=u)=>{const r=await sql(`set role service_role;select public.byeollog_reverse_fan_day_v1('${ws}','${user}',${lit(action)},${lit(JSON.stringify(p))}::jsonb) as result;reset role;`);return r[1].rows[0].result};
const fail=async(action,p,code,ws=a,user=u)=>{await assert.rejects(call(action,p,ws,user),e=>e.code===code);await sql('reset role');checks++};
try{
 await sql(`create role anon;create role authenticated;create role service_role bypassrls;create table public.byeollog_workspaces(id uuid primary key,status text);create table public.byeollog_workspace_members(workspace_id uuid,user_id uuid,role text);create table public.bangsel_donations(workspace_id uuid,source_event_key text,soop_id text,nickname text,balloons integer,donated_at timestamptz,donation_type text,primary key(workspace_id,source_event_key));insert into public.byeollog_workspaces values('${a}','active'),('${b}','active');insert into public.byeollog_workspace_members values('${a}','${u}','owner'),('${a}','${viewer}','viewer');grant usage on schema public to service_role;grant all on all tables in schema public to service_role;`);
 const full=await readFile('supabase/migrations/20260909202534_reverse_fan_day_private_calculator.sql','utf8');await sql(full.split('-- Include private settlement records')[0]);
 const c={id:cid,name:'Fixture',startsAt:'2026-09-10T12:00:00+09:00',endsAt:'2026-09-10T14:00:00+09:00',rules:[{min:33,max:100,rateBp:1000},{min:101,max:200,rateBp:1250}]};
 await call('create',c);checks++;
 const add=async(key,amount,fan='alice',at='2026-09-10T04:00:00Z',ws=a,type='별풍선')=>sql(`insert into public.bangsel_donations values('${ws}',${lit(key)},${lit(fan)},${lit(fan==='alice'?'Alice changed':'Bob')},${amount},${lit(at)},${lit(type)});`);
 await add('a',33);await add('b',33);await add('max',100);await add('outside',201);await add('range2',101,'bob');await add('start',33,'alice','2026-09-10T03:00:00Z');await add('end',100,'alice','2026-09-10T05:00:00Z');await add('foreign',100,'alice','2026-09-10T04:00:00Z',b);await add('sub',100,'alice','2026-09-10T04:00:00Z',a,'구독');
 let d=await call('get',{id:cid});assert.equal(d.summary.refund,31);assert.equal(d.summary.balloons,300);assert.equal(d.items.find(r=>r.fan_id==='alice').refund,19);assert.equal(d.items.find(r=>r.fan_id==='bob').refund,12);checks+=4;
 await fail('get',{id:cid},'42501',b);await fail('pay',{id:cid,revision:1,fanId:'alice',expectedRefund:19,expectedPaid:0},'42501',a,viewer);
 await call('pay',{id:cid,revision:1,fanId:'alice',expectedRefund:19,expectedPaid:0});checks++;
 await fail('pay',{id:cid,revision:1,fanId:'alice',expectedRefund:19,expectedPaid:0},'PT409');
 d=await call('get',{id:cid});assert.equal(d.summary.paid,19);assert.equal(d.summary.due,12);checks+=2;
 await fail('save',{...c,revision:2},'PT422');await fail('delete',{id:cid,revision:2},'PT422');
 await add('late',33);d=await call('get',{id:cid});assert.equal(d.items.find(r=>r.fan_id==='alice').due,3);assert.equal(d.summary.paid,19);checks+=2;
 await fail('pay',{id:cid,revision:2,fanId:'alice',expectedRefund:19,expectedPaid:19},'PT409');
 await call('pay',{id:cid,revision:2,fanId:'alice',expectedRefund:22,expectedPaid:19});d=await call('get',{id:cid});assert.equal(d.summary.paid,22);checks++;
 await call('undo',{id:cid,revision:3,fanId:'alice',expectedRefund:22,expectedPaid:22});d=await call('get',{id:cid});assert.equal(d.summary.paid,0);checks++;
 await fail('save',{...c,revision:4,rules:[{min:1,max:100,rateBp:1000},{min:100,max:200,rateBp:1000}]},'22023');
 for(const role of ['anon','authenticated']){for(const stmt of [`select * from public.byeollog_reverse_fan_days`,`select public.byeollog_reverse_fan_day_v1('${a}','${u}','get','{}')`,`select * from public.byeollog_reverse_fan_rows_v1('${a}','${cid}')`]){await assert.rejects(sql(`set role ${role};${stmt}`),e=>e.code==='42501');await sql('reset role');checks++}}
 // More than one API page must not truncate the aggregate.
 await sql(`insert into public.bangsel_donations select '${a}','page-'||g,'fan-'||g,'Fan '||g,100,'2026-09-10T04:00:00Z','별풍선' from generate_series(1,73) g;`);d=await call('get',{id:cid,page:1});assert.equal(d.totalRows,75);assert.equal(d.items.length,25);assert.equal(d.summary.refund,764);checks+=3;
 const filtered=await call('get',{id:cid,search:'bob'});assert.equal(filtered.items.length,1);assert.equal(filtered.summary.refund,764);checks+=2;
 const roles=await sql("select bool_and(not prosecdef) as ok from pg_proc where proname like 'byeollog_reverse_fan%'");assert.equal(roles.rows[0].ok,true);checks++;
 console.log(JSON.stringify({passed:true,checks}));await writeFile('../.tmp/reverse-fan-day-postgres.json',JSON.stringify({passed:true,checks})+'\n');
}finally{await rt.stop()}
