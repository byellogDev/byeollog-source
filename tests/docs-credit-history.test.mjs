import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {uxControlsRequest} from '../apps/admin-runtime/lib/ux-controls.js';
import {broadcastReadiness} from '../apps/admin-runtime/lib/broadcast-readiness.js';
const workspaceId='10000000-0000-4000-8000-000000000001',userId='20000000-0000-4000-8000-000000000001',id='30000000-0000-4000-8000-000000000001';
test('credit referral label uses only the paid workspace and omits internal source or signup fields',async()=>{
 const calls=[],sb=async(table,path)=>{calls.push({table,path});if(table==='byeollog_credit_ledger')return [{entry_type:'signup_referral',source_key:'signup_referral:'+id,credit_delta:500,created_at:'2026-10-11T00:00:00Z'},{entry_type:'adjustment',source_key:'private',credit_delta:1}];return [{id,streamer_name:'Fixture <name>',email:'private@example.invalid'}]};
 const r=await uxControlsRequest({sb,workspaceId,userId,method:'GET',query:{kind:'credits',workspace_id:'forged'}});
 assert.equal(r.body.creditEntries[0].referral_name,'Fixture <name>');assert.equal(r.body.creditEntries[1].referral_name,null);
 assert.ok(calls[1].path.includes('referrer_workspace_id=eq.'+workspaceId));assert.ok(calls[1].path.includes('id=in.('+id+')'));
 assert.doesNotMatch(JSON.stringify(r),/source_key|private@example|30000000|forged/);
});
test('deleted referral and malformed source remain unnamed instead of broad lookup',async()=>{
 let n=0;const r=await uxControlsRequest({workspaceId,userId,method:'GET',query:{kind:'credits'},sb:async()=>{n++;return [{entry_type:'signup_referral',source_key:'signup_referral:invalid',credit_delta:500}]}});
 assert.equal(n,1);assert.equal(r.body.creditEntries[0].referral_name,null);
});
test('special history endpoint stays read-only and takes identity from session',async()=>{
 const calls=[],sb=async(...a)=>{calls.push(a);return {specialPending:[],specialRecent:[]}};
 const r=await uxControlsRequest({workspaceId,userId,sb,method:'GET',query:{kind:'special-history',workspace_id:'forged'}});
 assert.equal(r.status,200);assert.equal(calls[0][0],'rpc/byeollog_special_history_v1');assert.deepEqual(calls[0][2].body,{p_workspace_id:workspaceId,p_user_id:userId});
 assert.equal((await uxControlsRequest({workspaceId,userId,sb,method:'POST',query:{kind:'special-history'}})).status,405);assert.equal(calls.length,1);
});
test('readiness never returns private overlay URL or asserts end-to-end receipt',async()=>{
 for(const enabled of [true,false]){const r=await broadcastReadiness({workspaceId,userId,sb:async table=>table.includes('collection_settings')?{enabled,url:'private-overlay',names:[{name:'private'}]}:[]});assert.equal(r.upbo.state,enabled?'enabled':'off');assert.doesNotMatch(JSON.stringify(r),/private-overlay|"names"/);assert.equal(r.wallpaper.displayConfirmed,false)}
});
test('current dashboard has only management special history and My Page credits navigation',()=>{
 for(const app of ['web','admin-runtime']){const h=fs.readFileSync(`apps/${app}/lib/admin-source.html`,'utf8');assert.doesNotMatch(h,/toggleRoulettePendingBtn|roulettePendingPanel|룰렛 연결 대기 확인/);assert.match(h,/openManagementItem\('specialHistory'\)/);assert.match(h,/kind=special-history/);assert.match(h.slice(h.indexOf('id="myPageModal"'),h.indexOf('id="completionHistoryModal"')),/href="\/credits"/)}
 assert.doesNotMatch(fs.readFileSync('apps/web/setup.html','utf8'),/href="\/credits"|룰렛 연결 대기 확인/);
});
