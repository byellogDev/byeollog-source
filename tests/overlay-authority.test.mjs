import test from 'node:test';
import assert from 'node:assert/strict';
import {processPendingCollectorRows} from '../apps/collector-runtime/lib/collector-processor.js';
import {fetchAutomaticRouletteRules} from '../apps/admin-runtime/lib/weflab-collection-config.js';

test('overlay results create tasks once with stable receipts and never insert another donation statistic',async()=>{
 const priorFetch=globalThis.fetch,keys=['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 Object.assign(process.env,{SUPABASE_URL:'https://overlay-fixture.invalid',SUPABASE_SECRET_KEY:'fixture-key',SUPABASE_SERVICE_ROLE_KEY:'fixture-role'});
 const source='overlay:'+'a'.repeat(64),ledger=new Set(),groups=[];
 let row={workspace_id:'fixture-workspace',source_uid:source,source_scope:'soop',session_id:'fixture-broadcast',uploaded_at:'2026-10-11T08:00:00Z',
   process_status:'pending',validation:'matched',nickname:'후원자',soop_id:'donor',balloons:330,event_name:'10월 330개',donated_time_text:'2026-10-11 17:00:00',
   raw_payload:{type:'SENDBALLOON',source_provider:'overlay_result',roulette_enabled:true},
   roulette_results:[1,2].map(i=>({result:'노래 & 춤',receipt_identity:`${source}:${i}`,special_roulette:{version:1,sourceEventKey:`soop_result:${source}:${i}`,appliedMultiplier:1,controlEvent:false,pendingMultiplier:null}}))};
 globalThis.fetch=async(input,opt={})=>{
   const url=new URL(input),route=url.pathname.split('/rest/v1/')[1],method=opt.method||'GET',body=opt.body?JSON.parse(opt.body):null;
   assert.equal(url.origin,'https://overlay-fixture.invalid');
   if(route==='bangsel_roulette_rules')return Response.json([{result_text:'노래 & 춤',action:'include',output_types:['노래 & 춤']}]);
   if(route==='rules'||route==='bangsel_roulette_invalidations')return Response.json([]);
   if(route==='bangsel_collector_staging'){
     if(method==='PATCH')row={...row,...body};return Response.json([row]);
   }
   if(route==='bangsel_fans')return Response.json([{soop_id:'donor',alias:'후원자',current_nickname:'후원자',station_url:'https://ch.sooplive.co.kr/donor'}]);
   if(route==='rpc/byeollog_commit_upbo_group_v1'){
     let added=0;for(const k of body.p_group.keys)if(!ledger.has(k)){ledger.add(k);added++;}groups.push(body.p_group);return Response.json({added});
   }
   assert.fail('unexpected route '+route+' '+method);
 };
 try{
   const options={sourceUids:[source],workspaceId:row.workspace_id,skipStaleRecovery:true};
   const first=await processPendingCollectorRows(options);assert.equal(first.counts.tasks,4);assert.equal(first.counts.failed,0);
   row.process_status='pending';assert.equal((await processPendingCollectorRows(options)).counts.tasks,0);
   assert.equal(ledger.size,4);assert.deepEqual(groups.slice(0,2).map(g=>g.type),['노래','춤']);
   for(const key of ledger)assert.ok(key.startsWith(source+'|soop-result:'));
 }finally{globalThis.fetch=priorFetch;for(const k of keys)if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
});
test('production enrollment includes account-pinned context and rejects unsupported range rules',async()=>{
 const context={type:'page',pageid:'alert',platform:{afreeca:{id:'fixture'}},idx:1,preset:0,dir:'x',config:{ver:'1',url:{socket:'https://ssmain.weflab.com',socket_afreeca:'https://ssafreeca.weflab.com'}}};
 for(const hi of [330,331]){
   let n=0;const fetchImpl=async()=>new Response(n++===0?'const loginData = '+JSON.stringify(context)+';':JSON.stringify({result:'success',data:{checkbox:{item_alert_rouletteuse:'on'},donation:{item_roulette_donation:[{checkbox:{setup_roulette_use:'on'},text:{setup_alert_giftmin:'330',setup_alert_giftmax:String(hi)}}]}}}));
   const promise=fetchAutomaticRouletteRules('https://weflab.com/page/fixture','fixture',{includeContext:true,fetchImpl});
   if(hi!==330)await assert.rejects(promise,/unsupported/);else assert.deepEqual((await promise).config,{url:'https://weflab.com/page/fixture',owner:'fixture',idx:'1',preset:'0'});
 }
});
