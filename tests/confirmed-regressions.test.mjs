import test from 'node:test';
import assert from 'node:assert/strict';
import {reduceSoopSdkSession} from '../services/soop-gateway/lib/soop-sdk-relay.js';
import {sanitizeAgentRolloutSnapshot} from '../apps/admin-runtime/lib/agent-rollout.js';
const workspace='10000000-0000-4000-8000-000000000001';
function health(state,ageMs){
 return sanitizeAgentRolloutSnapshot({devices:[]},{version:'1.0.0.40'},{controls:[{workspace_id:workspace,gateway_enabled:true,core_collection_enabled:true}],sessions:[{workspace_id:workspace,state,heartbeat_at:new Date(Date.now()-ageMs).toISOString()}]}).coreCollection.gateways[0].health;
}
test('offline session waits 30 seconds rather than falling through to 1-second reconnect',()=>{
 let state={};
 for(let attempt=0;attempt<100;attempt++){
  state=reduceSoopSdkSession(state,{type:'connect_requested'});
  state=reduceSoopSdkSession(state,{type:'broadcast_offline'});
  assert.equal(state.nextRetryMs,30_000);
  assert.equal(state.retryAttempt,0);
 }
});
test('offline heartbeat remains healthy between its five-minute reports, but a stopped worker becomes stale',()=>{
 assert.equal(health('waiting_for_live',4*60_000),'waiting_for_live');
 assert.equal(health('waiting_for_live',8*60_000),'stale');
 assert.equal(health('connected',90_000),'connected');
 assert.equal(health('connected',180_000),'stale');
});
