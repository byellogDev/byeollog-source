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

 await sql("create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint';create schema storage;create table storage.objects(bucket_id text,name text)");
 await sql(await readFile('supabase/migrations/20260909081228_wallpaper_seven_day_retention.sql','utf8'));
 await sql(await readFile('supabase/migrations/20260909082102_wallpaper_retention_distinct_workspace.sql','utf8'));
 await sql(call(payload()));
 await sql(`update public.byeollog_wallpaper_tiles set received_at=now()-interval '8 days';update public.byeollog_wallpaper_sessions set tile_count=1,state='closed',closed_at=now()-interval '8 days',started_at=now()-interval '9 days';insert into public.byeollog_wallpaper_overlay_states(workspace_id,revision) values('${a}',10);`);
 const r=await sql('select private.run_wallpaper_retention_v1(500) as result');assert.equal(r.rows[0].result.tilesDeleted,1);assert.equal(r.rows[0].result.sessionsDeleted,1);assertions+=2;
 await check(`(select count(*)=0 from public.byeollog_wallpaper_tiles)`);
 await check(`(select count(*)=1 from public.byeollog_soop_core_donations)`);
 await check(`(select revision=11 from public.byeollog_wallpaper_overlay_states where workspace_id='${a}')`);
 await sql(call(payload()));await sql(`update public.byeollog_wallpaper_tiles set received_at=now()-interval '6 days';update public.byeollog_wallpaper_sessions set tile_count=1`);
 await check(`(private.run_wallpaper_retention_v1(500)->>'tilesDeleted')::int=0`);
 await check(`(select count(*)=1 from public.byeollog_wallpaper_tiles)`);
 await sql(`update public.byeollog_wallpaper_tiles set received_at=now()-interval '8 days'`);
 await check(`(private.run_wallpaper_retention_v1(500)->>'tilesDeleted')::int=1`);
 await check(`(select tile_count=0 and state='active' from public.byeollog_wallpaper_sessions where id='${sid}')`);
 await check(`(private.run_wallpaper_retention_v1(500)->>'tilesDeleted')::int=0`);
 for(const role of ['anon','authenticated','service_role']){await assert.rejects(sql(`set role ${role};select private.run_wallpaper_retention_v1(500)`),e=>e.code==='42501');assertions++;}
 await assert.rejects(sql('select private.run_wallpaper_retention_v1(0)'),e=>e.code==='22023');assertions++;
 await writeFile('../output/operations-20260909/wallpaper-retention-postgres.json',JSON.stringify({passed:true,assertions,donationsPreserved:true,activeSessionPreserved:true,overlayRevisionUpdated:true},null,2));console.log(JSON.stringify({passed:true,assertions}));
}finally{await rt.stop()}
