import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite(),q=async(s,p=[])=>(await db.query(s,p)).rows;
const migration=n=>fs.readFileSync(new URL('../../supabase/migrations/'+n,import.meta.url),'utf8');
let fixture=fs.readFileSync(new URL('./roulette-timeout-fixture.sql',import.meta.url),'utf8');
const v3=fixture.match(/create function public\.ingest_soop_external_roulette_result_v3[^\n]+/)[0];
await db.exec(fixture.replace(v3,''));
for(const r of JSON.parse(fs.readFileSync(new URL('./roulette-timeout-baseline.json',import.meta.url))))if(r.name!=='ingest_soop_external_roulette_result_v3')await db.exec(r.definition);
await db.exec(v3);
await db.exec(migration('20261002130846_roulette_wait_timeout.sql'));
await db.exec(migration('20261002132758_roulette_wait_legacy_deadline_guard.sql'));
await db.exec(`create unique index workspace_pk on byeollog_workspaces(id);
 create schema byeollog_weflab_trial;
 create table byeollog_weflab_trial.settings(workspace_id uuid primary key,url text,updated_at timestamptz);
 create table byeollog_weflab_trial.campaigns(workspace_id uuid primary key);
 create table byeollog_soop_runtime_controls(workspace_id uuid primary key);
 create function public.apply_roulette_amount_mapping_to_staging_v1() returns trigger language plpgsql as $$begin new.event_name:='legacy overwrite';return new;end$$;
 create trigger rename_old_mapping before insert or update on bangsel_collector_staging for each row execute function public.apply_roulette_amount_mapping_to_staging_v1();
`);
const a='10000000-0000-4000-8000-000000000001',b='10000000-0000-4000-8000-000000000002',u='20000000-0000-4000-8000-000000000001';
await q("insert into byeollog_workspaces(id,status,soop_id) values($1,'active','fixture_owner'),($2,'active','fixture_other')",[a,b]);
await q("insert into byeollog_workspace_members(workspace_id,user_id,role) values($1,$2,'owner')",[a,u]);
await q("insert into byeollog_roulette_amount_mappings(workspace_id,balloons,balloons_max,roulette_name,enabled,expected_spins) values($1,33,33,'old event',true,2)",[a]);
// Include the actual existing BEFORE trigger to verify ordering with the new snapshot.
const oldSnapshot=migration('20260923135049_support_soop_video_donations.sql').match(/CREATE OR REPLACE FUNCTION private\.snapshot_soop_roulette_mapping_v2\(\)[\s\S]*?\$function\$\s*;/)[0];
await db.exec(oldSnapshot);
await db.exec('create trigger snapshot_soop_roulette_mapping_v2 before insert on byeollog_soop_core_donations for each row execute function private.snapshot_soop_roulette_mapping_v2()');
await db.exec(migration('20261011054734_upbo_collection_settings.sql'));
const call=(request,workspace=a,user=u)=>q('select byeollog_upbo_collection_settings_v1($1,$2,$3) r',[workspace,user,request]).then(r=>r[0].r);
const rule={amount:330,amountMax:330,spins:2};
const set=enabled=>call({action:'settings_save',enabled,url:'https://weflab.com/page/FixturePage',rules:[rule]});
let sequence=0;
async function donate(amount=330,workspace=a){
 const id='fixture-'+(++sequence);
 const [r]=await q("insert into byeollog_soop_core_donations(workspace_id,provider_event_id,actor_id,actor_name,amount,donation_type_label,occurred_at,broadcast_key,status,result_count,roulette_enabled) values($1,$2,'donor','donor',$3,'별풍선',clock_timestamp(),'broadcast-a','pending',0,true) returning *",[workspace,id,amount]);
 await q("insert into bangsel_donations(workspace_id,source_event_key,balloons,roulette_results,raw_payload) values($1,$2,$3,'[]','{}')",[workspace,'soop_sdk:'+id,amount]);
 return r;
}
async function spin(){return (await q("select public.ingest_soop_external_roulette_result_v4($1,$2,'fixture_owner','fixture_owner',null,null,'reward','roulette result',clock_timestamp(),'broadcast-a','fixture_owner',10,repeat('a',64)) r",[a,'chat-'+(++sequence)]))[0].r;}
await test('URL is mandatory in database; authorization and invalid saves make no changes',async()=>{
 assert.equal((await call({action:'get'})).enabled,false);
 for(const url of ['', 'http://weflab.com/page/a','https://weflab.com.evil/page/a'])await assert.rejects(call({action:'settings_save',enabled:true,url,rules:[rule]}),e=>e.code==='22023');
 await assert.rejects(call({action:'get'},b),e=>e.code==='42501');
 assert.equal((await q('select count(*)::int n from byeollog_upbo_collection_settings'))[0].n,0);
 await db.exec('set role authenticated');
 await assert.rejects(call({action:'get'}),e=>e.code==='42501');await db.exec('reset role');
});
await test('ON without a manually registered roulette snapshots provider count; ordinary donations do not wait',async()=>{
 await set(true);const d=await donate();assert.equal(d.expected_spins,2);assert.equal(d.roulette_enabled,true);assert.equal(d.upbo_event_name,null);
 assert.equal((await donate(100)).status,'complete');
});
await test('OFF drains previously started two-spin donation and blocks new fixed and roulette work',async()=>{
 await set(false);const d=await donate();assert.equal(d.upbo_collection_enabled,false);assert.equal(d.status,'complete');
 await q("insert into bangsel_collector_staging(workspace_id,source_uid,event_name,roulette_results) values($1,$2,'fixed','[]')",[a,'soop_sdk:'+d.provider_event_id]);
 assert.equal((await q('select count(*)::int n from bangsel_collector_staging'))[0].n,0);
 const first=await spin();assert.equal(first.matched,true);assert.equal(first.resultCount,1);
 const second=await spin();assert.equal(second.resultCount,2);assert.equal(second.queueComplete,true);
 assert.equal((await spin()).status,'roulette_collection_disabled');
 const [row]=await q('select event_name from bangsel_collector_staging');
 assert.equal(row.event_name,new Intl.DateTimeFormat('en',{timeZone:'Asia/Seoul',month:'numeric'}).format(new Date())+'월 330개');
});
await test('custom names do not change count, preserve in-flight name and deletion restores defaults',async()=>{
 await set(true);await call({action:'name_save',amount:330,amountMax:330,name:'Autumn'});const d=await donate();
 assert.equal(d.expected_spins,2);assert.equal(d.upbo_event_name,'Autumn');
 await call({action:'name_save',amount:330,amountMax:330,name:'Winter'});assert.equal((await spin()).matched,true);
 assert.equal((await q('select event_name from bangsel_collector_staging where source_uid=$1',['soop_sdk:'+d.provider_event_id]))[0].event_name,'Autumn');
 await spin();await call({action:'name_delete',amount:330});assert.equal((await donate()).upbo_event_name,null);
 await assert.rejects(call({action:'name_save',amount:32,amountMax:34,name:'overlap'}),e=>e.code==='23P01');
});
await test('legacy Agent URL removal disables future collection without touching old snapshots',async()=>{
 await q("update byeollog_weflab_trial.settings set url='' where workspace_id=$1",[a]);assert.equal((await call({action:'get'})).enabled,false);
 assert.equal((await donate()).upbo_collection_enabled,false);
 assert.ok((await q('select count(*)::int n from byeollog_soop_core_donations where upbo_collection_enabled'))[0].n>0);
});
await test('configuration refresh is scoped; stale URL cannot overwrite a newer URL',async()=>{
 await set(true);
 await q('select byeollog_upbo_collection_runtime_v1($1,$2)',[a,{action:'refresh',url:'https://weflab.com/page/OldPage',rules:[]}]);
 assert.equal((await donate()).expected_spins,2);
 await q("update byeollog_upbo_collection_settings set rules_checked_at=clock_timestamp()-interval '3 minutes' where workspace_id=$1",[a]);
 const stale=await donate();assert.equal(stale.roulette_enabled,false);assert.equal(stale.upbo_collection_issue,'overlay_settings_unavailable');
 assert.ok((await call({action:'get'})).needsReviewCount>0);
 assert.equal((await donate(330,b)).upbo_collection_enabled,false);
});
await test('refresh reservation throttles failed and concurrent attempts across runtimes',async()=>{
 const runtime=request=>q('select byeollog_upbo_collection_runtime_v1($1,$2) r',[a,request]).then(r=>r[0].r);
 assert.equal((await runtime({action:'claim_refresh'})).refreshAllowed,true);
 assert.equal((await runtime({action:'claim_refresh'})).refreshAllowed,false);
 await q("update byeollog_upbo_collection_settings set rules_attempted_at=clock_timestamp()-interval '61 seconds' where workspace_id=$1",[a]);
 assert.equal((await runtime({action:'claim_refresh'})).refreshAllowed,true);
 await runtime({action:'refresh',url:'https://weflab.com/page/FixturePage',rules:[rule]});
 assert.equal((await runtime({action:'claim_refresh'})).refreshAllowed,false);
});
await test('unverified configuration blocks FIFO reassignment to a later donation',async()=>{
 await q("update byeollog_soop_core_donations set status='complete' where upbo_collection_issue is null");
 await set(true);const d=await donate();
 assert.equal((await spin()).status,'overlay_settings_unavailable');
 assert.equal((await q('select result_count from byeollog_soop_core_donations where id=$1',[d.id]))[0].result_count,0);
 assert.equal((await q("select count(*)::int n from byeollog_soop_core_roulette_results where match_method='overlay_settings_unavailable'"))[0].n,1);
});
await test('default name uses the first result month in Korea and stays fixed across midnight',async()=>{
 await q("update byeollog_soop_core_donations set status='complete',user_closed_at=clock_timestamp()");
 await set(true);const d=await donate();
 await q("update byeollog_soop_core_donations set occurred_at='2026-10-31T14:59:50Z' where id=$1",[d.id]);
 for(const at of ['2026-10-31T14:59:59Z','2026-10-31T15:00:01Z']){
   const [r]=await q("select ingest_soop_external_roulette_result_v2($1,$2,'fixture_owner','fixture_owner',null,null,'reward','roulette result',$3,'broadcast-a') r",[a,'month-'+(++sequence),at]);
   assert.equal(r.r.matched,true);
   assert.equal((await q('select event_name from bangsel_collector_staging where source_uid=$1',['soop_sdk:'+d.provider_event_id]))[0].event_name,'10월 330개');
 }
});
await db.close();
