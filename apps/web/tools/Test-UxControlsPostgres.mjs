// Actual PostgreSQL and production migration functions, synthetic data only.
// Default: disposable Docker with no network/volume/port. Windows fallback:
// --native-bin <isolated PostgreSQL bin> --pg-module <pg/lib/index.js>
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {isolatedSpecialPostgres} from '../test/helpers/special-postgres-runtime.mjs';

const a='10000000-0000-4000-8000-000000000001';
const b='20000000-0000-4000-8000-000000000002';
const lease='30000000-0000-4000-8000-000000000003';
const migration='20260908101446_special_roulette_ingestion_receipts.sql';
const q=value=>value===null?'null':"'"+String(value).replaceAll("'","''")+"'";
const fingerprint=(workspace,key)=>createHash('sha256').update(workspace+':'+key).digest('hex');
const broadcaster=workspace=>workspace===a?'fixture_a':'fixture_b';
const room=workspace=>workspace===a?101:202;
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const functionSql=(source,name)=>{const start=source.indexOf('create or replace function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('$function$;',start)+12);};
const runtime=await isolatedSpecialPostgres();
const sql=runtime.sql;
let checks=0;
const check=async(condition,label)=>{
  await sql(`do $$ begin if not coalesce((${condition}),false) then raise exception '${label.replaceAll("'","''")}'; end if; end $$;`);checks++;
};
const fails=async(statement,code)=>{await sql(`do $$ begin begin set local role service_role; ${statement.trim().replace(/;$/," ")}; raise exception 'expected SQL rejection'; exception when sqlstate '${code}' then if sqlerrm='expected SQL rejection' then raise; end if; end; end $$;`);checks++;};
const round=async(workspace=a)=>{
  const id=randomUUID();
  await sql(`insert into public.byeollog_soop_gateway_sessions(workspace_id,broadcast_instance_id,last_live_chat_number) values (${q(workspace)},${q(id)},${room(workspace)}) on conflict(workspace_id) do update set broadcast_instance_id=excluded.broadcast_instance_id,last_live_chat_number=excluded.last_live_chat_number,broadcast_offline_since=null;
    insert into public.byeollog_wallpaper_sessions(id,workspace_id,source_key) values (${q(id)},${q(workspace)},${q('soop-broadcast:'+id)});`);
  return {workspace,instance:id,connection:'fixture-connection:'+id};
};
const donation=async(context,{key=randomUUID(),actor='fixture-donor',spins=1,when='2026-09-08T00:00:00Z',provenance=true}={})=>{
  const id=randomUUID(),{workspace,instance,connection}=context;
  await sql(`select public.claim_soop_event_ownership_v1(${q(workspace)},${q(fingerprint(workspace,key))},${q(broadcaster(workspace))},${room(workspace)});
    insert into public.byeollog_soop_core_donations(id,workspace_id,provider_event_id,actor_id,actor_name,amount,occurred_at,broadcast_key,roulette_name,expected_spins,source_bj_id,source_chat_number,source_event_fingerprint)
    values(${q(id)},${q(workspace)},${q(key)},${q(actor)},'fixture donor',33,${q(when)},${q(connection)},'fixture-wheel',${spins===null?'null':spins},${provenance?q(broadcaster(workspace)):'null'},${provenance?room(workspace):'null'},${provenance?q(fingerprint(workspace,key)):'null'});
    insert into public.bangsel_donations(workspace_id,source_event_key,balloons) values(${q(workspace)},${q('soop_sdk:'+key)},33);
    insert into public.byeollog_wallpaper_tiles(workspace_id,session_id,donation_event_id,actor_name,amount,received_at) values(${q(workspace)},${q(instance)},${q(id)},'fixture donor',33,${q(when)});`);
  return {...context,key,id,when};
};
const eventSql=(context,key,result,{when='2026-09-08T00:00:05Z',roulette='fixture-wheel',owner=true,workspace=context.workspace,connection=context.connection,bj=broadcaster(workspace),chat=room(workspace)}={})=>{
  return `${owner?`perform public.claim_soop_event_ownership_v1(${q(workspace)},${q(fingerprint(workspace,key))},${q(bj)},${chat});`:''}
    perform public.ingest_soop_external_roulette_result_v3(${q(workspace)},${q(key)},'fixture-bot','fixture bot',null,${q(roulette)},${q(result)},'fixture message',${q(when)},${q(connection)},${q(bj)},${chat},${q(fingerprint(workspace,key))});`;
};
const ingest=async(context,key,result,options={})=>sql(`do $$ begin ${eventSql(context,key,result,options)} end $$;`);
const decision=(workspace,key)=>`(select special_roulette from public.byeollog_soop_core_roulette_results where workspace_id=${q(workspace)} and provider_chat_id=${q(key)})`;
const multiplier=(context,key,value)=>check(`${decision(context.workspace,key)}->>'appliedMultiplier'=${q(value)}`,`multiplier ${value}`);
try{
  await sql(await readFile(new URL('../test/special-roulette-postgres-fixture.sql',import.meta.url),'utf8'));
  const core=await read('20260903190000_core_soop_collection_pivot.sql');
  for(const name of ['byeollog_soop_core_donations','byeollog_soop_core_roulette_results']){
    const start=core.indexOf('create table if not exists public.'+name+' (');
    await sql(core.slice(start,core.indexOf('\n);',start)+3));
  }
  await sql(`alter table public.byeollog_soop_core_donations add column source_bj_id text,add column source_chat_number bigint,add column source_event_fingerprint text;
    alter table public.byeollog_soop_core_roulette_results add column source_bj_id text,add column source_chat_number bigint,add column source_event_fingerprint text;
    create unique index fixture_donation_owner_idx on public.byeollog_soop_core_donations(workspace_id,id);
    alter table public.byeollog_soop_core_roulette_results add foreign key(workspace_id,donation_id) references public.byeollog_soop_core_donations(workspace_id,id);`);
  const ownership=await read('20260907013000_enforce_soop_workspace_ownership.sql');
  await sql(functionSql(ownership,'public.claim_soop_event_ownership_v1'));
  await sql(await read('20260906054708_fifo_expected_spin_correlation_v2.sql'));


  await sql(await read(migration));
  await sql(await read('20260908112310_roulette_mapping_activation.sql'));
  const atomic=await read('20260906014845_atomic_upbo_and_bounded_retry.sql');
  await sql(atomic.slice(atomic.indexOf('create or replace function public.byeollog_commit_upbo_group_v1'),atomic.indexOf('create or replace function public.byeollog_claim_upbo_retries_v1')));
  await sql("create schema byeollog_automation; create table public.byeollog_workspace_members(workspace_id uuid,user_id uuid,role text); alter table public.bangsel_fans add column current_nickname text;");
  const user='40000000-0000-4000-8000-000000000004';
  await sql("create function byeollog_automation.assert_native_roulette_member_v1(p_workspace_id uuid,p_authorized_user_id uuid,p_write boolean) returns text language plpgsql security definer set search_path='' as $$ declare v_role text; begin if p_workspace_id is null or p_authorized_user_id is null or p_write is null then raise exception 'authorization invalid' using errcode='28000'; end if; select lower(btrim(member.role::text)) into v_role from public.byeollog_workspace_members member join public.byeollog_workspaces workspace on workspace.id=member.workspace_id where member.workspace_id=p_workspace_id and member.user_id=p_authorized_user_id and workspace.status='active'; if v_role is null or (p_write and v_role not in ('owner','editor','manager')) then raise exception 'authorization failed' using errcode='42501'; end if; return v_role; end $$;");
  await sql('revoke all on schema byeollog_automation from public, anon, authenticated, service_role; revoke all on function byeollog_automation.assert_native_roulette_member_v1(uuid,uuid,boolean) from public, anon, authenticated, service_role;');
  await sql('insert into public.byeollog_workspace_members values('+q(a)+','+q(user)+",'owner'); insert into public.bangsel_fans(workspace_id,soop_id,alias) values("+q(a)+",'alice','Alice'),("+q(b)+",'bob','Bob'); insert into public.bangsel_roulette_rules values("+q(a)+",'nothing','exclude');");
  const history=await round();await ingest(history,'history-non-upbo','nothing');
  await sql(await read('20260908125923_roulette_exception_review.sql'));
  await check("select review_status='auto_excluded' and raw_message='fixture message' from public.byeollog_soop_core_roulette_results where provider_chat_id='history-non-upbo'",'historical non-upbo excluded with original retained');
  const review=(key)=>'(select review_status from public.byeollog_soop_core_roulette_results where workspace_id='+q(a)+' and provider_chat_id='+q(key)+')';
  const context=await round();
  await ingest(context,'empty-reward','reward');await ingest(context,'empty-nothing','nothing');await ingest(context,'empty-unknown','unknown');
  await check(review('empty-reward')+"='pending'",'reward pending without FIFO');
  await check(review('empty-nothing')+"='auto_excluded'",'known non-upbo automatically excluded');
  await check(review('empty-unknown')+"='pending'",'unknown is never automatically discarded');
  await check('select count(*)=0 from public.bangsel_tasks','unmatched never creates automatic reward');
  const call=(key,decision={action:'registered',soopId:'alice',event:'September',type:'dance',quantity:3},workspace=a,actor=user)=>'select public.resolve_soop_roulette_exception_v1('+q(workspace)+','+q(actor)+',(select id from public.byeollog_soop_core_roulette_results where workspace_id='+q(a)+' and provider_chat_id='+q(key)+'),'+q(JSON.stringify(decision))+'::jsonb);';
  await sql('grant all on all tables in schema public to service_role;');
  await fails("set local role service_role; "+call('empty-reward'),'42501');
  await sql(await read('20260908162546_roulette_exception_invoker_membership_fix.sql'));
  await check("not has_schema_privilege('service_role','byeollog_automation','usage')",'private schema remains inaccessible');
  await check("not has_function_privilege('service_role','byeollog_automation.assert_native_roulette_member_v1(uuid,uuid,boolean)','execute')",'private helper remains inaccessible');
  await sql('set role service_role; '+call('empty-reward'));
  await sql('set role service_role; '+call('empty-reward'));await check('select total_qty=3 and added_date=\'2026-09-08\' from public.bangsel_tasks','atomic idempotent quantity and KST date');
  await check(review('empty-reward')+"='registered'",'review committed');
  await fails(call('empty-reward',{action:'excluded'}),'PT409');
  await sql('set role service_role; '+call('empty-unknown',{action:'excluded'}));await check(review('empty-unknown')+"='excluded'",'manual exclusion');
  await fails(call('empty-nothing'),'PT409');
  await fails(call('empty-nothing',undefined,b),'42501');
  await fails(call('empty-nothing',undefined,a,null),'28000');
  for(const role of ['viewer','editor','manager']){
    await sql('update public.byeollog_workspace_members set role='+q(role)+' where workspace_id='+q(a)+' and user_id='+q(user));
    await fails(call('empty-nothing',undefined,a),role==='viewer'?'42501':'PT409');
  }
  await sql("update public.byeollog_workspace_members set role='owner' where workspace_id="+q(a));
  await sql("update public.byeollog_workspaces set status='inactive' where id="+q(a));
  await fails(call('empty-nothing'),'42501');
  await sql("update public.byeollog_workspaces set status='active' where id="+q(a));
  await fails('set local role anon; '+call('empty-nothing'),'42501');
  await fails('set local role authenticated; '+call('empty-nothing'),'42501');
  await ingest(context,'parallel','reward');
  await Promise.all(Array.from({length:12},()=>sql('set role service_role; '+call('parallel'))));
  await check('select total_qty=6 from public.bangsel_tasks','12 parallel duplicate decisions add once');
  await check('select count(*)=6 from public.bangsel_task_import_items','ledger exact quantity');
  await ingest(context,'rollback','reward');
  await sql("create function public.fixture_fail_task() returns trigger language plpgsql as $$ begin if current_setting('fixture.fail',true)='yes' then raise exception 'injected failure'; end if; return new; end $$; create trigger fixture_fail_task before update on public.bangsel_tasks for each row execute function public.fixture_fail_task();");
  await fails("set local fixture.fail='yes'; "+call('rollback'),'P0001');
  await check(review('rollback')+"='pending'",'failed task transaction preserves pending decision');
  await check('select count(*)=6 from public.bangsel_task_import_items','failed task rolls ledger back');
  await sql('set role service_role; '+call('rollback'));await check('select total_qty=9 from public.bangsel_tasks','retry after rollback adds once');
  await ingest(context,'invalid-fan','reward');
  await fails(call('invalid-fan',{action:'registered',soopId:'bob',event:'x',type:'x',quantity:1}),'PT404');
  await fails(call('invalid-fan',{action:'registered',soopId:'alice',event:'x',type:'x',quantity:0}),'22023');
  await fails(call('invalid-fan',{action:'registered',soopId:'alice',event:'x',type:'x',quantity:1.5}),'22023');
  await sql('insert into public.byeollog_workspace_members values('+q(b)+','+q(user)+",'owner');");
  await fails(call('invalid-fan',undefined,b),'PT404');
  await ingest(context,'newly-excluded','changed-rule');
  await sql('insert into public.bangsel_roulette_rules values('+q(a)+",'changed-rule','exclude');");
  await sql('set role service_role; '+call('newly-excluded'));await check(review('newly-excluded')+"='auto_excluded'",'classification changed after list prevents upbo');
  await check('select total_qty=9 from public.bangsel_tasks','newly excluded adds no rewards');
  // Normal FIFO must still receive and count a non-upbo result.
  const normal=await donation(context,{spins:2});
  await ingest(context,'normal-nothing','nothing');await ingest(context,'normal-reward','reward');
  await check("select match_state='matched' and review_status='pending' from public.byeollog_soop_core_roulette_results where provider_chat_id='normal-nothing'",'matched non-upbo is not exception-excluded');
  await check('select result_count=2 and status=\'complete\' from public.byeollog_soop_core_donations where id='+q(normal.id),'FIFO count and completion unchanged');
  await fails(call('normal-reward'),'PT404');
  await ingest(context,'after-complete','reward');
  const later=await donation(context);
  await ingest(context,'after-complete','reward');
  await check('select result_count=0 from public.byeollog_soop_core_donations where id='+q(later.id),'old unmatched retry never joins later donation');
  // Cross-workspace learning must not exclude the same text in another tenant.
  const other=await round(b);await ingest(other,'other-nothing','nothing');
  await check("select review_status='pending' from public.byeollog_soop_core_roulette_results where provider_chat_id='other-nothing'",'classification scoped to workspace');
  const special=await round();
  await sql('insert into public.byeollog_special_roulette_rules(workspace_id,result_text,allow_stacking) values('+q(a)+",'double',true);");
  await donation(special);await ingest(special,'double-before-manual','double');
  await ingest(special,'manual-with-pending-double','reward');await sql('set role service_role; '+call('manual-with-pending-double'));
  await check('select total_qty=12 from public.bangsel_tasks','manual registration ignores pending special multiplier');
  await donation(special);await ingest(special,'real-after-manual','reward');
  await multiplier(special,'real-after-manual',2);
  await check(review('manual-with-pending-double')+"='registered'",'manual result stays reviewed after later real donation');

  await sql(`alter table public.byeollog_workspaces add column slug text,add column public_page_enabled boolean default true;
    update public.byeollog_workspaces set slug=soop_id;
    alter table public.bangsel_tasks add column created_at timestamptz default now(),add column public_comment text;
    alter table public.bangsel_donations add column id uuid default gen_random_uuid(),add column imported_at timestamptz default now(),add column donated_at timestamptz default now(),add column nickname text,add column soop_id text,add column donation_type text,add column donated_date date,add column donated_time time;
    create function public.byeollog_complete_oauth_signup_v1(uuid,text,text,text,text,text) returns table(application_id uuid,workspace_id uuid,workspace_slug text,soop_id text) language sql as 'select gen_random_uuid(), $1, $2, $3';`);
  await sql(await read('20260909022409_user_experience_controls.sql'));
  await sql(await read('20260909023008_exception_undo_source_identity.sql'));
  const call2=(key,decision,workspace=a,actor=user)=>call(key,decision,workspace,actor).replace('resolve_soop_roulette_exception_v1','resolve_soop_roulette_exception_v2');
  await sql('set role service_role; '+call2('empty-unknown',{action:'undo'}));
  await check(review('empty-unknown')+"='pending'",'excluded can be undone');
  await sql('set role service_role; '+call2('empty-unknown',{action:'undo'}));
  await check('select count(*)=1 from public.byeollog_roulette_exception_reviews','undo retries do not duplicate history');
  await sql('set role service_role; '+call2('empty-reward',{action:'undo'}));
  await check('select total_qty=9 from public.bangsel_tasks','undo subtracts only its own three quantities');
  await check('select count(*)=9 from public.bangsel_task_import_items','undo removes only its own import keys');
  await sql('set role service_role; '+call2('empty-reward',{action:'registered',soopId:'alice',event:'September',type:'dance',quantity:2}));
  await check('select total_qty=11 from public.bangsel_tasks','re-register after undo commits new quantity');
  await sql('update public.bangsel_tasks set done_qty=1');await fails(call2('empty-reward',{action:'undo'}),'PT409');
  await check(review('empty-reward')+"='registered'",'completed reward rejection preserves decision');
  await sql('update public.bangsel_tasks set done_qty=0');
  await fails(call2('empty-nothing',{action:'undo'}),'PT409');
  await fails(call2('empty-reward',{action:'undo'},b),'PT404');
  await fails(call2('empty-reward',{action:'undo'},a,null),'42501');
  await sql('set role service_role; '+call2('invalid-fan',{action:'registered',soopId:'new_fan',fanName:'New fan',createFan:true,event:'new',type:'reward',quantity:2}));
  await check("select count(*)=1 from public.bangsel_fans where workspace_id="+q(a)+" and soop_id='new_fan'",'new fan created with registration');
  await sql('set role service_role; '+call2('invalid-fan',{action:'undo'}));
  await check("select count(*)=0 from public.bangsel_tasks where fan_soop_id='new_fan'",'undo sole contribution deletes task');
  await sql('set role service_role; '+call2('invalid-fan',{action:'registered',soopId:'rollback_new',fanName:'Rollback fan',createFan:true,event:'new',type:'reward',quantity:2}));
  const status=`public.byeollog_ux_roulette_status_v1(${q(a)},${q(user)})`;
  await check(`${status}->>'pendingCount' is not null`,'pending status reads actual private state');
  await fails(`select public.byeollog_ux_roulette_status_v1(${q(a)},null)`,'42501');
  await fails('set local role anon; select '+status,'42501');
  await check("select count(*)=0 from public.byeollog_roulette_exception_reviews where workspace_id="+q(b),'review history isolated');
  const close=`select public.byeollog_close_stale_donation_v1(${q(a)},${q(user)},${q(later.id)},(select updated_at from public.byeollog_soop_core_donations where id=${q(later.id)}))`;
  await sql('set role service_role; '+close);await sql('set role service_role; '+close);
  await check('select user_closed_at is not null and status=\'expired\' from public.byeollog_soop_core_donations where id='+q(later.id),'stale pending explicitly closed idempotently');
  const pub="public.byeollog_public_upbo_page_v1('fixture_a',null,0,'name')";
  await check(pub+"->>'totalRows'='2'",'public page returns remaining task count');
  await sql(`insert into public.bangsel_tasks(workspace_id,fan,fan_soop_id,event,type,total_qty,public_comment) select ${q(a)},'Same name','fan_'||n,'bulk','type_'||n,1,E'public\nprivate tail' from generate_series(1,55)n;`);
  await check("jsonb_array_length("+pub+"->'items')=50 and ("+pub+"->>'hasMore')::boolean",'public page bounded fifty with next page');
  await check("jsonb_array_length(public.byeollog_public_upbo_page_v1('fixture_a',null,1,'name')->'items')=7",'second public page complete');
  await sql("update public.byeollog_workspaces set public_page_enabled=false where id="+q(a));
  await check(pub+"->>'totalRows'='0'",'public visibility honored on every page');
  await sql("update public.byeollog_workspaces set public_page_enabled=true where id="+q(a));
  await fails('set local role anon; select '+pub,'42501');
  const consent={termsVersion:'2026-09-06',privacyVersion:'2026-09-09',termsAgreed:true,collectionAgreed:true,age14Confirmed:true};
  const signup=v=>`select public.byeollog_complete_oauth_signup_v2(${q(a)},'fixture_a','fixture_soop','synthetic',${q(JSON.stringify(v))}::jsonb,null,'')`;
  await fails(signup({...consent,age14Confirmed:false}),'22023');
  await fails(signup({...consent,termsVersion:'old'}),'22023');
  await check('select count(*)=0 from public.byeollog_signup_consents','rejected consent has no record');
  await sql('set role service_role; '+signup(consent));
  await check("select age_14_confirmed and agreed_at is not null and privacy_version='2026-09-09' from public.byeollog_signup_consents",'consent version and server time recorded');
  await check(`public.byeollog_ux_history_v1(${q(a)},clock_timestamp()-interval '7 days',clock_timestamp()+interval '1 day',null,null,'')->'items' is not null`,'paged history query compiles against realistic schema');

  const stalled=await round(),head=await donation(stalled);
  await ingest(stalled,'ux-stale-explained','reward',{when:'2026-09-08T00:20:00Z'});
  await check("select review_details->'fifoHead'->>'id'="+q(head.id)+" from public.byeollog_soop_core_roulette_results where provider_chat_id='ux-stale-explained'",'exception captures the actual blocking head');
  await sql('set role service_role; '+call2('ux-stale-explained',{action:'excluded'}));
  await sql('set role service_role; '+call2('ux-stale-explained',{action:'undo'}));
  await check("select review_details->'fifoHead'->>'id'="+q(head.id)+" from public.byeollog_soop_core_roulette_results where provider_chat_id='ux-stale-explained'",'blocking head explanation survives review and undo');
  await sql(`insert into public.bangsel_donations(workspace_id,source_event_key,balloons,nickname) values (${q(a)},'soop_sdk:history-three',3,'history fixture'),(${q(a)},'soop_sdk:history-two',2,'history fixture'),(${q(a)},'soop_sdk:history-fivehundred',500,'history fixture'),(${q(a)},'soop_sdk:history-ninetyseven',97,'history fixture');`);
  await check(`jsonb_array_length(public.byeollog_ux_history_v1(${q(a)},clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',null,null,'history fixture')->'items')=4`,'ordinary and mission raw-only amounts stay visible in paged history');
  await sql(`update public.bangsel_tasks set total_qty=total_qty-1 where fan_soop_id='alice';`);
  await fails(call2('empty-reward',{action:'undo'}),'PT409');

  const edge=await round();await ingest(edge,'undo-edge-first','reward');await ingest(edge,'undo-edge-second','reward');
  const edgeDecision={action:'registered',soopId:'undo_edge',fanName:'Undo edge',createFan:true,event:'edge',type:'edge',quantity:1};
  await sql('set role service_role; '+call2('undo-edge-first',edgeDecision));
  await sql('set role service_role; '+call2('undo-edge-second',edgeDecision));
  await sql('set role service_role; '+call2('undo-edge-first',{action:'undo'}));
  await sql("update public.bangsel_tasks set done_qty=1 where fan_soop_id='undo_edge'");
  await sql('set role service_role; '+call2('undo-edge-first',edgeDecision));
  await check("select count(*)=2 and sum(total_qty)=2 from public.bangsel_tasks where fan_soop_id='undo_edge'",'re-register after undo and completion of merged remainder');
  console.log(JSON.stringify({passed:true,checks,synthetic:true}));



}finally{await runtime.stop()}



