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
await db.exec(`create schema auth;create schema extensions;
 create function auth.uid() returns uuid language sql as $$select null::uuid$$;
 create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
 create function public.g3a_assert_active_auth_session_v1(uuid,uuid) returns boolean language sql as $$select false$$;
 create function extensions.digest(text,text) returns bytea language sql as $$select sha256(convert_to($1,'UTF8'))$$;
 create table public.byeollog_special_roulette_rules(workspace_id uuid,result_text text,enabled boolean,allow_stacking boolean);
 create unique index special_state_pk on private.special_roulette_state(workspace_id,broadcast_instance_id,actor_key);
 create unique index staging_scope_test on bangsel_collector_staging(workspace_id,source_scope,source_uid);
`);
await db.exec(migration('20261007225033_weflab_shadow_trial.sql'));
await db.exec(migration('20261007231117_weflab_optional_settings.sql'));
await db.exec(migration('20261011054734_upbo_collection_settings.sql'));
await db.exec(migration('20261011080403_overlay_upbo_authority.sql'));
await db.exec(migration('20261011083410_overlay_authority_diagnostics.sql'));
await db.exec(migration('20261011084655_overlay_context_identifier.sql'));

const secret='fixture-secret-'.repeat(4),cfg={owner:'fixture_owner',url:'https://weflab.com/page/FixturePage',idx:'providerIdx_abc123',preset:'0'};
const rule={amount:330,amountMax:330,spins:3};let seq=0;
const call=request=>q('select byeollog_upbo_collection_settings_v1($1,$2,$3) r',[a,u,request]).then(r=>r[0].r);
const rpc=request=>q('select byeollog_weflab_trial_rpc_v1($1,$2) r',[a,{serverSecret:secret,...request}]).then(r=>r[0].r);
const runtime=request=>q('select byeollog_overlay_runtime_v1($1,$2) r',[secret,request]).then(r=>r[0].r);
const set=enabled=>call({action:'settings_save',enabled,url:cfg.url,rules:[rule],overlayConfig:cfg});
await q("insert into byeollog_weflab_trial.production_control(singleton,server_secret_hash,enabled,activated_at) values(true,encode(extensions.digest($1,'sha256'),'hex'),true,clock_timestamp()-interval '5 seconds')",[secret]);
await set(true);
await q("update byeollog_weflab_trial.campaigns set production_since=clock_timestamp()-interval '5 seconds'");
await q("insert into byeollog_soop_gateway_sessions(workspace_id,broadcast_instance_id) values($1,'30000000-0000-4000-8000-000000000001')",[a]);

async function ingest({id='donor',name='후원자',offset=0,testEvent=false,replay=false}={}){
 const uid='fixture-'+(++seq),message={type:testEvent?'test_donation':'alert',platform:'afreeca',id:cfg.owner,
   data:{id,name,uid,value:330,time:Date.now()/1000+offset,subtype:'SENDBALLOON',replay}};
 const r=await rpc({action:'ingest',context:{type:'page',pageid:'alert',idx:cfg.idx,preset:'0',platform:{afreeca:{id:cfg.owner}}},rules:{},message});
 const rows=await q("select * from byeollog_weflab_trial.events where workspace_id=$1 and message->'data'->>'uid'=$2",[a,uid]);
 return {r,e:rows[0],message};
}
async function complete(event,values=['같은 결과','같은 결과','다른 결과'],api='sql'){
 const k=String(++seq).padStart(64,'a'),plan={workspaceId:a,owner:cfg.owner,uid:event.message.data.uid,test:false,count:values.length,key:k,requestHash:'b'.repeat(64),body:{value:'330'}};
 await rpc({action:'plan',eventKey:event.e.event_key,plan});
 await q("update byeollog_weflab_trial.jobs set due_at=clock_timestamp()-interval '1 second' where job_key=$1",[k]);
 const h=await rpc({action:'heartbeat',ready:true}),r=await rpc({action:'reserve',key:k,token:h.token});
 const response={raw:JSON.stringify({result:'success',api,list:values.map(v=>[v,'10'])}),assessment:{status:'stored_result_observed',api,results:values}};
 await rpc({action:'complete',key:k,attempt:r.attempt,response});
 return {k,response,attempt:r.attempt};
}
await test('overlay-only creates staging without any SOOP donation or chat; repeated results retain ordinals',async()=>{
 const item=await ingest(),done=await complete(item);
 assert.equal((await runtime({action:'publish'})).published,1);
 const [s]=await q('select * from bangsel_collector_staging where source_uid=$1',['overlay:'+done.k]);
 assert.equal(s.nickname,'후원자');assert.equal(s.soop_id,'donor');assert.equal(s.actual_spins,3);
 assert.deepEqual(s.roulette_results.map(x=>x.result),['같은 결과','같은 결과','다른 결과']);
 assert.equal(new Set(s.roulette_results.map(x=>x.receipt_identity)).size,3);
 assert.equal(s.event_name,new Intl.DateTimeFormat('en',{month:'numeric',timeZone:'Asia/Seoul'}).format(new Date())+'월 330개');
 assert.equal((await q('select count(*)::int n from bangsel_donations'))[0].n,0);
 assert.equal((await q('select count(*)::int n from byeollog_soop_core_donations'))[0].n,0);
 await rpc({action:'complete',key:done.k,attempt:done.attempt,response:done.response});
 assert.equal((await runtime({action:'publish'})).published,0);
 assert.equal((await q('select count(*)::int n from bangsel_collector_staging'))[0].n,1);
});
await test('chat is ignored in both public entrypoints even if it arrives before the overlay',async()=>{
 for(const query of [
  "select ingest_soop_external_roulette_result_v2($1,'chat','bot','bot',null,null,'reward','text',clock_timestamp(),'broadcast') r",
  "select ingest_soop_external_roulette_result_v4($1,'chat','bot','bot',null,null,'reward','text',clock_timestamp(),'broadcast','fixture_owner',1,repeat('a',64)) r"]){
  assert.equal((await q(query,[a]))[0].r.status,'overlay_authoritative');
 }
 assert.equal((await q('select count(*)::int n from byeollog_soop_core_roulette_results'))[0].n,0);
});
await test('OFF drains accepted jobs, stops fresh events, and retains donation-time custom name',async()=>{
 await call({action:'name_save',amount:330,amountMax:330,name:'사전 이름'});
 const item=await ingest();await call({action:'name_save',amount:330,amountMax:330,name:'나중 이름'});
 await set(false);assert.equal((await ingest()).r.status,'ignored');
 const done=await complete(item);assert.equal((await runtime({action:'publish'})).published,1);
 assert.equal((await q('select event_name from bangsel_collector_staging where source_uid=$1',['overlay:'+done.k]))[0].event_name,'사전 이름');
 await set(true);
});
await test('old, future, test, replay events and missing donor IDs never become production jobs',async()=>{
 for(const options of [{offset:-86400},{offset:100},{testEvent:true},{replay:true},{id:''}])assert.equal((await ingest(options)).e.production_eligible,false);
 const pending=await rpc({action:'pending_events'});assert.equal(pending.events.length,0);
});
await test('raw provider response is independently checked; claimed assessment cannot publish generated results',async()=>{
 const item=await ingest(),done=await complete(item,['bad'],'save');
 const result=await runtime({action:'publish'});assert.equal(result.needsReview,1);
 assert.equal((await q('select publish_error from byeollog_weflab_trial.jobs where job_key=$1',[done.k]))[0].publish_error,'overlay_response_unconfirmed');
 assert.equal((await q('select count(*)::int n from bangsel_collector_staging where source_uid=$1',['overlay:'+done.k]))[0].n,0);
});
await test('double reward is resolved once, per actor and broadcast, before classification',async()=>{
 await q("insert into byeollog_special_roulette_rules values($1,'두 배',true,true)",[a]);
 const done=await complete(await ingest({id:'multiplier-donor'}),['두 배','같은 결과','같은 결과']);
 assert.equal((await runtime({action:'publish'})).published,1);
 const [s]=await q('select roulette_results from bangsel_collector_staging where source_uid=$1',['overlay:'+done.k]);
 assert.deepEqual(s.roulette_results.map(x=>x.special_roulette.appliedMultiplier),[1,2,1]);
 assert.equal(s.roulette_results[0].special_roulette.controlEvent,true);
 assert.equal((await runtime({action:'publish'})).published,0);
});
await test('authorization, account mismatch and private storage access fail closed',async()=>{
 await assert.rejects(q('select byeollog_overlay_runtime_v1($1,$2)',['x'.repeat(64),{action:'discover'}]),e=>e.code==='42501');
 await assert.rejects(call({action:'settings_save',enabled:true,url:cfg.url,rules:[rule],overlayConfig:{...cfg,owner:'other'}}),e=>e.code==='22023');
 await db.exec('set role authenticated');
 await assert.rejects(q('select * from byeollog_weflab_trial.production_receipts'),e=>e.code==='42501');
 await assert.rejects(q('select private.publish_overlay_job_v1($1,$2)',[a,'x']),e=>e.code==='42501');
 await db.exec('reset role');
});
await test('late durable completion recovers a reservation warning without repeating the provider request',async()=>{
 const event=await ingest({id:'late-completion'}),done=await complete(event,['late reward']);
 await q("update byeollog_weflab_trial.events set production_state='needs_review' where workspace_id=$1 and event_key=$2",[a,event.e.event_key]);
 assert.equal((await runtime({action:'publish'})).published,1);
 assert.equal((await q('select count(*)::int n from bangsel_collector_staging where source_uid=$1',['overlay:'+done.k]))[0].n,1);
 assert.ok((await call({action:'get'})).needsReviewCount>=1);
});
await db.close();
