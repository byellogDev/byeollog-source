import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const readRepositoryFile=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');

test('NCP SSH wrapper pins the deployment account, key fingerprint and host verification',async()=>{
  const wrapper=await readRepositoryFile('ops/ncp/Invoke-ByeollogNcpSsh.ps1');
  const runbook=await readRepositoryFile('ops/ncp/README.md');

  assert.match(wrapper,/NcpDeployUser='byeollog-deploy'/);
  assert.match(wrapper,/NcpServerHost='192\.0\.2\.20'/);
  assert.match(wrapper,/SHA256:87pnpFujlrMucFEv\/HRVOvfiVc8Ln6wXlvY3tU1OSHY/);
  assert.match(wrapper,/StrictHostKeyChecking=yes/);
  assert.match(wrapper,/BatchMode=yes/);
  assert.doesNotMatch(wrapper,/root@/i);
  assert.match(wrapper,/Only repository-owned ops\/ncp shell scripts may be streamed to NCP/);
  assert.match(wrapper,/sh -s --/);
  assert.match(runbook,/Invoke-ByeollogNcpSsh\.ps1/);
  assert.match(runbook,/`root`로 SSH 접속하지 않습니다/);
});

test('production isolation audit remains read-only, aggregate-only and covers ownership boundaries',async()=>{
  const wrapper=await readRepositoryFile('tools/Invoke-ProductionSoopIsolationAudit.ps1');
  const sql=await readRepositoryFile('tools/sql/audit_soop_workspace_isolation.sql');
  const fullHistorySql=await readRepositoryFile('tools/sql/audit_soop_workspace_isolation_full_history.sql');

  assert.match(wrapper,/supabase db query --linked --file/);
  assert.match(wrapper,/\[switch\]\$FullHistory/);
  assert.doesNotMatch(wrapper,/service_role|SUPABASE_SERVICE_ROLE_KEY/i);
  assert.doesNotMatch(sql,/\b(insert|update|delete|truncate|alter|drop)\b/i);
  assert.doesNotMatch(sql,/donor_name|nickname|message|access_token|refresh_token/i);
  assert.match(fullHistorySql,/begin transaction read only/i);
  assert.match(fullHistorySql,/rollback/i);
  assert.doesNotMatch(fullHistorySql,/\b(insert|update|delete|truncate|alter|drop)\b/i);
  assert.doesNotMatch(fullHistorySql,/actor_name|donor_name|nickname|message|access_token|refresh_token/i);

  for(const violation of [
    'observation_fingerprint_cross_workspace',
    'provider_event_cross_workspace',
    'donation_ownership_mismatch',
    'donation_broadcaster_mismatch',
    'result_ownership_mismatch',
    'result_donation_workspace_mismatch',
    'tile_donation_workspace_mismatch',
    'provider_asset_metadata_mismatch'
  ]){
    assert.match(sql,new RegExp(violation));
  }
});

test('workspace asset audit checks stored objects without exposing image paths or mutating data',async()=>{
  const sql=await readFile(new URL('../tools/sql/audit_workspace_asset_integrity_full_history.sql',import.meta.url),'utf8');
  assert.match(sql,/begin transaction read only/i);
  assert.match(sql,/set local statement_timeout='20s'/i);
  assert.match(sql,/storage\.objects/i);
  assert.match(sql,/missingStorageObject/);
  assert.match(sql,/crossWorkspaceReference/);
  assert.match(sql,/invalidProviderUrl/);
  assert.doesNotMatch(sql,/\b(?:insert|update|delete|truncate|alter|drop|create)\b/i);
  assert.match(sql,/select jsonb_build_object\([\s\S]+\) audit_result\s+from metrics;/i);
  assert.doesNotMatch(sql,/jsonb_agg|array_agg|string_agg/i);
});

test('lease deadline gateway deployment has a distinct backup and automatic rollback gate',async()=>{
  const deployment=await readRepositoryFile('ops/ncp/deploy-gateway-lease-deadline-20260907.sh');
  assert.match(deployment,/gateway-pre-\$\{stamp\}\.tar\.gz/);
  assert.match(deployment,/rollback-\$\{stamp\}/);
  assert.match(deployment,/trap rollback_on_failure EXIT HUP INT TERM/);
  assert.match(deployment,/chmod 644 "\$index_file"\s+patched=1\s+\n?grep -Fq/);
  assert.match(deployment,/activeLease\.providerTokenExpiresAt\|\|extra\.tokenExpiresAt/);
  assert.match(deployment,/BYEOLLOG_HEALTH_URL:-http:\/\/127\.0\.0\.1:47631\/healthz/);
  assert.match(deployment,/workspace_crashed\|reconcile_failed/);
  assert.match(deployment,/--self-test/);
  assert.match(deployment,/PASS isolated rollback and success deployment drill/);
});

test('operational observability audit is read-only and does not expose secret values',async()=>{
  const sql=await readRepositoryFile('tools/sql/audit_operational_observability.sql');
  assert.match(sql,/begin transaction read only/i);
  assert.match(sql,/rollback/i);
  assert.doesNotMatch(sql,/decrypted_secrets|decrypted_secret/i);
  assert.doesNotMatch(sql,/select\s+\*|actor_name|donor|payload|action_params/i);
  assert.match(sql,/blockedConflictsLast24h/i);
  assert.match(sql,/pendingOlderThan2m/i);
  assert.match(sql,/wallpaperReadyLast24h/i);
});

test('actual product path audit correlates only aggregate evidence and never mutates production',async()=>{
  const sql=await readRepositoryFile('tools/sql/audit_actual_product_path_last24h.sql');
  assert.match(sql,/begin transaction read only/i);
  assert.match(sql,/rollback/i);
  assert.match(sql,/source_event_fingerprint/);
  assert.match(sql,/wallpaper_ready/);
  assert.match(sql,/missingWallpaperTile/);
  assert.match(sql,/workspacesWithoutDisplayProof/);
  assert.doesNotMatch(sql,/jsonb_agg|array_agg|string_agg|actor_name|donor_name_hint|raw_message/i);
  assert.doesNotMatch(sql,/\b(?:insert|update|delete|truncate|alter|drop|create)\b/i);
});
