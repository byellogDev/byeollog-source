import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {broadcastReadiness} from '../../apps/admin-runtime/lib/broadcast-readiness.js';import {uxControlsRequest} from '../../apps/admin-runtime/lib/ux-controls.js';
const ws='10000000-0000-4000-8000-000000000001',user='20000000-0000-4000-8000-000000000002',now=Date.parse('2026-09-13T12:00:00Z');
test('readiness uses only authenticated scope, read-only bounded queries and redacted device results',async()=>{
 const calls=[],sb=async(table,path,opt)=>{calls.push({table,path,opt});if(table.includes('readiness'))return {state:'online',registered:1,online:1,secret:'never expose'};if(table.includes('connections'))return [{status:'connected'}];if(table.includes('mappings'))return [{expected_spins:1}];return [{state:'connected',heartbeat_at:new Date().toISOString()}]};
 const r=await uxControlsRequest({sb,workspaceId:ws,userId:user,method:'GET',query:{kind:'readiness',workspace_id:'forged'}});assert.equal(r.status,200);assert.equal(calls.length,4);for(const c of calls){assert.ok(c.path.includes(ws)||c.opt.body.p_workspace_id===ws);assert.ok(c.opt.signal instanceof AbortSignal);assert.ok(!c.opt.method||c.table.startsWith('rpc/'));assert.ok(!JSON.stringify(c).includes('forged'))}assert.equal(r.body.agent.state,'online');assert.equal(r.body.wallpaper.displayConfirmed,false);assert.ok(!JSON.stringify(r).includes('never expose'));
 assert.equal((await uxControlsRequest({sb,workspaceId:ws,userId:user,method:'POST',query:{kind:'readiness'}})).status,405);assert.equal(calls.length,4);
});
test('partial readiness failures stay unknown without hiding other results',async()=>{
 const r=await broadcastReadiness({workspaceId:ws,userId:user,now,sb:async table=>{if(table.includes('connections'))throw Error('unavailable');if(table.includes('readiness'))return {state:'offline',registered:1,online:0};return []}});
 assert.equal(r.connection.state,'unknown');assert.equal(r.agent.state,'offline');assert.equal(r.roulette.state,'empty');assert.equal(r.collection.state,'waiting');
});
test('malformed snapshots and stale or future heartbeats never become healthy',async()=>{
 for(const heartbeat of ['bad',new Date(now-121000).toISOString(),new Date(now+31000).toISOString()]){const r=await broadcastReadiness({workspaceId:ws,userId:user,now,sb:async table=>table.includes('gateway')?[{state:'connected',heartbeat_at:heartbeat}]:{}});assert.equal(r.collection.state,'waiting');assert.equal(r.agent.state,'unknown');assert.equal(r.roulette.state,'unknown')}
 const r=await broadcastReadiness({workspaceId:ws,userId:user,now,sb:async table=>table.includes('mappings')?[{expected_spins:null}]:[]});assert.equal(r.roulette.incomplete,true);
});
const source=fs.readFileSync(auditURL('../lib/admin-source.html',import.meta.url),'utf8');const code=source.slice(source.indexOf('function historyDiagnosticSteps('),source.indexOf('async function showHistoryDiagnostic('));const steps=vm.runInNewContext(code+';historyDiagnosticSteps');
test('donation diagnostics distinguish actual FIFO waits, closed waits, classification and normal donations',()=>{
 for(const status of ['pending','collecting'])assert.equal(steps({donation:{status,result_count:1,expected_spins:2}})[1].action,'pending');
 for(const donation of [{status:'expired',result_count:1,expected_spins:2},{status:'pending',user_closed_at:'2026-09-13',result_count:1,expected_spins:2},{status:'completed',result_count:2,expected_spins:2}])assert.equal(steps({donation})[1].action,null);
 assert.equal(steps({original:{}})[1].ok,false);assert.equal(steps({stage:{process_status:'needs_review'}})[2].action,'learning');assert.equal(steps({stage:{process_status:'processed'}})[2].ok,true);assert.equal(steps({displayConfirmed:true})[4].ok,false);
});
