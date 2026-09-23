import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {processPendingCollectorRows} from '../lib/collector-processor.js';
const a='10000000-0000-4000-8000-000000000001';
async function fixture(run){
 const oldFetch=globalThis.fetch,names=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]]));
 Object.assign(process.env,{SUPABASE_URL:'https://normalization.invalid',SUPABASE_SECRET_KEY:'fixture',SUPABASE_SERVICE_ROLE_KEY:'fixture'});
 const state={unavailable:false,voided:false,rules:['A','B'],ledger:new Set(),commits:0,row:{workspace_id:a,source_uid:'soop_sdk:fixture',session_id:'fixture',donated_time_text:'2026-09-14 12:00:00',uploaded_at:'2026-09-14T03:00:00Z',process_status:'pending',soop_id:'viewer',nickname:'viewer',balloons:33,event_name:'configured',validation:'matched',raw_payload:{source_provider:'soop_chat_sdk',type:'SENDBALLOON'},roulette_results:[{result:'A',receipt_identity:'result:1'},{result:'B',receipt_identity:'result:2'}]}};
 const response=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}});
 globalThis.fetch=async(input,opt={})=>{
  const u=new URL(input);assert.equal(u.origin,'https://normalization.invalid');const table=u.pathname.slice('/rest/v1/'.length),method=opt.method||'GET',body=opt.body?JSON.parse(opt.body):null;
  if(table==='bangsel_roulette_rules')return response(state.rules.map(result_text=>({result_text,action:'include',output_types:[result_text]})));
  if(table==='rules')return response([]);
  if(table==='bangsel_roulette_invalidations')return state.unavailable?response({message:'fixture unavailable'},503):response(state.voided?[{source_uid:state.row.source_uid}]:[]);
  if(table==='bangsel_collector_staging'){if(method==='PATCH')Object.assign(state.row,body);return response([structuredClone(state.row)]);}
  if(table==='bangsel_donations')return response([]);
  if(table==='bangsel_fans')return response([{current_nickname:'viewer',station_url:'https://fixture.invalid',alias:'viewer'}]);
  if(table==='rpc/byeollog_commit_upbo_group_v1'){state.commits++;let added=0;for(const key of body.p_group.keys)if(!state.ledger.has(key)){state.ledger.add(key);added++;}return response({taskId:'fixture-task',added});}
  throw Error('Unexpected fixture '+table);
 };
 state.process=()=>processPendingCollectorRows({workspaceId:a,skipStaleRecovery:true,includeFailed:true});
 try{await run(state);}finally{globalThis.fetch=oldFetch;for(const n of names)if(saved[n]===undefined)delete process.env[n];else process.env[n]=saved[n];}
}
test('A04 invalidation lookup failure writes no tasks and remains retryable',()=>fixture(async s=>{
 s.unavailable=true;const failed=await s.process();assert.equal(failed.counts.tasks,0);assert.equal(failed.ok,false);assert.equal(s.commits,0);assert.equal(s.row.process_status,'pending');
 s.unavailable=false;assert.equal((await s.process()).counts.tasks,2);
}));
test('A06 immutable IDs prevent reorder duplicates, repeated text remains distinct',()=>fixture(async s=>{
 assert.equal((await s.process()).counts.tasks,2);s.row.process_status='pending';s.row.roulette_results.reverse();assert.equal((await s.process()).counts.tasks,0);
 s.row.roulette_results.push({result:'A',receipt_identity:'result:3'});s.row.process_status='pending';assert.equal((await s.process()).counts.tasks,1);assert.equal(s.ledger.size,3);
}));
test('A06 migration-pinned numeric identities survive reordered historical arrays',()=>fixture(async s=>{
 s.row.roulette_results=[{result:'A',receipt_identity:'0'},{result:'B',receipt_identity:'1'}];
 assert.equal((await s.process()).counts.tasks,2);s.row.roulette_results.reverse();s.row.process_status='pending';assert.equal((await s.process()).counts.tasks,0);
}));
test('A08 fixed rewards finish once while unknown roulette waits, then learned results finish',()=>fixture(async s=>{
 s.row.fixed_rewards=[{event_name:'fixed',upbo_type:'fixed',quantity:2}];s.rules=[];
 const first=await s.process();assert.equal(first.counts.tasks,2);assert.equal(s.row.process_status,'needs_review');
 assert.equal((await s.process()).counts.tasks,0);s.rules=['A','B'];assert.equal((await s.process()).counts.tasks,2);assert.equal(s.ledger.size,4);
}));
test('A08 short roulette cannot block or duplicate fixed rewards',()=>fixture(async s=>{
 s.row.fixed_rewards=[{event_name:'fixed',upbo_type:'fixed',quantity:1}];s.row.validation='short';
 assert.equal((await s.process()).counts.tasks,1);assert.equal(s.row.process_status,'pending');assert.equal((await s.process()).counts.tasks,0);
}));
const source=await readFile(new URL('../lib/admin-source.html',import.meta.url),'utf8');
test('A12 stale editor cannot overwrite newly collected or completed quantities',async()=>{
 const edit=source.slice(source.indexOf('async function saveItem(){'),source.indexOf('const completionWrites=new Set();'));
 const values={editId:'task',fanSoopId:'viewer',fan:'viewer',totalQty:'2',event:'event',type:'reward',publicComment:'changed',memo:''};const nodes=new Map(),alerts=[];
 const el=id=>{if(!nodes.has(id))nodes.set(id,{value:values[id]??'',disabled:false,textContent:'',files:[],classList:{remove(){},add(){}},querySelectorAll(){return []}});return nodes.get(id);};
 const db={id:'task',total_qty:5,done_qty:3,updated_at:'new'},old={id:'task',total_qty:2,done_qty:0,updated_at:'old'};let writes=0;
 const context={$:el,tasks:[{...db}],editTaskSnapshot:old,fanProfiles:{viewer:{alias:'viewer'}},newTaskDraft:null,URLSearchParams,
  requireLogin:()=>true,fanProfilesMatchingNickname:()=>[],uniqueFanProfileByNickname:()=>null,
  api:async(path,opt)=>{const p=new URLSearchParams(path);writes++;if(p.get('updated_at')!=='eq.'+db.updated_at||p.get('total_qty')!=='eq.'+db.total_qty)return [];Object.assign(db,JSON.parse(opt.body));return [db];},alert:m=>alerts.push(m),console:{error(){}}};
 await vm.runInNewContext(`(async()=>{${edit};await saveItem();})()`,context);
 assert.equal(writes,1);assert.equal(db.total_qty,5);assert.equal(db.done_qty,3);assert.match(alerts[0],/入力|입력 내용을 복사|입력 내용은 유지/);assert.equal(el('publicComment').value,'changed');assert.equal(el('saveItemBtn').disabled,false);
});
test('A13 different content with equal name and byte length is retained',()=>{
 const code=source.slice(source.indexOf('function localFileKey(f){'),source.indexOf('async function putLocalFiles'));
 const first={name:'result.txt',size:3,blob:new Blob(['abc'])},second={name:'result.txt',size:3,blob:new Blob(['xyz'])};
 const files=vm.runInNewContext(`(()=>{${code};return mergeLocalFiles([first],[second,first]);})()`,{first,second});
 assert.equal(files.length,2);assert.equal(files[1],second);
});
test('A10 context errors return failure and shell cannot claim verified connection',async()=>{
 const api=await readFile(new URL('../api/admin.js',import.meta.url),'utf8');
 const block=api.slice(api.indexOf("  if(operation==='context'){"),api.indexOf("  if(operation==='viewer-page'){"));
 const run=async fail=>{const response={code:0,status(n){this.code=n;return this},json(body){return {code:this.code,body}},setHeader(){}};
  return vm.runInNewContext(`(async()=>{${block}})()`,{operation:'context',req:{},res:response,q:encodeURIComponent,requireCapabilityLive:async()=>({user_id:'user'}),workspaceForSession:async()=>'workspace',sb:async()=>{if(fail)throw Error('database unavailable');return []}});};
 assert.equal((await run(true)).code,503);assert.equal((await run(false)).code,403);
});
test('A11 web and offline Agent report the actual seven-day retention',async()=>{
 assert.match(await readFile(new URL('../lib/agent-wallpaper-control.js',import.meta.url),'utf8'),/retentionDays:7/);
 assert.match(await readFile(new URL('../../BYEOLLOG_AGENT_DEV_v07022/WallpaperEditorCoordinator.cs',import.meta.url),'utf8'),/\["retentionDays"\] = 7/);
});
