import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {collectorSubscriptionInfo} from '../apps/admin-runtime/lib/collector-subscription.js';
const source=fs.readFileSync(new URL('../apps/admin-runtime/lib/admin-source.html',import.meta.url),'utf8');
function harness(rows){
  const elements={};
  const ctx=vm.createContext({donationStatsRows:rows,donationStatMode:'person',fanProfiles:{},collectorSubscriptionInfo,esc:String,$:id=>elements[id]??={innerHTML:'',classList:{toggle(_name,value){this.active=value}}}});
  vm.runInContext(source.slice(source.indexOf('function setDonationStatMode('),source.indexOf('function donationEventKey(')),ctx);
  return {ctx,elements};
}
const row=(date,balloons,soop_id='donor-a',extra={})=>({donated_date:date,balloons,soop_id,nickname:soop_id,...extra});
test('monthly totals retain daily date boundaries, year separation and monthly distinct donors',()=>{
  const rows=[row('2025-12-31',10),row('2026-01-01',20,'donor-a',{donated_at:'2025-12-31T15:00:00Z'}),row('2026-01-31',30),row('2026-02-01',40,'donor-b',{donated_at:'2026-01-31T15:00:00Z'}),row('2026-01-15',5,'donor-b')];
  const {ctx}=harness(rows),data=ctx.donationMonthlyStats(rows);
  assert.deepEqual(JSON.parse(JSON.stringify(data.map(x=>[x.month,x.total,x.count,x.users.size]))),[['2026-02',40,1,1],['2026-01',55,3,2],['2025-12',10,1,1]]);
  assert.equal(data.reduce((n,x)=>n+x.total,0),rows.reduce((n,x)=>n+x.balloons,0));
});
test('subscriptions excluded, system settlement counted without donor, missing dates retained',()=>{
  const rows=[row('2026-09-01',100),row('2026-09-02',500,'__challenge_settle__',{donation_type:'도전성공'}),row('2026-09-03',999,'sub',{donation_type:'구독'}),row('2026-09-04',999,'sub',{validation:'subscription'}),row('',7),row('invalid',3)];
  const {ctx}=harness(rows),data=ctx.donationMonthlyStats(rows);
  assert.deepEqual(JSON.parse(JSON.stringify(data.map(x=>[x.month,x.total,x.count,x.users.size]))),[['2026-09',600,2,1],['',10,2,1]]);
});
test('monthly tab renders and switches to existing tabs; empty state is preserved',()=>{
  const {ctx,elements}=harness([row('2026-09-01',123)]);
  ctx.setDonationStatMode('month');
  assert.match(elements.donationStatsTable.innerHTML,/2026년 9월/);
  assert.match(elements.donationStatsTable.innerHTML,/123개/);
  assert.equal(elements.donationTabMonth.classList.active,true);
  for(const mode of ['date','person','amount']){ctx.setDonationStatMode(mode);assert.equal(elements.donationTabMonth.classList.active,false);assert.match(elements.donationStatsTable.innerHTML,/123개/)}
  ctx.donationStatsRows=[];ctx.setDonationStatMode('month');assert.match(elements.donationStatsTable.innerHTML,/아직 저장된/);
});
test('published HTML and both active sources contain the identical monthly implementation',async()=>{
  for(const app of ['web','admin-runtime']){
    const html=fs.readFileSync(new URL('../apps/'+app+'/lib/admin-source.html',import.meta.url),'utf8');
    const {ADMIN_HTML_BASE64}=await import('../apps/'+app+'/lib/admin-html.js');
    assert.equal(html,source);assert.equal(Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8'),html);
    for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
  }
});
