// Real PostgreSQL, disposable fixtures only. No production URL, key, volume or port.
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

const runtime=await isolatedSpecialPostgres();
const sql=runtime.sql;
const a='10000000-0000-4000-8000-000000000001';
const b='20000000-0000-4000-8000-000000000002';
const lease='30000000-0000-4000-8000-000000000003';
const task='40000000-0000-4000-8000-000000000004';
const session='50000000-0000-4000-8000-000000000005';
const tile='60000000-0000-4000-8000-000000000006';
const donation='70000000-0000-4000-8000-000000000007';
const payload=()=>({
  bangsel_fans:[{workspace_id:a,soop_id:'fixture',alias:'fixture'}],
  bangsel_tasks:[{workspace_id:a,id:task,fan_soop_id:'fixture',total_qty:3,done_qty:1}],
  bangsel_task_import_items:[{workspace_id:a,source_event_key:'event',task_id:task}],
  bangsel_collector_staging:[{workspace_id:a,source_scope:'soop',source_uid:'source',process_status:'processed'}],
  bangsel_roulette_invalidations:[{workspace_id:a,source_uid:'source',reason:'invalid'}],
  byeollog_workspace_settings:[{workspace_id:a,public_page_enabled:true}],
  byeollog_signature_balloons:[{workspace_id:a,id:donation,balloon_count:33,pc_image:{storagePath:'fixture.webp'}}],
  byeollog_fixed_upbo_rules:[{workspace_id:a,balloons:33,event_name:'fixture',upbo_type:'roulette'}],
  byeollog_roulette_amount_mappings:[{workspace_id:a,balloons:33,roulette_name:'fixture'}],
  byeollog_wallpaper_sessions:[{workspace_id:a,id:session,source_key:'fixture',label:'fixture'}],
  byeollog_wallpaper_tiles:[{workspace_id:a,id:tile,sequence_no:77,session_id:session,donation_event_id:donation,actor_name:'fixture',amount:33,asset_source:'signature',asset:{storagePath:'fixture.webp'},received_at:'2026-09-06T00:00:00Z'}],
  byeollog_wallpaper_overlay_states:[{workspace_id:a,revision:1}]
});
const quoted=value=>"'"+JSON.stringify(value).replaceAll("'","''")+"'";
const call=(p,l=lease)=>`select public.byeollog_restore_backup_v2('${a}','${l}',${quoted(p)}::jsonb);`;
const assertSql=async condition=>await sql(`do $$ begin assert (${condition}); end $$;`);
async function fails(p,code){await sql(`do $$ begin begin ${call(p)} raise exception 'expected failure'; exception when sqlstate '${code}' then null; end; end $$;`);}

try{
  await sql(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create table public.byeollog_workspaces(id uuid primary key,status text);
    insert into public.byeollog_workspaces values ('${a}','active'),('${b}','active');
    create table public.byeollog_workspace_backup_leases(workspace_id uuid,lease_id uuid,reason text,expires_at timestamptz);
    insert into public.byeollog_workspace_backup_leases values('${a}','${lease}','pre_restore',now()+interval '30 minutes');

    create table public.bangsel_fans(workspace_id uuid,soop_id text,alias text not null check(length(alias)>0),primary key(workspace_id,soop_id));
    create table public.bangsel_fan_stations(workspace_id uuid,fan text,station_url text default '',primary key(workspace_id,fan));
    create table public.bangsel_roulette_rules(workspace_id uuid,result_text text,action text default 'review',primary key(workspace_id,result_text));
    create table public.bangsel_tasks(id uuid primary key,workspace_id uuid not null,fan_soop_id text,total_qty int not null default 1,done_qty int not null default 0,public_comment text not null default '',foreign key(workspace_id,fan_soop_id) references public.bangsel_fans(workspace_id,soop_id),check(done_qty>=0 and done_qty<=total_qty));
    create table public.bangsel_donations(workspace_id uuid,source_event_key text,balloons int check(balloons>0),primary key(workspace_id,source_event_key));
    create table public.bangsel_task_import_items(workspace_id uuid,source_event_key text,task_id uuid references public.bangsel_tasks(id),primary key(workspace_id,source_event_key));
    create table public.bangsel_collector_staging(workspace_id uuid,source_scope text default 'soop',source_uid text,process_status text default 'pending',primary key(workspace_id,source_scope,source_uid),unique(workspace_id,source_uid));
    create table public.bangsel_roulette_invalidations(workspace_id uuid,source_uid text,reason text,primary key(workspace_id,source_uid),foreign key(workspace_id,source_uid) references public.bangsel_collector_staging(workspace_id,source_uid));

    create table public.byeollog_workspace_settings(workspace_id uuid primary key,public_page_enabled boolean default true);
    create table public.byeollog_signature_balloons(id uuid primary key,workspace_id uuid,balloon_count int,pc_image jsonb,unique(workspace_id,balloon_count),unique(workspace_id,id));
    create table public.byeollog_default_donation_images(id uuid primary key,workspace_id uuid,unique(workspace_id,id));
    create table public.byeollog_fixed_upbo_rules(workspace_id uuid,balloons bigint,event_name text,upbo_type text,primary key(workspace_id,balloons,event_name,upbo_type));
    create table public.byeollog_roulette_classification_rules(workspace_id uuid,roulette_name text,result_text text,action text default 'review',primary key(workspace_id,roulette_name,result_text));
    create table public.byeollog_roulette_amount_mappings(workspace_id uuid,balloons bigint,roulette_name text,primary key(workspace_id,balloons));
    create table public.byeollog_wallpaper_sessions(id uuid primary key,workspace_id uuid,source_key text not null,label text not null,started_at timestamptz default now(),unique(id,workspace_id));
    create table public.byeollog_wallpaper_tiles(id uuid primary key,sequence_no bigint generated always as identity,workspace_id uuid,session_id uuid references public.byeollog_wallpaper_sessions(id),donation_event_id uuid,actor_name text,amount bigint,asset_source text,asset jsonb,received_at timestamptz,unique(session_id,sequence_no),unique(workspace_id,donation_event_id));
    create table public.byeollog_wallpaper_user_settings(workspace_id uuid,user_id uuid,merge_ranges jsonb default '[]',primary key(workspace_id,user_id));
    create table public.byeollog_wallpaper_overlay_states(workspace_id uuid primary key,revision bigint default 0);
    grant usage on schema public to service_role;
    grant all on all tables in schema public to service_role;
  `);

  await sql(await readFile(new URL('../supabase/migrations/20260906033249_expand_consistent_product_backup_v8.sql',import.meta.url),'utf8'));
  await sql(`set role service_role; ${call(payload())}`);
  await assertSql(`select total_qty=3 and done_qty=1 and public_comment='' from public.bangsel_tasks where id='${task}'`);
  await assertSql(`select sequence_no=77 from public.byeollog_wallpaper_tiles where id='${tile}'`);
  await assertSql(`select jsonb_array_length(public.byeollog_export_backup_v8('${a}')->'byeollog_wallpaper_tiles')=1`);
  await sql(call(payload()));
  await assertSql('select count(*)=1 from public.bangsel_tasks');

  const late=payload();late.bangsel_tasks[0].total_qty=9;late.bangsel_donations=[{workspace_id:a,source_event_key:'bad',balloons:-1}];
  await fails(late,'23514');await assertSql(`select total_qty=3 from public.bangsel_tasks where id='${task}'`);
  const badInvalidation=payload();badInvalidation.bangsel_roulette_invalidations=[{workspace_id:a,source_uid:'missing',reason:'invalid'}];badInvalidation.bangsel_tasks[0].total_qty=8;
  await fails(badInvalidation,'42501');await assertSql(`select total_qty=3 from public.bangsel_tasks where id='${task}'`);
  const badTile=payload();badTile.byeollog_wallpaper_tiles[0].session_id=b;await fails(badTile,'42501');
  const foreign=payload();foreign.bangsel_fans[0].workspace_id=b;await fails(foreign,'42501');
  await sql(`insert into public.bangsel_tasks(id,workspace_id) values ('${b}','${b}');`);
  const collision=payload();collision.bangsel_tasks[0].id=b;await fails(collision,'42501');await assertSql(`select workspace_id='${b}' from public.bangsel_tasks where id='${b}'`);
  const reference=payload();reference.bangsel_task_import_items[0].task_id=b;await fails(reference,'42501');
  const unknown=payload();unknown.bangsel_tasks[0].future_column='x';await fails(unknown,'22023');
  const duplicate=payload();duplicate.bangsel_tasks.push({...duplicate.bangsel_tasks[0]});await fails(duplicate,'21000');

  for(const role of ['anon','authenticated']){
    await sql(`do $$ begin begin set local role ${role}; perform public.byeollog_export_backup_v8('${a}'); raise exception 'forbidden export accepted'; exception when insufficient_privilege then null; end; end $$;`);
    await sql(`do $$ begin begin set local role ${role}; ${call(payload())} raise exception 'forbidden restore accepted'; exception when insufficient_privilege then null; end; end $$;`);
  }
  await sql(`update public.byeollog_workspace_backup_leases set expires_at=now()-interval '1 second';`);await fails(payload(),'55000');
  await assertSql(`select count(*)=2 and bool_and(not prosecdef) from pg_proc where proname in ('byeollog_export_backup_v8','byeollog_restore_backup_v2')`);
  console.log('PASS: one-snapshot v8 export; 18-table fresh restore; identity preservation; idempotency; late rollback; staging/invalidation and wallpaper ownership; foreign workspace/UUID/reference rejection; unknown/duplicate rejection; service-only invoker.');
}finally{
  await runtime.stop();
}
