import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html=fs.readFileSync(new URL('../apps/admin-runtime/lib/admin-source.html',import.meta.url),'utf8');
const register=html.slice(html.indexOf('async function registerCollectorRow('),html.indexOf('async function archiveCollectorRowAsNonBangsel('));
for(const status of ['pending','ignored'])test(`manual ${status} registration uses the frozen multiplier via the server`,async()=>{
 const row={source_uid:'fixture',uploaded_at:'2026-10-11T09:00:00Z',process_status:status,roulette_results:[{result:'새 업보',special_roulette:{appliedMultiplier:2}}]};
 const calls=[],errors=[];let refreshed=0;
 const ctx=vm.createContext({requireLogin:()=>true,collectorFindRow:()=>row,collectorResultList:r=>r.roulette_results,collectorRuleFor:()=>({action:'include'}),
   runServerCollectorProcessing:async opt=>{calls.push(opt);return {counts:{processed:1,tasks:2}}},
   apiTable:async(table,query,opt)=>{assert.equal(status,'ignored');assert.equal(table,'bangsel_collector_staging');assert.match(query,/process_status=eq.ignored/);assert.match(query,/uploaded_at=eq./);assert.equal(JSON.parse(opt.body).process_status,'pending');return [row]},
   loadServer:async()=>{refreshed++},loadCollectorInbox:async()=>{},loadCollectorIgnored:async()=>{},loadDonationStats:async()=>{},
   $:()=>({classList:{contains:()=>true}}),alert:x=>errors.push(x),collectorLoaded:true,collectorIgnoredLoaded:true,donationStatsLoaded:true});
 vm.runInContext(register,ctx);await ctx.registerCollectorRow('fixture');
 assert.deepEqual(errors,[]);assert.equal(calls.length,1);assert.deepEqual(Array.from(calls[0].source_uids),['fixture']);assert.equal(refreshed,1);
});
