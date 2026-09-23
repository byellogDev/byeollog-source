import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {loadStableAgentRelease,sanitizeAgentRolloutSnapshot} from '../../apps/admin-runtime/lib/agent-rollout.js';

const source=path=>readFile(auditURL(path,import.meta.url),'utf8');

test('agent rollout RPC is service-role only and workspace scoped',async()=>{
  const sql=await source('../supabase/migrations/20260824120000_add_agent_rollout_dashboard_v1.sql');
  assert.match(sql,/auth\.role\(\) is distinct from 'service_role'/);
  assert.match(sql,/revoke all on function public\.get_agent_rollout_dashboard_v1[\s\S]*from public,anon,authenticated/i);
  assert.match(sql,/grant execute on function public\.get_agent_rollout_dashboard_v1[\s\S]*to service_role/i);
  assert.match(sql,/p_include_all_workspaces or w\.id=p_workspace_id/);
  assert.doesNotMatch(sql,/secret_hash|previous_secret_hash|action_params|last_error/);
});

test('core connection dashboard reuses the authenticated admin function',async()=>{
  const [admin,vercel,page,dashboard]=await Promise.all([source('../api/admin.js'),source('../vercel.json'),source('../lib/agent-rollout-html.js'),source('../lib/admin-source.html')]);
  assert.match(admin,/requireCapabilityLive\(req,res,'data:read'\)/);
  assert.match(admin,/isPlatformAdmin\(liveSession\)/);
  assert.match(admin,/CONNECTION_STATUS_ADMIN_EMAIL='redacted\-contact@example\.invalid'/);
  assert.match(admin,/if\(!isConnectionStatusAdmin\(liveSession\)\)return res\.status\(403\)/);
  assert.match(admin,/operation==='agent-rollout-status'/);
  assert.match(admin,/if\(!isBrowserPage\)return res\.status\(401\)\.json/);
  assert.match(vercel,/"source": "\/agent-rollout"[\s\S]*"destination": "\/api\/admin\?view=agent-rollout"/);
  assert.match(admin,/rpc\/get_agent_rollout_dashboard_v2/);
  assert.match(admin,/byeollog_soop_runtime_controls/);
  assert.match(admin,/byeollog_soop_gateway_sessions/);
  assert.match(page,/연결 · 수집 현황/);
  assert.match(page,/Agent heartbeat/);
  assert.match(page,/SOOP 중앙 수집/);
  assert.match(page,/풍벽지 OBS 동기화/);
  assert.doesNotMatch(page,/Weflab|과거 액션|안전 억제 결정/);
  assert.match(page,/setInterval\(load,30000\)/);
  assert.doesNotMatch(page,/SUPABASE_|service_role|secret_hash/);
  assert.match(dashboard,/<a class="managementCard hidden" id="agentRolloutCard" href="\/agent-rollout" target="_top">[\s\S]*연결 · 수집 현황[\s\S]*<\/a>/);
  assert.match(dashboard,/applyConnectionStatusMenu\(context\.email\)/);
  assert.doesNotMatch(dashboard,/onclick="location\.href='\/agent-rollout'"/);
});

test('collection health and late-event decisions are additive and fail closed',async()=>{
  const [sql,eventRuntime,deviceStatus]=await Promise.all([
    source('../supabase/migrations/20260825100000_add_collection_health_and_event_decisions.sql'),
    source('../supabase/functions/event-runtime/index.ts'),
    source('../supabase/functions/_shared/agent-device-status.ts')
  ]);
  assert.match(sql,/agent_collection_health/);
  assert.match(sql,/collection_state in \('active','idle','recovering','error'\)/);
  assert.match(sql,/when h\.collection_state='active' then 'stalled'/);
  assert.match(sql,/event_runtime_decisions/);
  assert.match(sql,/late_event_suppressed/);
  assert.match(sql,/assert_runtime_locked_v1/);
  assert.match(sql,/revoke all on function public\.g3a_record_event_decision_v1[\s\S]*from public,anon,authenticated/i);
  assert.match(eventRuntime,/MAX_LIVE_ACTION_AGE_MS = 2 \* 60 \* 1000/);
  assert.match(eventRuntime,/rpc\/g3a_record_event_decision_v1/);
  assert.match(eventRuntime,/late_event_suppressed/);
  assert.match(deviceStatus,/body\.sessionStartedAt === undefined\s*\? null/);
  assert.match(deviceStatus,/body\.lastObservedAt === undefined\s*\? null/);
  assert.match(deviceStatus,/body\.lastUploadAt === undefined\s*\? null/);
  assert.match(deviceStatus,/sessionStartedAt === undefined \|\| lastObservedAt === undefined \|\| lastUploadAt === undefined/);
});

test('stable feed and DB snapshot are strictly allowlisted',async()=>{
  const release=await loadStableAgentRelease();
  assert.match(release.version,/^\d+\.\d+\.\d+\.\d+$/);
  const snapshot=sanitizeAgentRolloutSnapshot({
    generatedAt:'2026-08-24T00:00:00Z',scope:'workspace',
    devices:[{workspaceId:'11111111-1111-4111-8111-111111111111',workspaceName:'테스트',workspaceSlug:'test',deviceId:'22222222-2222-4222-8222-222222222222',displayName:'방송 PC',agentVersion:release.version,connectionState:'online',recentExecutionCount:2,succeededCount:1,failedCount:1,pendingCount:0,consecutiveFailureCount:1,latestExecution:{id:'33333333-3333-4333-8333-333333333333',deviceId:'22222222-2222-4222-8222-222222222222',workspaceId:'11111111-1111-4111-8111-111111111111',workspaceName:'테스트',status:'succeeded',actionType:'raffle.overlay',attemptNo:1,createdAt:'2026-08-24T00:00:00Z'},secretHash:'must-not-pass'}],
    recentExecutions:[]
  },release);
  assert.equal(snapshot.devices.length,1);
  assert.equal(snapshot.devices[0].agentVersion,release.version);
  assert.equal('secretHash' in snapshot.devices[0],false);
  assert.equal(snapshot.collectionHealth.status,'unknown');
});

test('core dashboard reports central SOOP collection separately from the wallpaper Agent',async()=>{
  const release=await loadStableAgentRelease();
  const workspaceId='11111111-1111-4111-8111-111111111111';
  const snapshot=sanitizeAgentRolloutSnapshot({generatedAt:new Date().toISOString(),scope:'workspace',devices:[{
    workspaceId,workspaceName:'테스트',workspaceSlug:'test',deviceId:'22222222-2222-4222-8222-222222222222',
    displayName:'방송 PC',agentVersion:release.version,connectionState:'online'
  }],recentExecutions:[]},release,{controls:[{workspace_id:workspaceId,gateway_enabled:true,core_collection_enabled:true}],sessions:[{
    workspace_id:workspaceId,state:'waiting_for_live',heartbeat_at:new Date().toISOString(),last_event_at:null
  }]});
  assert.equal(snapshot.coreCollection.enabledCount,1);
  assert.equal(snapshot.coreCollection.healthyCount,1);
  assert.equal(snapshot.coreCollection.gateways[0].health,'waiting_for_live');
  assert.equal(snapshot.coreCollection.gateways[0].workspaceName,'테스트');
});
