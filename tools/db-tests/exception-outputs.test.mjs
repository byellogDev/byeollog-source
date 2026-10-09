import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { rouletteExceptionsRequest } from '../../apps/admin-runtime/lib/roulette-exceptions.js';

const db = new PGlite();
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const migration = name => fs.readFileSync(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8');
await db.exec(`
create role anon; create role authenticated; create role service_role;
create table byeollog_workspaces(id uuid primary key,status text);
create table byeollog_workspace_members(workspace_id uuid,user_id uuid,role text);
create table bangsel_fans(workspace_id uuid,soop_id text,alias text,current_nickname text,primary key(workspace_id,soop_id));
create table bangsel_tasks(id uuid primary key default gen_random_uuid(),workspace_id uuid,fan text,fan_soop_id text,event text,type text,
  total_qty integer check(total_qty>0),done_qty integer check(done_qty>=0 and done_qty<=total_qty),memo text,added_date date,source text,source_event_key text unique);
create table bangsel_task_import_items(workspace_id uuid,source_event_key text,task_id uuid references bangsel_tasks(id),source text,primary key(workspace_id,source_event_key));
create table byeollog_soop_core_roulette_results(id uuid primary key,workspace_id uuid,match_state text default 'unmatched',donation_id uuid,
  result_text text,occurred_at timestamptz default now(),review_status text default 'pending',review_details jsonb default '{}',reviewed_at timestamptz,reviewed_by uuid);
create table bangsel_collector_staging(workspace_id uuid,source_uid text,roulette_results jsonb);
create table bangsel_roulette_invalidations(workspace_id uuid,source_uid text);
create table bangsel_roulette_rules(workspace_id uuid,result_text text,action text);
create table byeollog_roulette_exception_reviews(workspace_id uuid,result_id uuid,user_id uuid,action text,previous_status text,previous_details jsonb);
grant usage on schema public to service_role; grant all on all tables in schema public to service_role;
`);
const helper = migration('20260919232936_incident_business_conflict_no_retry.sql');
await db.exec(helper.slice(helper.indexOf('CREATE OR REPLACE FUNCTION public.byeollog_commit_upbo_group_v1'), helper.indexOf('CREATE OR REPLACE FUNCTION public.clear_wallpaper_layout_v1')));
await db.exec('revoke all on function public.byeollog_commit_upbo_group_v1(uuid,jsonb) from public,anon,authenticated;grant execute on function public.byeollog_commit_upbo_group_v1(uuid,jsonb) to service_role;');
await db.exec(migration('20260908162704_roulette_exception_invoker_membership_fix.sql'));
await db.exec(migration('20260909023008_exception_undo_source_identity.sql'));
const ws = randomUUID(), other = randomUUID(), user = randomUUID();
await q("insert into byeollog_workspaces values($1,'active'),($2,'active')", [ws, other]);
await q("insert into byeollog_workspace_members values($1,$2,'owner')", [ws, user]);
await q("insert into bangsel_fans values($1,'fixture_donor','Fixture','Fixture')", [ws]);
const decision = (type = 'A & B', quantity = 1, extra = {}) => ({action:'registered',soopId:'fixture_donor',event:'fixture',type,quantity,...extra});
async function fresh(details = {}) {
  const id = randomUUID();
  await q("insert into byeollog_soop_core_roulette_results(id,workspace_id,result_text,review_details) values($1,$2,'fixture result',$3)", [id,ws,details]);
  return id;
}
async function call(id, body, workspace = ws, authorized = user) {
  return (await q('select public.resolve_soop_roulette_exception_v2($1,$2,$3,$4) result', [workspace,authorized,id,body]))[0].result;
}
const undo = id => call(id,{action:'undo'});
const tasks = () => q('select type,total_qty,done_qty from bangsel_tasks order by type');
const clear = () => db.exec('truncate bangsel_task_import_items,bangsel_tasks,byeollog_soop_core_roulette_results,byeollog_roulette_exception_reviews,bangsel_roulette_rules');
const bad = (promise, code) => assert.rejects(promise, e => e.code === code);
let legacy;
await test('old exception path reproduces combined task and saves its legacy receipt', async () => {
  legacy = await fresh(); await call(legacy,decision());
  assert.deepEqual(await tasks(),[{type:'A & B',total_qty:1,done_qty:0}]);
});
await db.exec(migration('20261009141000_exception_ampersand_outputs.sql'));
await test('migration preserves old records and legacy undo still works', async () => {
  assert.deepEqual(await tasks(),[{type:'A & B',total_qty:1,done_qty:0}]);
  assert.equal((await undo(legacy)).status,'pending'); assert.deepEqual(await tasks(),[]);
});
await test('existing API passes A & B to the patched RPC and creates both quantities', async () => {
  await clear(); const id=await fresh({fifoHead:{reason:'fixture'}});
  const result=await rouletteExceptionsRequest({workspaceId:ws,userId:user,method:'POST',body:{id,...decision('A 단컷 & 움짤',2)},sb:async(route,query,{body})=>{
    assert.equal(route,'rpc/resolve_soop_roulette_exception_v2');
    return call(body.p_result_id,body.p_decision,body.p_workspace_id,body.p_authorized_user_id);
  }});
  assert.equal(result.status,200);
  assert.deepEqual(await tasks(),[{type:'A 단컷',total_qty:2,done_qty:0},{type:'움짤',total_qty:2,done_qty:0}]);
  assert.equal(result.body.details.outputs.length,2);
  await undo(id); assert.deepEqual(await tasks(),[]);
  assert.deepEqual((await q('select review_details from byeollog_soop_core_roulette_results where id=$1',[id]))[0].review_details,{fifoHead:{reason:'fixture'}});
});
await test('duplicate registration and undo are idempotent; changed decisions conflict', async () => {
  await clear();const id=await fresh();await call(id,decision());
  assert.equal((await call(id,decision())).duplicate,true);
  await bad(call(id,decision('A & C')),'PT409');
  assert.equal((await q('select count(*)::int n from bangsel_task_import_items'))[0].n,2);
  assert.equal((await q('select count(*)::int n from byeollog_roulette_exception_reviews'))[0].n,1);
  await undo(id);assert.equal((await undo(id)).duplicate,true);
  await call(id,decision());assert.equal((await tasks()).length,2);
});
await test('whitespace and empty segments are ignored; repeated types preserve multiplicity', async () => {
  await clear();const id=await fresh();await call(id,decision(' & A && B & A & ',2));
  assert.deepEqual(await tasks(),[{type:'A',total_qty:4,done_qty:0},{type:'B',total_qty:2,done_qty:0}]);
  await undo(id);assert.deepEqual(await tasks(),[]);
});
await test('single output still works and blank/over-limit output requests write nothing', async () => {
  await clear();const id=await fresh();const result=await call(id,decision('A'));
  assert.ok(result.details.receipt.taskId);await undo(id);
  for(const [type,qty] of [['&& &',1],[Array(21).fill('A').join('&'),1],[Array(11).fill('A').join('&'),1000]]){
    await bad(call(id,decision(type,qty)),'22023');assert.deepEqual(await tasks(),[]);
  }
  await call(id,decision(Array(20).fill('A').join('&'),1));assert.equal((await tasks())[0].total_qty,20);
});
await test('late-output ledger conflict rolls back earlier output, fan creation and audit', async () => {
  await clear();const id=await fresh();
  await q("insert into bangsel_task_import_items values($1,$2,null,'fixture')",[ws,`soop-exception:${id}:output:2:1`]);
  await bad(call(id,decision('A & Z',1,{createFan:true,soopId:'new_fixture',fanName:'New fixture'})),'PT409');
  assert.deepEqual(await tasks(),[]);
  assert.equal((await q("select count(*)::int n from bangsel_fans where soop_id='new_fixture'"))[0].n,0);
  assert.equal((await q('select count(*)::int n from byeollog_roulette_exception_reviews'))[0].n,0);
  assert.equal((await q('select review_status from byeollog_soop_core_roulette_results where id=$1',[id]))[0].review_status,'pending');
});
await test('undo conflict in a later task rolls back all earlier removals', async () => {
  await clear();const id=await fresh();await call(id,decision('A & Z'));
  await q("update bangsel_tasks set done_qty=1 where type='Z'");await bad(undo(id),'PT409');
  assert.equal((await tasks()).length,2);
  assert.equal((await q('select count(*)::int n from bangsel_task_import_items'))[0].n,2);
  await q("update bangsel_tasks set done_qty=0,type='edited' where type='Z'");await bad(undo(id),'PT409');
  assert.equal((await tasks()).length,2);
});
await test('merged contributions survive undo and release their creation key for re-registration', async () => {
  await clear();const a=await fresh(),b=await fresh();await call(a,decision('A & B'));await call(b,decision('B & A',2));
  await undo(a);assert.deepEqual(await tasks(),[{type:'A',total_qty:2,done_qty:0},{type:'B',total_qty:2,done_qty:0}]);
  await q('update bangsel_tasks set done_qty=total_qty');await call(a,decision());
  assert.equal((await tasks()).length,4);await undo(a);assert.equal((await tasks()).length,2);
});
await test('exclusions and late non-upbo rules retain existing behavior', async () => {
  await clear();const a=await fresh();await call(a,{action:'excluded'});await undo(a);
  await q("insert into bangsel_roulette_rules values($1,'fixture result','exclude')",[ws]);
  assert.equal((await call(a,decision())).status,'auto_excluded');await bad(undo(a),'PT409');assert.deepEqual(await tasks(),[]);
});
await test('workspace membership and assigned-result guards cannot be bypassed', async () => {
  await clear();const id=await fresh();await bad(call(id,decision(),other),'42501');await bad(call(id,decision(),ws,randomUUID()),'42501');
  await q("insert into byeollog_workspace_members values($1,$2,'owner')",[other,user]);await bad(call(id,decision(),other),'PT404');
  await q("update byeollog_soop_core_roulette_results set match_state='matched' where id=$1",[id]);await bad(call(id,decision()),'PT404');assert.deepEqual(await tasks(),[]);
});
await test('RPCs stay invoker-only and service-role-only, and service role can execute', async () => {
  for(const name of ['resolve_soop_roulette_exception_v1','resolve_soop_roulette_exception_v2']){
    assert.equal((await q('select prosecdef from pg_proc where proname=$1',[name]))[0].prosecdef,false);
    for(const role of ['anon','authenticated'])assert.equal((await q('select has_function_privilege($1,$2,\'execute\') ok',[role,`public.${name}(uuid,uuid,uuid,jsonb)`]))[0].ok,false);
  }
  await clear();const id=await fresh();await db.exec('set role service_role');
  try {assert.equal((await call(id,decision())).status,'registered');await undo(id);}finally{await db.exec('reset role');}
});
await db.close();
