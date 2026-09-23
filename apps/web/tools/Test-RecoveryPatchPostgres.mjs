// Disposable PostgreSQL with current production schema metadata (no row data).
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
const json=async name=>JSON.parse(await readFile('../.tmp/'+name,'utf8'));
const schema=await json('recovery-schema.json'),deps=await json('recovery-dependencies.json'),indexes=await json('recovery-indexes.json'),core=(await json('recovery-core-schema.json')).table;
schema.tables.push({...core,constraints:core.constraints.filter(c=>c.kind!=='f')});
const q=s=>'"'+s.replaceAll('"','""')+'"',lit=s=>"'"+s.replaceAll("'","''")+"'";
const a='10000000-0000-4000-8000-000000000001',b='20000000-0000-4000-8000-000000000002',lease='30000000-0000-4000-8000-000000000003';
const id='40000000-0000-4000-8000-000000000004',sid='50000000-0000-4000-8000-000000000005',tid='60000000-0000-4000-8000-000000000006';
const rt=await isolatedSpecialPostgres(),sql=rt.sql;let assertions=0;
const check=async expression=>{const r=await sql('select '+expression+' as ok');assert.equal(r.rows[0].ok,true);assertions++};
const payload=()=>({byeollog_soop_core_donations:[{workspace_id:a,id,provider_event_id:'fixture-1',actor_id:'fixture',actor_name:'Fixture',amount:33,occurred_at:'2026-09-09T00:00:00Z',broadcast_key:'fixture-broadcast',status:'collecting',result_count:1,roulette_name:'Historic',expected_spins:2,roulette_enabled:false}],byeollog_wallpaper_sessions:[{workspace_id:a,id:sid,source_key:'fixture',label:'Fixture'}],byeollog_wallpaper_tiles:[{workspace_id:a,id:tid,sequence_no:77,session_id:sid,donation_event_id:id,actor_name:'Fixture',amount:33,asset_source:'none',asset:{},received_at:'2026-09-09T00:00:00Z'}]});
const call=p=>`select public.byeollog_restore_backup_v3('${a}','${lease}',${lit(JSON.stringify(p))}::jsonb);`;
const fails=async(p,code)=>{await assert.rejects(sql(call(p)),e=>e.code===code);assertions++};
try{
 await sql(`create role anon;create role authenticated;create role service_role bypassrls;create schema private;create schema extensions;create schema byeollog_automation;create function extensions.gen_random_uuid() returns uuid language sql as 'select pg_catalog.gen_random_uuid()';create table public.byeollog_workspaces(id uuid primary key,status text);create table public.byeollog_workspace_backup_leases(workspace_id uuid,lease_id uuid,reason text,expires_at timestamptz);insert into public.byeollog_workspaces values('${a}','active'),('${b}','active');insert into public.byeollog_workspace_backup_leases values('${a}','${lease}','pre_restore',now()+interval '30 minutes');`);
 for(const f of deps.functions)await sql(f);
 for(const t of schema.tables){const cols=t.columns.map(c=>q(c.name)+' '+c.type+(c.identity?' generated '+(c.identity==='a'?'always':'by default')+' as identity':c.default?' default '+c.default:'')+(c.notNull?' not null':''));cols.push(...t.constraints.map(c=>'constraint '+q(c.name)+' '+c.definition));await sql('create table public.'+q(t.name)+'('+cols.join(',')+')')}
 for(const i of indexes)await sql(i.definition);
 await sql('create unique index fixture_core_workspace_id on public.byeollog_soop_core_donations(workspace_id,id)');
 const names=new Set(schema.tables.map(t=>t.name));for(const f of deps.foreignKeys.filter(f=>names.has(f.table)))await sql('alter table public.'+q(f.table)+' add constraint '+q(f.name)+' '+f.definition);
 for(const f of schema.functions)await sql(f);
 await sql(`create function private.snapshot_soop_roulette_mapping_v2() returns trigger language plpgsql set search_path='' as $$ declare v_name text;v_spins integer;begin select mapping.enabled into new.roulette_enabled from public.byeollog_roulette_amount_mappings mapping where mapping.workspace_id=new.workspace_id and mapping.balloons=new.amount for share;new.roulette_enabled:=coalesce(new.roulette_enabled,true);if new.roulette_name is not null or new.expected_spins is not null then return new;end if;select mapping.roulette_name,mapping.expected_spins into v_name,v_spins from public.byeollog_roulette_amount_mappings mapping where mapping.workspace_id=new.workspace_id and mapping.balloons=new.amount;new.roulette_name:=nullif(btrim(v_name),'');new.expected_spins:=v_spins;return new;end $$;${core.triggers[0]};insert into public.byeollog_roulette_amount_mappings(workspace_id,balloons,roulette_name,expected_spins,enabled) values('${a}',33,'Current',7,true);grant usage on schema public,private to service_role;grant all on all tables in schema public to service_role;grant usage,select on all sequences in schema public to service_role;`);
 await sql(await readFile('supabase/migrations/20260909073436_backup_donation_recovery_and_sequence.sql','utf8'));
 await sql('set role service_role;'+call(payload()));
 await check(`(select status='expired' and result_count=1 and roulette_enabled=false and roulette_name='Historic' and expected_spins=2 from public.byeollog_soop_core_donations where id='${id}')`);
 await check(`(select sequence_no=77 from public.byeollog_wallpaper_tiles where id='${tid}')`);
 await check(`nextval(pg_get_serial_sequence('public.byeollog_wallpaper_tiles','sequence_no'))=78`);
 await check(`jsonb_array_length(public.byeollog_export_backup_v9('${a}')->'byeollog_soop_core_donations')=1`);
 await sql(`update public.byeollog_soop_core_donations set status='complete',result_count=5,roulette_enabled=true where id='${id}';select setval(pg_get_serial_sequence('public.byeollog_wallpaper_tiles','sequence_no'),900,true);`);
 await sql('set role service_role;'+call(payload()));
 await check(`(select status='complete' and result_count=5 and roulette_enabled from public.byeollog_soop_core_donations where id='${id}')`);
 await check(`nextval(pg_get_serial_sequence('public.byeollog_wallpaper_tiles','sequence_no'))=901`);
 const held=sql(`begin;set application_name='recovery_fixture_writer';lock table public.byeollog_wallpaper_tiles in row exclusive mode;select pg_sleep(2);commit`);
 try{
  for(let i=0;i<50;i++){const r=await sql("select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.application_name='recovery_fixture_writer' and l.relation='public.byeollog_wallpaper_tiles'::regclass and l.granted) as ready");if(r.rows[0].ready)break;await new Promise(r=>setTimeout(r,10));}
  const started=Date.now();await sql('set role service_role;'+call(payload()));assert.ok(Date.now()-started<1500,'Ordinary restore waited for an unrelated writer');assertions++;
 }finally{await held}
 const legacy=payload();delete legacy.byeollog_soop_core_donations;await sql('set role service_role;'+call(legacy));assertions++;
 await check(`(select count(*)=1 from public.byeollog_wallpaper_tiles)`);
 const bad=payload();bad.byeollog_soop_core_donations[0].workspace_id=b;await fails(bad,'42501');
 const altered=payload();altered.byeollog_soop_core_donations[0].amount=99;await fails(altered,'42501');
 const dup=payload();dup.byeollog_soop_core_donations.push({...dup.byeollog_soop_core_donations[0]});await fails(dup,'21000');
 const late=payload(),newId='70000000-0000-4000-8000-000000000007';late.byeollog_soop_core_donations[0].id=newId;late.byeollog_soop_core_donations[0].provider_event_id='fixture-new';late.byeollog_wallpaper_tiles[0].session_id=b;await fails(late,'42501');
 await check(`not exists(select 1 from public.byeollog_soop_core_donations where id='${newId}')`);
 await sql(`insert into public.byeollog_soop_core_donations(workspace_id,id,provider_event_id,actor_id,actor_name,amount,occurred_at,broadcast_key) values('${a}','${newId}','normal-ingestion','fixture','Fixture',33,now(),'live')`);
 await check(`(select status='pending' and roulette_enabled and roulette_name='Current' and expected_spins=7 from public.byeollog_soop_core_donations where id='${newId}')`);
 for(const role of ['anon','authenticated']){
  await assert.rejects(sql(`set role ${role};${call(payload())}`),e=>e.code==='42501');assertions++;
  await assert.rejects(sql(`set role ${role};select public.byeollog_export_backup_v9('${a}')`),e=>e.code==='42501');assertions++;
  await assert.rejects(sql(`set role ${role};select private.byeollog_repair_wallpaper_sequence_v1('${a}','${lease}')`),e=>e.code==='42501');assertions++;
 }
 await sql(`update public.byeollog_workspace_backup_leases set expires_at=now()-interval '1 second'`);await fails(payload(),'55000');
 await assert.rejects(sql(`set role service_role;select private.byeollog_repair_wallpaper_sequence_v1('${a}','${lease}')`),e=>e.code==='42501');assertions++;
 await check(`(select bool_and(not prosecdef) from pg_proc where proname in ('byeollog_restore_backup_v3','byeollog_export_backup_v9'))`);
 await writeFile('../output/operations-20260909/recovery-patch-postgres.json',JSON.stringify({passed:true,assertions,actualConstraints:true,normalIngestionPreserved:true,legacyRestorePreserved:true,sequenceNeverRegressed:true,restoredPendingHistoryExpired:true},null,2));console.log(JSON.stringify({passed:true,assertions}));
}finally{await rt.stop()}
