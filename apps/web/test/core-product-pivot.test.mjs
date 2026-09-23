import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {
  CORE_PRODUCT_SCOPE,legacyWeflabCollectorEnabled,legacyWeflabCollectorMode,
  legacyWeflabValidationWorkspaceAllowed,retiredRuntimeOperation
} from '../lib/core-product-scope.js';

const source=path=>readFile(new URL(path,import.meta.url),'utf8');

test('core scope keeps only wallpaper and upbo runtime features',()=>{
  assert.deepEqual(CORE_PRODUCT_SCOPE,{
    wallpaper:true,upbo:true,nativeRoulette:false,localActions:false,
    legacyWeflabCollector:false,weflabShadowValidation:true
  });
  assert.equal(legacyWeflabCollectorEnabled({}),false);
  assert.equal(legacyWeflabCollectorEnabled({LEGACY_WEFLAB_COLLECTOR_ENABLED:'true'}),true);
  assert.equal(legacyWeflabCollectorMode({LEGACY_WEFLAB_COLLECTOR_MODE:'shadow'}),'shadow');
  assert.equal(legacyWeflabCollectorMode({LEGACY_WEFLAB_COLLECTOR_MODE:'active'}),'active');
  assert.equal(legacyWeflabValidationWorkspaceAllowed('alpha',{
    LEGACY_WEFLAB_VALIDATION_WORKSPACE_IDS:'other, ALPHA'
  }),true);
  assert.equal(legacyWeflabValidationWorkspaceAllowed('alpha',{
    LEGACY_WEFLAB_VALIDATION_WORKSPACE_IDS:'other'
  }),false);
  assert.equal(retiredRuntimeOperation('soop-roulette-overlay-poll'),true);
  assert.equal(retiredRuntimeOperation('soop-wallpaper-state'),false);
});

test('core migration preserves history, cancels live actions, and installs service-only ingestion',async()=>{
  const sql=await source('../supabase/migrations/20260903190000_core_soop_collection_pivot.sql');
  assert.match(sql,/add column if not exists core_collection_enabled boolean not null default false/i);
  assert.match(sql,/update byeollog_automation\.rules[\s\S]*set enabled=false/i);
  assert.match(sql,/update byeollog_automation\.executions[\s\S]*status='cancelled'/i);
  assert.match(sql,/update byeollog_automation\.native_roulette_overlay_outbox_v2[\s\S]*status='failed'/i);
  assert.doesNotMatch(sql,/drop table|truncate table/i);
  for(const permanentTable of [
    'bangsel_donations','bangsel_tasks','byeollog_wallpaper_tiles',
    'byeollog_automation.rules','byeollog_automation.executions'
  ]){
    assert.doesNotMatch(sql,new RegExp(`delete\\s+from\\s+(?:public\\.)?${permanentTable.replace('.','\\.')}`,'i'));
  }
  assert.match(sql,/delete from public\.byeollog_soop_core_donations/i);
  assert.match(sql,/delete from public\.byeollog_soop_core_roulette_results/i);
  for(const fn of ['ingest_soop_core_donation_v1','ingest_soop_external_roulette_result_v1']){
    assert.match(sql,new RegExp(`revoke all on function public\\.${fn}`,'i'));
    assert.match(sql,new RegExp(`grant execute on function public\\.${fn}[\\s\\S]+to service_role`,'i'));
  }
  assert.match(sql,/Roulette bots normally post through the streamer account/i);
  assert.doesNotMatch(sql,/v_method:='actor_id'/i);
  assert.match(sql,/v_method:='unique_recent'/i);
  assert.match(sql,/v_method:='sequence_continuation'/i);
  assert.match(sql,/donation\.broadcast_key=btrim\(p_broadcast_key\)/i);
  assert.match(sql,/run_soop_core_correlation_retention_v1/i);
  assert.match(sql,/interval '30 days'/i);
});

test('legacy server collection stays retired and the Agent cannot opt back in',async()=>{
  const [collector,pair,devices,pairingCode,agentScope,vercelIgnore]=await Promise.all([
    source('../api/collector.js'),source('../api/collector-pair.js'),
    source('../api/collector-devices.js'),source('../api/collector-pairing-code.js'),
    source('../../BYEOLLOG_AGENT_DEV_v07022/CoreProductScope.cs'),source('../.vercelignore')
  ]);
  assert.match(collector,/legacy_weflab_collector_retired/);
  assert.match(pair,/legacy_weflab_collector_retired/);
  assert.match(pair,/mode==='core_agent'[\s\S]*connectCoreWallpaperAgent\(body,req\)[\s\S]*if\(!legacyWeflabCollectorEnabled\(\)\)/);
  assert.match(pair,/connectCoreWallpaperAgent[\s\S]*buildAccountAutomationFields\(body,account\)/);
  assert.doesNotMatch(pair,/connectCoreWallpaperAgent[\s\S]{0,2200}byeollog_rotate_collector_device_v1/);
  assert.match(devices,/legacy_weflab_collector_retired/);
  assert.match(pairingCode,/legacy_weflab_collector_retired/);
  assert.match(vercelIgnore,/^api\/collector-devices\.js$/m);
  assert.match(vercelIgnore,/^api\/collector-pairing-code\.js$/m);
  assert.match(collector,/shadow_validation/);
  assert.match(collector,/byeollog_weflab_shadow_events/);
  assert.doesNotMatch(agentScope,/BYEOLLOG_WEFLAB_SHADOW_VALIDATION/);
  assert.match(agentScope,/LocalActionExecutionEnabled => false/);
});

test('Weflab shadow ledger is service-only, bounded, and isolated from product processing',async()=>{
  const sql=await source('../supabase/migrations/20260903162217_add_weflab_shadow_validation_ledger.sql');
  assert.match(sql,/create table public\.byeollog_weflab_shadow_events/i);
  assert.match(sql,/enable row level security/i);
  assert.match(sql,/grant select,insert,update,delete[\s\S]+to service_role/i);
  assert.match(sql,/interval '45 days'/i);
  assert.doesNotMatch(sql,/bangsel_tasks|byeollog_wallpaper_tiles|processPendingCollectorRows/i);
});
