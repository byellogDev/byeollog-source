import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
const rt=await isolatedSpecialPostgres(),sql=rt.sql;let checks=0;
const token='a'.repeat(64),lit=s=>"'"+String(s).replaceAll("'","''")+"'";
const publish=(value,t=token,role='anon')=>sql(`set role ${role}; select public.byeollog_ops_publish_snapshot_v1(${lit(t)},${lit(JSON.stringify(value))}::jsonb) as data;`);
const read=async()=>{const r=await sql('set role service_role;select public.byeollog_ops_read_snapshot_v1() as data;');return r[1].rows[0].data};
try{
 await sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema private;create schema extensions;create extension pgcrypto with schema extensions;create table private.ops_monitor_v1(singleton boolean primary key,token_sha256 text,last_seen_at timestamptz,usage jsonb,usage_at timestamptz);insert into private.ops_monitor_v1 values(true,encode(extensions.digest('${token}','sha256'),'hex'),'2026-01-01Z','{"databaseBytes":123}',now());`);
 await sql(await readFile('supabase/migrations/20260910073913_discord_ops_snapshot.sql','utf8'));
 assert.equal((await read()).snapshot,null);checks++;
 const data={at:new Date().toISOString(),sample:{pending:7,cpuPercent:12.5,healthAt:new Date().toISOString(),container:'running:healthy',password:'DO_NOT_STORE',lastDeliveryAt:'not-a-date',memoryPending:-1,diskPercent:'42'},bad:['disk','DO_NOT_STORE'],names:['DO_NOT_STORE']};
 for(const badToken of ['','b'.repeat(64),'x'.repeat(65)]){await assert.rejects(publish(data,badToken),e=>e.code==='42501');checks++}
 for(const at of [null,'infinity',new Date(Date.now()-700000).toISOString(),new Date(Date.now()+61000).toISOString()]){await assert.rejects(publish({...data,at}),e=>e.code==='22023');checks++}
 await assert.rejects(publish({...data,names:['a'.repeat(30000)]}),e=>e.code==='22023');checks++;
 await publish(data);const result=await read();assert.equal(result.snapshot.payload.sample.pending,7);assert.equal(result.snapshot.payload.sample.cpuPercent,12.5);assert.deepEqual(result.snapshot.payload.bad,['disk']);assert.equal(result.snapshot.payload.sample.memoryPending,undefined);assert.equal(result.snapshot.payload.sample.diskPercent,undefined);assert.equal(result.snapshot.payload.sample.lastDeliveryAt,undefined);assert.ok(!JSON.stringify(result).includes('DO_NOT_STORE'));checks+=7;
 await publish({...data,sample:{pending:88}});assert.equal((await read()).snapshot.payload.sample.pending,7);checks++;
 for(const role of ['anon','authenticated']){await assert.rejects(sql(`set role ${role};select public.byeollog_ops_read_snapshot_v1()`),e=>e.code==='42501');checks++}
 for(const role of ['anon','authenticated','service_role']){await assert.rejects(sql(`set role ${role};select * from private.ops_discord_snapshot_v1`),e=>e.code==='42501');checks++}
 await assert.rejects(publish(data,token,'authenticated'),e=>e.code==='42501');checks++;
 assert.equal((await sql("select last_seen_at='2026-01-01Z'::timestamptz as same from private.ops_monitor_v1")).rows[0].same,true);checks++;
 await sql("update private.ops_discord_snapshot_v1 set received_at=now()-interval '46 seconds'");await publish({...data,sample:{pending:88}});assert.equal((await read()).snapshot.payload.sample.pending,88);checks++;
 const acl=await sql("select bool_and(prosecdef and proconfig @> array['search_path=\"\"']) as hardened from pg_proc where proname in ('byeollog_ops_publish_snapshot_v1','byeollog_ops_read_snapshot_v1')");assert.equal(acl.rows[0].hardened,true);checks++;
 await writeFile('../.tmp/discord-ops-postgres.json',JSON.stringify({passed:true,checks})+'\n');console.log(JSON.stringify({passed:true,checks}));
}finally{await rt.stop()}
