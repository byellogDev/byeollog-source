import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {buildDonationReport,reportStarts,loadDonationReport,reportDate} from '../apps/admin-runtime/lib/donation-report.js';
import dataHandler from '../apps/admin-runtime/handlers/data.js';
import {createSessionToken} from '../apps/admin-runtime/lib/auth.js';
const id='12345678-1234-4234-8234-123456789012';
const t=s=>Date.parse(s+'+09:00');
const row=(time,amount=100,type='일반후원',extra={})=>({donated_date:time.slice(0,10),donated_time:time.slice(11),balloons:amount,donation_type:type,...extra});
test('default bounds combine older collector and newer wallpaper starts in KST, deduplicate exact starts',async()=>{
 const calls=[];const sbImpl=async(table,path)=>{calls.push([table,new URLSearchParams(path)]);return table==='bangsel_collector_staging'?[{broadcast_start_local:'2026-08-01T23:30:00'},{broadcast_start_local:'2026-08-01T23:30:00'}]:[{started_at:'2026-09-02T15:10:00Z'}]};
 const result=await loadDonationReport(id,{mode:'bounds'},{sbImpl});
 assert.deepEqual(result.bounds,{first:'2026-08-01',last:'2026-09-03',startCount:2});
 assert.equal(result.report,null);assert.equal(calls.length,2);
 for(const [,p] of calls)assert.equal(p.get('workspace_id'),'eq.'+id);
});
test('empty start history cannot silently default to donation dates or today',async()=>{
 assert.deepEqual(await loadDonationReport(id,{}, {sbImpl:async()=>[]}),{bounds:{first:null,last:null,startCount:0},report:null});
});
test('local starts use KST regardless of server timezone',()=>{
 assert.deepEqual(reportStarts([{broadcast_start_local:'2026-08-01T19:00:00'}],[{started_at:'2026-08-01T10:00:00Z'}]),[t('2026-08-01T19:00:00')]);
});
test('midnight donations belong to selected starting broadcast day; saved date wins',()=>{
 const r=buildDonationReport([t('2026-08-01T23:30:00')],[row('2026-08-02T00:15:00',120,'일반후원',{donated_at:'2000-01-01T00:00:00Z'}),row('2026-08-02T02:30:00',999)],{from:'2026-08-01',to:'2026-08-01'});
 assert.equal(r.total,120);assert.deepEqual(r.means,[0,120,0,0,0,0]);
});
test('one event is never counted in overlapping starts; next start outside range still cuts comparison',()=>{
 const starts=[t('2026-08-01T22:00:00'),t('2026-08-02T00:00:00')];
 const rows=[row('2026-08-01T23:00:00',20),row('2026-08-02T00:00:00',70)];
 const r=buildDonationReport(starts,rows,{from:'2026-08-01',to:'2026-08-02'});
 assert.equal(r.overlapCount,1);assert.equal(r.comparableCount,1);assert.equal(r.total,70);assert.equal(r.sessions[0].total,20);
 const only=buildDonationReport(starts,rows,{from:'2026-08-01',to:'2026-08-01'});assert.equal(only.total,0);assert.equal(only.sessions[0].total,20);
});
test('mission gift/settlement never double count or infer acceptance; subscriptions excluded',()=>{
 const start=t('2026-08-01T19:00:00'),rows=[row('2026-08-01T19:10:00',100),row('2026-08-01T19:20:00',300,'별풍선',{raw_type:'CHALLENGE_GIFT'}),row('2026-08-01T19:25:00',300,'도전성공'),row('2026-08-01T19:27:00',20,'도전미션'),row('2026-08-01T19:28:00',12,'별풍선',{raw_subtype:'FOLLOW_ITEM_EFFECT'})];
 const r=buildDonationReport([start],rows,{from:'2026-08-01',to:'2026-08-01'});
 assert.equal(r.total,100);assert.equal(r.excluded.missionAmount,620);assert.equal(r.excluded.missionCount,3);assert.equal(r.excluded.subscriptionCount,1);
});
test('empty valid windows retained, no-event peak is null; duplicate event keys counted once',()=>{
 const start=t('2026-08-01T19:00:00');const range={from:'2026-08-01',to:'2026-08-02'};
 assert.equal(buildDonationReport([start],[],range).peakBin,null);
 const r=buildDonationReport([start,start+86400000],[row('2026-08-01T19:00:00',100,'일반후원',{source_event_key:'event-a'}),row('2026-08-01T19:00:00',100,'일반후원',{source_event_key:'event-a'})],range);
 assert.equal(r.count,1);assert.equal(r.means[0],50);assert.equal(r.groups[0].count,2);assert.equal(r.groups[0].median,50);
});
test('invalid inputs fail before any query; workspace cannot be overridden',async()=>{
 const sbImpl=async()=>assert.fail('must not query');
 for(const value of ['2026-02-30','2026-1-01','x',[],null])assert.throws(()=>reportDate(value));
 await assert.rejects(loadDonationReport('bad',{}, {sbImpl}),e=>e.status===403);
 await assert.rejects(loadDonationReport(id,{from:'2026-08-02',to:'2026-08-01'},{sbImpl}),e=>e.status===400);
});
test('pagination combines all start pages and donation reads remain server-scoped, minimal and aggregate-only',async()=>{
 let pages=0;const sbImpl=async(table,path)=>{const p=new URLSearchParams(path);assert.equal(p.get('workspace_id'),'eq.'+id);assert.equal(p.has('nickname'),false);
  if(table==='bangsel_collector_staging'){pages++;return p.get('offset')==='0'?Array.from({length:1000},()=>({broadcast_start_local:'2026-08-01T19:00:00'})):[]}
  if(table==='byeollog_wallpaper_sessions')return [{started_at:'2026-09-01T10:00:00Z'}];
  assert.match(p.get('or'),/donated_date.lte.2026-09-02/);assert.doesNotMatch(p.get('select'),/nickname|soop_id|message/);
  return [row('2026-08-01T19:15:00',123,'일반후원',{source_event_key:'private-id',nickname:'secret'})];
 };
 const out=await loadDonationReport(id,{workspace_id:'other'}, {sbImpl});assert.equal(out.report.total,123);assert.equal(pages,2);assert.doesNotMatch(JSON.stringify(out),/private-id|secret|workspace_id/);
});
test('endpoint refuses unsigned and write requests',async()=>{
 const res=()=>({headers:{},setHeader(k,v){this.headers[k]=v},status(v){this.code=v;return this},json(v){this.body=v;return this}});
 let r=res();await dataHandler({method:'GET',headers:{},query:{operation:'donation-report'}},r);assert.equal(r.code,401);assert.match(r.headers['Cache-Control'],/no-store/);
 r=res();await dataHandler({method:'POST',headers:{},query:{operation:'donation-report'}},r);assert.equal(r.code,405);
});

test('authenticated endpoint revalidates membership and ignores a different requested workspace',async(t)=>{
 const saved={};for(const [key,value] of Object.entries({SESSION_SECRET:'s'.repeat(64),SUPABASE_URL:'https://database.example.invalid',SUPABASE_SECRET_KEY:'synthetic',SUPABASE_SERVICE_ROLE_KEY:'synthetic'})){saved[key]=process.env[key];process.env[key]=value}
 t.after(()=>{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value}});
 let member=true,reads=0;
 t.mock.method(globalThis,'fetch',async(url)=>{const u=new URL(url),table=u.pathname.split('/').at(-1),p=u.searchParams;
  if(table==='byeollog_workspace_members'){assert.equal(p.get('workspace_id'),'eq.'+id);return Response.json(member?[{role:'viewer',web_session_epoch:0}]:[])}
  if(table==='byeollog_workspaces')return Response.json([{id,status:'active'}]);
  reads++;assert.equal(p.get('workspace_id'),'eq.'+id);
  return Response.json(table==='bangsel_collector_staging'?[{broadcast_start_local:'2026-08-01T19:00:00'}]:table==='byeollog_wallpaper_sessions'?[]:[row('2026-08-01T19:15:00',123)]);
 });
 const token=createSessionToken({user_id:id,workspace_id:id,role:'viewer'}),req={method:'GET',headers:{cookie:'bangsel_admin_session='+token},query:{operation:'donation-report',workspace_id:'another-workspace'}};
 const response=()=>({setHeader(){},status(code){this.code=code;return this},json(body){this.body=body;return this}});
 let res=response();await dataHandler(req,res);assert.equal(res.code,200);assert.equal(res.body.report.total,123);assert.equal(reads,3);
 member=false;reads=0;res=response();await dataHandler(req,res);assert.equal(res.code,401);assert.equal(reads,0);
});

test('failed or oversized reads never produce a partial report',async()=>{
 await assert.rejects(loadDonationReport(id,{}, {sbImpl:async()=>({message:'unavailable'})}),e=>e.status===503);
 await assert.rejects(loadDonationReport(id,{}, {sbImpl:async(table)=>table==='byeollog_wallpaper_sessions'?[]:Array.from({length:1000},()=>({broadcast_start_local:'2026-08-01T19:00:00'}))}),e=>e.status===422);
});
test('client defaults to broadcast bounds and exposes PNG only after current report generation',async()=>{
 const nodes={},el=id=>nodes[id]??={value:'',textContent:'',classList:{add(){},remove(){}},setAttribute(k,v){this[k]=v},focus(){this.focused=true},scrollIntoView(){this.scrolled=true},getContext(){return new Proxy({}, {get(_t,key){return ()=>{}},set(){return true}})}};
 const reports=buildDonationReport([t('2026-08-01T19:00:00')],[row('2026-08-01T19:05:00')],{from:'2026-08-01',to:'2026-08-01'}),calls=[];
 const ctx=vm.createContext({$:el,streamerName:'테스트',URLSearchParams,AbortController,console,document:{fonts:{ready:Promise.resolve()}},fetch:async url=>{calls.push(url);return {ok:true,json:async()=>({bounds:{first:'2026-08-01',last:'2026-08-01'},report:reports})}}});
 vm.runInContext(fs.readFileSync(new URL('../apps/web/lib/donation-report-client.js',import.meta.url),'utf8'),ctx);
 await ctx.openDonationReport();assert.equal(el('donationReportFrom').value,'2026-08-01');assert.equal(el('donationReportTo').value,'2026-08-01');assert.equal(el('donationReportSave').disabled,false);assert.equal(calls.length,2);
 assert.equal(el('donationReportPanel').focused,true);assert.equal(el('donationReportPanel').scrolled,true);assert.equal(el('donationReportOpen')['aria-expanded'],'true');
 ctx.closeDonationReport();assert.equal(el('donationReportOpen').focused,true);assert.equal(el('donationReportOpen')['aria-expanded'],'false');
 ctx.invalidateDonationReport();assert.equal(el('donationReportSave').disabled,true);
});
