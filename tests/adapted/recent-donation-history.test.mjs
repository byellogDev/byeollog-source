import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(auditURL('../lib/admin-source.html',import.meta.url),'utf8');
const code=source.slice(source.indexOf('function rowHistoryOrigin('),source.indexOf('function renderRecentCollectorHistory('));
const donor=(key,amount,time,type='별풍선')=>({source_event_key:key,balloons:amount,donation_type:type,donated_date:'2026-09-08',donated_time:time,donated_at:'2026-09-08T'+time+'+09:00',nickname:'합성 후원자'});
function harness(fetch=async()=>({ok:true,json:async()=>({items:[]})})){
 const elements={recentCollectorState:{},recentCollectorList:{},historyFrom:{value:'2026-09-08'},historyUntil:{value:'2026-09-09'},recentCollectorSearch:{value:''},historyMore:{}};let renders=0;
 const ctx=vm.createContext({fetch,URLSearchParams,$:id=>elements[id],esc:String,renderRecentCollectorHistory:()=>renders++,recentCollectorLoadVersion:0,recentCollectorLoaded:false,recentCollectorRows:[]});
 vm.runInContext(code,ctx);return {ctx,elements,get renders(){return renders}};
}
test('four reported amounts appear from raw donations while matched processing and subscriptions remain',()=>{
 const {ctx}=harness();
 const stage=[{source_uid:'soop_sdk:matched',source_scope:'soop',balloons:152,process_status:'ignored',donated_time_text:'2026-09-08 20:50:36'}, {source_uid:'sub',source_scope:'soop',validation:'subscription',balloons:8,donated_time_text:'2026-09-08 22:39:00'}];
 const originals=[donor('soop_sdk:a',3,'22:24:26'),donor('soop_sdk:b',2,'22:25:01'),donor('soop_sdk:c',500,'22:38:07','도전미션'),donor('soop_sdk:d',97,'22:38:37','도전미션'),donor('soop_sdk:matched',152,'20:50:36')];
 const rows=ctx.mergeRecentCollectorHistory(stage,originals);
 assert.deepEqual(Array.from(rows,r=>r.balloons),[8,97,500,2,3,152]);
 assert.equal(rows.filter(r=>r.history_origin==='donation').length,4);
 assert.equal(rows.at(-1).process_status,'ignored');assert.equal(stage[0].history_origin,undefined);
});
test('source identity deduplicates only the same provider event and never merges equal amounts or names',()=>{
 const {ctx}=harness();
 const rows=ctx.mergeRecentCollectorHistory([{source_uid:'123',source_scope:'legacy',process_status:'failed',donated_time_text:'2026-09-08 22:00:00'}],[donor('weflab:123',33,'22:00:00'),donor('soop_sdk:123',33,'22:00:00'),donor('soop_sdk:124',33,'22:00:00')]);
 assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.process_status==='failed').length,1);
 assert.equal(ctx.recentCollectorReceivedTs({donated_time_text:'2026-09-08 22:00:00'}),Date.parse('2026-09-08T13:00:00Z'));
 assert.equal(ctx.recentCollectorReceivedTs({uploaded_at:'2026-09-08T13:00:00Z'}),Date.parse('2026-09-08T13:00:00Z'));
 const many=Array.from({length:510},(_,i)=>({...donor('soop_sdk:'+i,i,'22:00:00'),donated_at:new Date(1_800_000_000_000+i*1000).toISOString()}));
 const limited=ctx.mergeRecentCollectorHistory([],many);assert.equal(limited.length,500);assert.equal(limited[0].balloons,509);assert.equal(limited.at(-1).balloons,10);
});
test('history uses bounded server date pages and refreshes on reopening',async()=>{
 const calls=[];const h=harness(async(url)=>{calls.push(auditURL(url,'https://fixture.test'));return {ok:true,json:async()=>({items:[{history_key:'soop_sdk:new',balloons:97}],checkedAt:'2026-09-09T00:00:00Z'})}});
 await h.ctx.loadRecentCollectorHistory(true);assert.equal(h.ctx.recentCollectorRows[0].balloons,97);assert.equal(h.renders,1);
 assert.equal(calls.length,1);assert.equal(calls[0].searchParams.get('kind'),'history');assert.equal(calls[0].searchParams.get('from'),'2026-09-08');assert.equal(calls[0].searchParams.has('workspace_id'),false);
 await h.ctx.loadRecentCollectorHistory(true);assert.equal(calls.length,2);
});
test('history blocks overlapping loads, appends cursor pages without duplicates, and reports failures',async()=>{
 let resolve;const h=harness(()=>new Promise(r=>resolve=r));const first=h.ctx.loadRecentCollectorHistory(true);await h.ctx.loadRecentCollectorHistory(true);
 resolve({ok:true,json:async()=>({items:[{history_key:'new',balloons:500}],cursor:{at:'2026-09-09T00:00:00Z',key:'new'}})});await first;assert.equal(h.renders,1);
 h.ctx.fetch=async()=>({ok:true,json:async()=>({items:[{history_key:'new',balloons:500},{history_key:'old',balloons:3}],cursor:null})});
 await h.ctx.loadRecentCollectorHistory(true,true);assert.equal(h.ctx.recentCollectorRows.length,2);
 const fail=harness(async()=>{throw Error('query failed')});await fail.ctx.loadRecentCollectorHistory(true);assert.equal(fail.ctx.recentCollectorLoaded,false);assert.match(fail.elements.recentCollectorState.textContent,/실패/);
});
test('raw-only records are labelled as collected rather than falsely claiming upbo processing',()=>{
 assert.match(source,/if\(row.history_origin==='donation'\)return \{key:'received',label:'서버 수집됨'\}/);
 assert.match(source,/if\(row.history_origin==='donation'\)return \{cls:'include',text:'후원 원본 저장'\}/);
 assert.match(source,/<option value="received">서버 수집됨<\/option>/);
 assert.doesNotMatch(code,/method:|POST|PATCH|DELETE|setInterval/);
});
