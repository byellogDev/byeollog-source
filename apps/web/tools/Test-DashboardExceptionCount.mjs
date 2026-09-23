import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
const db=await isolatedSpecialPostgres(),a='10000000-0000-4000-8000-000000000001',b='20000000-0000-4000-8000-000000000002',u='30000000-0000-4000-8000-000000000003';
let checks=0;
const count=async()=>{const result=await db.sql(`select byeollog_dashboard_counts_v1('${a}','${u}') as value`);return result.rows[0].value};
try{
 await db.sql(`create role anon;create role authenticated;create role service_role bypassrls;
 create table byeollog_workspaces(id uuid,status text);
 create table byeollog_workspace_members(workspace_id uuid,user_id uuid);
 create table bangsel_collector_staging(workspace_id uuid,process_status text);
 create table byeollog_soop_core_donations(workspace_id uuid,status text,expected_spins integer,result_count integer);
 create table byeollog_soop_core_roulette_results(workspace_id uuid,match_state text,review_status text);
 insert into byeollog_workspaces values('${a}','active'),('${b}','active');
 insert into byeollog_workspace_members values('${a}','${u}');
 insert into bangsel_collector_staging values('${a}','pending'),('${a}','ignored'),('${b}','failed');
 insert into byeollog_soop_core_donations values('${a}','collecting',2,1),('${a}','pending',1,1),('${b}','pending',1,0);
 insert into byeollog_soop_core_roulette_results values('${a}','unmatched','pending'),('${a}','ambiguous','pending'),('${a}','matched','pending'),('${a}','unmatched','excluded'),('${a}','unmatched','registered'),('${a}','unmatched','auto_excluded'),('${b}','unmatched','pending');`);
 await db.sql(await fs.readFile(new URL('../supabase/migrations/20260912215910_dashboard_exception_count.sql',import.meta.url),'utf8'));
 const result=await count();assert.equal(result.exceptionCount,2);checks++;assert.equal(result.reviewCount,1);checks++;assert.equal(result.pendingCount,1);checks++;assert.ok(Number.isFinite(Date.parse(result.checkedAt)));checks++;
 await db.sql(`update byeollog_soop_core_roulette_results set review_status='excluded' where workspace_id='${a}' and match_state='unmatched' and review_status='pending'`);
 assert.equal((await count()).exceptionCount,1);checks++;
 await db.sql(`update byeollog_soop_core_roulette_results set review_status='registered' where workspace_id='${a}' and match_state='ambiguous'`);
 assert.equal((await count()).exceptionCount,0);checks++;
 await db.sql(`update byeollog_soop_core_roulette_results set review_status='pending' where workspace_id='${a}' and match_state='ambiguous'`);
 assert.equal((await count()).exceptionCount,1);checks++;
 await assert.rejects(db.sql(`select byeollog_dashboard_counts_v1('${b}','${u}')`),e=>e.code==='42501');checks++;
 for(const role of ['anon','authenticated']){await assert.rejects(db.sql(`set role ${role};select byeollog_dashboard_counts_v1('${a}','${u}')`),e=>e.code==='42501');checks++}
 await db.sql('set role service_role');assert.equal((await count()).exceptionCount,1);checks++;
 await db.sql(`reset role;update byeollog_workspaces set status='inactive' where id='${a}'`);
 await assert.rejects(count(),e=>e.code==='42501');checks++;
 console.log(JSON.stringify({ok:true,checks}));
}finally{await db.stop()}
