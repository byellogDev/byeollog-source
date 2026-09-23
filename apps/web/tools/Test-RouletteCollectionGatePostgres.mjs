import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID,createHash} from 'node:crypto';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
const root=new URL('../',import.meta.url),a='10000000-0000-4000-8000-000000000001';
const read=name=>readFile(new URL(name,root),'utf8');
const q=s=>s==null?'null':"'"+String(s).replaceAll("'","''")+"'";
const rt=await isolatedSpecialPostgres(),sql=rt.sql,checks=[];
const check=async(label,query)=>{const r=(await sql(query)).rows[0];assert.equal(r.ok,true,label+': '+JSON.stringify(r));checks.push(label);};
try{
 await sql(await read('test/special-roulette-postgres-fixture.sql'));
 const core=await read('supabase/migrations/20260903190000_core_soop_collection_pivot.sql');
 for(const name of ['byeollog_soop_core_donations','byeollog_soop_core_roulette_results']){
  const start=core.indexOf('create table if not exists public.'+name+' (');await sql(core.slice(start,core.indexOf('\n);',start)+3));
 }
 await sql(`alter table public.byeollog_soop_core_donations add source_bj_id text,add source_chat_number bigint,add source_event_fingerprint text;
 alter table public.byeollog_soop_core_roulette_results add source_bj_id text,add source_chat_number bigint,add source_event_fingerprint text,add review_details jsonb,add review_status text default 'pending';
 alter table public.bangsel_donations add donated_at timestamptz,add soop_id text,add nickname text,add donation_type text;
 alter table public.bangsel_collector_staging add fixed_rewards jsonb default '[]';
 alter table public.byeollog_roulette_amount_mappings add balloons_max bigint,add enabled boolean default true;
 create table public.byeollog_workspace_members(workspace_id uuid,user_id uuid);
 create table public.byeollog_reverse_fan_days(id uuid,workspace_id uuid,starts_at timestamptz,ends_at timestamptz,rules jsonb,payments jsonb);
 alter table public.bangsel_fans add current_nickname text;`);
 await sql(await read('supabase/migrations/20260906054708_fifo_expected_spin_correlation_v2.sql'));
 await sql(await read('supabase/migrations/20260908101446_special_roulette_ingestion_receipts.sql'));
 await sql(`alter table public.byeollog_soop_core_donations add roulette_enabled boolean default true;`);
 // Existing approved batch uses positional receipts. Preserve its identity.
 const old=randomUUID();
 await sql(`insert into public.byeollog_soop_core_donations(id,workspace_id,provider_event_id,actor_id,actor_name,amount,occurred_at,broadcast_key,roulette_name,expected_spins) values('${old}','${a}','old','viewer','viewer',33,'2026-09-14T12:00:00Z','old','old',2);
 select public.ingest_soop_external_roulette_result_v2('${a}','old-result','fixture_a','fixture',null,null,'A','A','2026-09-14T12:00:01Z','old');`);
 await sql(await read('supabase/migrations/20260914141847_normalize_audited_product_contracts.sql'));
 const ownershipSql=await read('supabase/migrations/20260907013000_enforce_soop_workspace_ownership.sql');
 const start=ownershipSql.indexOf('create or replace function public.claim_soop_event_ownership_v1(');
 await sql(ownershipSql.slice(start,ownershipSql.indexOf('$function$;',start)+12));
 await sql(await read('supabase/migrations/20260919234804_roulette_collection_gate.sql'));
 await check('A06 historical receipt index preserved',`select receipt_identity='0' ok from public.byeollog_soop_core_roulette_results where provider_chat_id='old-result'`);
 const instance=randomUUID(),broadcast='soop-broadcast:'+instance;
 await sql(`insert into public.byeollog_soop_gateway_sessions values('${a}','${instance}',101,null);
 insert into public.byeollog_wallpaper_sessions(id,workspace_id,source_key) values('${instance}','${a}','${broadcast}');
 insert into public.byeollog_workspace_members values('${a}','${a}');
 insert into public.byeollog_roulette_amount_mappings(workspace_id,balloons,balloons_max,roulette_name,expected_spins) values('${a}',33,33,'configured',2);
 create trigger reapply_roulette_amount_mapping after insert or update of roulette_name on public.byeollog_roulette_amount_mappings for each row execute function public.reapply_roulette_amount_mapping_v1();
 create trigger apply_roulette_amount_mapping_to_staging before insert or update of balloons,roulette_results,event_name on public.bangsel_collector_staging for each row execute function public.apply_roulette_amount_mapping_to_staging_v1();`);
 const donation=async(key,amount=33,connection='connection-before')=>{
  const id=randomUUID(),fp=createHash('sha256').update(key).digest('hex');
  await sql(`insert into public.byeollog_soop_event_ownership values('${fp}','${a}','fixture_a',101);
   insert into public.byeollog_soop_core_donations(id,workspace_id,provider_event_id,actor_id,actor_name,amount,occurred_at,broadcast_key,source_bj_id,source_chat_number,source_event_fingerprint)
   values('${id}','${a}',${q(key)},'viewer','viewer',${amount},'2026-09-14T13:00:00Z',${q(connection)},'fixture_a',101,'${fp}');
   insert into public.byeollog_wallpaper_tiles(workspace_id,session_id,donation_event_id,actor_name,amount,received_at) values('${a}','${instance}','${id}','viewer',${amount},'2026-09-14T13:00:00Z');`);return id;
 };
 const result=async(key,{connection='connection-after',text='A',at='2026-09-14T13:00:01Z'}={})=>{
  const fp=createHash('sha256').update(key).digest('hex');
  
  return (await sql(`select public.ingest_soop_external_roulette_result_v4('${a}',${q(key)},'fixture_a','fixture',null,null,${q(text)},${q(text)},${q(at)},${q(connection)},'fixture_a',101,'${fp}') r`)).rows[0].r;
 };
 await donation('unconfigured',20);
 const no=await result('no-donation');assert.equal(no.matched,false);checks.push('A01 unconfigured donation stays unmatched');
 await check('A01 no invented event/staging',`select not exists(select 1 from public.bangsel_collector_staging where source_uid='soop_sdk:unconfigured') ok`);
 await check('A01 no mapping is inactive',`select not roulette_enabled and expected_spins is null ok from public.byeollog_soop_core_donations where provider_event_id='unconfigured'`);
 const configured=await donation('configured');
 const one=await result('first'),two=await result('second',{connection:'restarted-process',text:'B'});
 assert.equal(one.matchMethod,'fifo_expected_spins');assert.equal(two.queueComplete,true);checks.push('A09 connection restart keeps configured FIFO');
 await check('A06 new immutable receipt IDs',`select bool_and(receipt_identity like 'result:%') ok from public.byeollog_soop_core_roulette_results where donation_id='${configured}'`);
 const duplicate=await result('second',{connection:'another-restart',text:'B'});assert.equal(duplicate.duplicate,true);checks.push('A09 duplicate after restart is idempotent');
 await sql(`update public.byeollog_roulette_amount_mappings set roulette_name='changed' where workspace_id='${a}' and balloons=33`);
 await check('A05 historical snapshot preserved',`select event_name='configured' ok from public.bangsel_collector_staging where source_uid='soop_sdk:configured'`);
 const fixedPrefix='fixed:soop_sdk:configured|0|0|fixed|A',roulettePrefix='soop_sdk:configured|0|0|A';
 const group=keys=>`select public.byeollog_commit_upbo_group_v1('${a}',${q(JSON.stringify({fan:'viewer',soop_id:'viewer',event:'configured',type:'A',keys,receiptProtocol:2,added_date:'2026-09-14',source:'soop_chat_sdk_result',taskSource:'soop_chat_sdk_grouped'}))}::jsonb) r`;
 await sql(`insert into public.bangsel_tasks(workspace_id,fan,fan_soop_id,event,type,total_qty) values('${a}','viewer','viewer','configured','A',3)`);
 await sql(group([roulettePrefix,roulettePrefix+'|m2']));
 const voidSql=`select public.bangsel_void_roulette_ws('${a}','soop_sdk:configured','test') r`;
 const voided=(await sql(voidSql)).rows[0].r;assert.equal(voided.removed_links,2);checks.push('A02 removes exact SOOP contributions');
 await check('A02 manual quantity preserved',`select total_qty=3 and done_qty=0 ok from public.bangsel_tasks where event='configured'`);
 const twice=(await sql(voidSql)).rows[0].r;assert.equal(twice.already_voided,true);assert.equal(twice.removed_links,0);checks.push('A02 repeat void idempotent');
 await assert.rejects(()=>sql(group([roulettePrefix+'|m3'])),/무효 처리/);checks.push('A03/A04 atomic commit rejects voided sources');
 await check('A03 invalidation closes FIFO',`select status='expired' ok from public.byeollog_soop_core_donations where id='${configured}'`);
 assert.equal((await result('after-void')).matched,false);checks.push('A03 later result is exception');
 // Repair an already-invalidated historical source that still has receipts.
 await sql(`insert into public.bangsel_task_import_items(workspace_id,source_event_key,task_id,source) select '${a}',${q(roulettePrefix)},id,'soop_chat_sdk_result' from public.bangsel_tasks where event='configured';update public.bangsel_tasks set total_qty=4 where event='configured'`);
 const repair=(await sql(voidSql)).rows[0].r;assert.equal(repair.removed_links,1);checks.push('A02 previously voided residual contribution repair');
 // Completion protection is checked against the SOOP prefix under task locks.
 await donation('completed');await result('completed-first');await result('completed-second');
 const completedGroup=group(['soop_sdk:completed|0|0|A']);await sql(completedGroup);
 await sql(`update public.bangsel_tasks set done_qty=1 where event='configured'`);
 await assert.rejects(()=>sql(`select public.bangsel_void_roulette_ws('${a}','soop_sdk:completed','test')`),/완료 처리/);checks.push('A02 completed quantity blocks cancellation');
 await sql(`insert into public.byeollog_reverse_fan_days values('${instance}','${a}','2026-09-14Z','2026-09-15Z','[{"min":1,"max":100,"rateBp":1000}]','{}');
 insert into public.bangsel_donations(workspace_id,source_event_key,balloons,donated_at,soop_id,nickname,donation_type) values
 ('${a}','sys',100,'2026-09-14T12:00:00Z','__challenge_settle__','system','도전성공'),
 ('${a}','real1',33,'2026-09-14T12:00:00Z','viewer','viewer','별풍선'),('${a}','real2',33,'2026-09-14T12:00:01Z','viewer','viewer','별풍선');`);
 await check('A07 system settlement excluded; per donation floor retained',`select count(*)=1 and max(refund)=6 ok from public.byeollog_reverse_fan_rows_v1('${a}','${instance}')`);
 await sql(`update public.byeollog_roulette_amount_mappings set enabled=false where workspace_id='${a}'`);
 await donation('disabled');assert.equal((await result('disabled-result')).matched,false);checks.push('A01 disabled future donation not eligible');
 // Configuration changes apply only to later donations. Special multiplier
 // decisions still consume exactly once across a gateway restart.
 await sql(`update public.byeollog_roulette_amount_mappings set enabled=true where workspace_id='${a}';
 insert into public.byeollog_special_roulette_rules(workspace_id,result_text) values('${a}','double');`);
 const special=await donation('special');
 await result('double-control',{text:'double'});
 await result('double-reward',{text:'A',connection:'special-restart'});
 await check('special multiplier survives reconnect once',`select special_roulette->>'appliedMultiplier'='2' ok from public.byeollog_soop_core_roulette_results where provider_chat_id='double-reward'`);
 await check('special pending consumed',`select not exists(select 1 from private.special_roulette_state where workspace_id='${a}') ok`);
 const active=await donation('before-disable');await sql(`update public.byeollog_roulette_amount_mappings set enabled=false where workspace_id='${a}'`);
 assert.equal((await result('still-first')).matched,true);assert.equal((await result('still-second')).queueComplete,true);checks.push('activation snapshot survives later disable');

 const ignored=await result('after-drain');assert.equal(ignored.status,'roulette_collection_disabled');checks.push('last pending result stops further collection');
 await check('disabled result has no ownership or result row',`select not exists(select 1 from public.byeollog_soop_core_roulette_results where provider_chat_id='after-drain') and not exists(select 1 from public.byeollog_soop_event_ownership where event_fingerprint='${createHash('sha256').update('after-drain').digest('hex')}') ok`);
 await check('disabled future donation remains untouched',`select not roulette_enabled and result_count=0 from public.byeollog_soop_core_donations where provider_event_id='disabled'`.replace('select not','select not').replace(' from',' ok from'));
 const duplicateAfterDisable=await result('still-second');assert.equal(duplicateAfterDisable.status,'roulette_collection_disabled');checks.push('old receipt replay after disable does not reopen processing');
 // Cancel the source of an unconsumed multiplier only.
 await sql(`update public.byeollog_roulette_amount_mappings set enabled=true where workspace_id='${a}'`);
 await donation('pending-special');await result('pending-double',{text:'double'});
 await sql(`select public.bangsel_void_roulette_ws('${a}','soop_sdk:pending-special','test')`);
 await check('void clears only its pending multiplier',`select not exists(select 1 from private.special_roulette_state where source_event_key='soop_result:pending-double') ok`);
 // Two independent transactions race a receipt commit and invalidation.
 // Both orders must leave no contribution of the invalidated source.
 for(const order of ['commit-first','void-first']){
  const uid='soop_sdk:race-'+order;
  await sql(`insert into public.bangsel_collector_staging(workspace_id,source_uid) values('${a}',${q(uid)})`);
  const commit=group([uid+'|0|0|race']).replaceAll('"type":"A"','"type":"race"'),cancel=`select public.bangsel_void_roulette_ws('${a}',${q(uid)},'test')`;
  const first=sql(`begin;select pg_advisory_xact_lock(hashtextextended('byeollog:roulette-write:${a}',0));${order==='commit-first'?commit:cancel};select pg_sleep(0.2);commit;`);
  await new Promise(resolve=>setTimeout(resolve,50));
  const second=sql(order==='commit-first'?cancel:commit);
  const settled=await Promise.allSettled([first,second]);assert.equal(settled[0].status,'fulfilled');
  if(order==='void-first')assert.equal(settled[1].status,'rejected');else assert.equal(settled[1].status,'fulfilled');
  await check('concurrent '+order+' leaves no invalid contribution',`select not exists(select 1 from public.bangsel_task_import_items where workspace_id='${a}' and starts_with(source_event_key,${q(uid+'|')})) ok`);
 }
 await assert.rejects(()=>sql(group(['soop_sdk:special|0|0|A']).replace('"receiptProtocol":2','"receiptProtocol":1')),/업데이트 후 재시도/);checks.push('old in-flight processor cannot create positional keys for new receipts');

 // Finish/expire only synthetic pending data before independent gate scenarios.
 await sql(`update public.byeollog_soop_core_donations set status='expired' where status in ('pending','collecting');update public.byeollog_roulette_amount_mappings set enabled=true where workspace_id='${a}'`);
 await donation('last-spin-race');await result('race-prior-spin');
 await sql(`update public.byeollog_roulette_amount_mappings set enabled=false where workspace_id='${a}'`);
 const raced=await Promise.all([result('race-last-1'),result('race-last-2')]);
 assert.equal(raced.filter(x=>x.matched===true).length,1);assert.equal(raced.filter(x=>x.status==='roulette_collection_disabled').length,1);checks.push('concurrent final spin creates exactly one result, no extra exception');
 await check('concurrent last spin claims one event only',`select count(*)=1 ok from public.byeollog_soop_core_roulette_results where provider_chat_id in ('race-last-1','race-last-2')`);
 await sql(`update public.byeollog_roulette_amount_mappings set enabled=true where workspace_id='${a}'`);await donation('old-broadcast-pending');
 await sql(`update public.byeollog_roulette_amount_mappings set enabled=false where workspace_id='${a}';update public.byeollog_soop_gateway_sessions set broadcast_instance_id=gen_random_uuid() where workspace_id='${a}'`);
 assert.equal((await result('different-broadcast-result')).status,'roulette_collection_disabled');checks.push('previous broadcast pending cannot keep collection enabled');
 await sql(`update public.byeollog_soop_gateway_sessions set broadcast_instance_id='${instance}' where workspace_id='${a}'`);
 assert.equal((await result('stale-head-result',{at:'2026-09-14T13:11:00Z'})).status,'roulette_collection_disabled');checks.push('existing ten-minute FIFO expiry does not create an endless inactive exception feed');
 await check('expired eligibility does not rewrite historical pending',`select status='pending' and result_count=0 ok from public.byeollog_soop_core_donations where provider_event_id='old-broadcast-pending'`);
 await sql(`update public.byeollog_soop_core_donations set status='expired' where provider_event_id='old-broadcast-pending';delete from public.byeollog_roulette_amount_mappings where workspace_id='${a}'`);
 assert.equal((await result('zero-mappings')).status,'roulette_collection_disabled');checks.push('zero mappings plus special classification alone stays disabled');
 await sql(`insert into public.byeollog_roulette_amount_mappings(workspace_id,balloons,balloons_max,roulette_name,expected_spins,enabled) values('${a}',33,33,'reactivated',2,true)`);
 assert.equal((await result('enabled-unmatched')).matched,false);
 await check('active roulette still routes missing donation to exception',`select match_state='unmatched' ok from public.byeollog_soop_core_roulette_results where provider_chat_id='enabled-unmatched'`);
 const signature='public.ingest_soop_external_roulette_result_v4(uuid,text,text,text,text,text,text,text,timestamptz,text,text,bigint,text)';
 await check('only service role can execute new gate',`select has_function_privilege('service_role','${signature}','execute') and not has_function_privilege('anon','${signature}','execute') and not has_function_privilege('authenticated','${signature}','execute') ok`);
 await assert.rejects(()=>sql(`select public.ingest_soop_external_roulette_result_v4('${a}','foreign','fixture_a','fixture',null,null,'A','A',now(),'foreign','fixture_b',101,repeat('f',64))`),/owner does not match/);checks.push('gate retains broadcaster ownership checks');
 await sql(await read('supabase/migrations/20260919234804_roulette_collection_gate.sql'));checks.push('migration reapplication safe');
 await writeFile(new URL('../output/roulette-gate-20260920/database-tests.json',import.meta.url),JSON.stringify({checks,productionMutated:false},null,2));
 console.log(JSON.stringify({passed:checks.length,checks}));
}finally{await rt.stop();}
