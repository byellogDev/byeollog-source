import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {
  assertSoopGatewayOwnership,issueSoopGatewayLease,verifySoopGatewayLease
} from '../lib/soop-gateway-lease.js';

const env={SOOP_GATEWAY_INGRESS_SECRET:'ownership-secret-123456789012345678901234567890'};
const workspaceId='10000000-0000-4000-8000-000000000001';

test('server lease binds workspace, gateway instance and canonical broadcaster',()=>{
  const leaseToken=issueSoopGatewayLease({workspaceId,broadcasterId:'Streamer01',instanceId:'gateway-a',expiresAt:20_000},env);
  const claims=verifySoopGatewayLease(leaseToken,env,{now:10_000});
  assert.deepEqual(claims,{workspaceId,broadcasterId:'streamer01',instanceId:'gateway-a',expiresAt:20_000});
  assert.deepEqual(assertSoopGatewayOwnership({body:{workspaceId,instanceId:'gateway-a',room:{bjId:'STREAMER01',chatNumber:43120}},claims,requireRoom:true}),{
    workspaceId,instanceId:'gateway-a',broadcasterId:'streamer01',room:{broadcasterId:'streamer01',chatNumber:43120}
  });
});

test('lease rejects tampering, expiry, wrong workspace, instance and room owner',()=>{
  const leaseToken=issueSoopGatewayLease({workspaceId,broadcasterId:'streamer01',instanceId:'gateway-a',expiresAt:20_000},env);
  assert.throws(()=>verifySoopGatewayLease(`${leaseToken}x`,env,{now:10_000}),error=>error.code==='soop_gateway_lease_invalid');
  assert.throws(()=>verifySoopGatewayLease(leaseToken,env,{now:20_000}),error=>error.code==='soop_gateway_lease_expired');
  const claims=verifySoopGatewayLease(leaseToken,env,{now:10_000});
  assert.throws(()=>assertSoopGatewayOwnership({body:{workspaceId:'20000000-0000-4000-8000-000000000002',instanceId:'gateway-a',room:{bjId:'streamer01',chatNumber:1}},claims,requireRoom:true}),error=>error.code==='soop_gateway_lease_scope_mismatch');
  assert.throws(()=>assertSoopGatewayOwnership({body:{workspaceId,instanceId:'gateway-b',room:{bjId:'streamer01',chatNumber:1}},claims,requireRoom:true}),error=>error.code==='soop_gateway_lease_scope_mismatch');
  assert.throws(()=>assertSoopGatewayOwnership({body:{workspaceId,instanceId:'gateway-a',room:{bjId:'other',chatNumber:1}},claims,requireRoom:true}),error=>error.code==='soop_room_owner_mismatch');
  assert.throws(()=>assertSoopGatewayOwnership({body:{workspaceId,instanceId:'gateway-a'},claims,requireRoom:true}),error=>error.code==='soop_room_identity_missing');
});

test('database fence covers global event ownership, room uniqueness and wallpaper asset provenance',async()=>{
  const sql=await readFile(new URL('../supabase/migrations/20260907013000_enforce_soop_workspace_ownership.sql',import.meta.url),'utf8');
  const finalize=await readFile(new URL('../supabase/migrations/20260907013100_retire_unattested_soop_ingest.sql',import.meta.url),'utf8');
  const indexSql=await readFile(new URL('../supabase/migrations/20260907013200_index_soop_event_ownership_workspace.sql',import.meta.url),'utf8');
  assert.match(sql,/primary key check\(event_fingerprint~'\^\[0-9a-f\]\{64\}\$'\)/i);
  assert.match(sql,/pg_advisory_xact_lock[\s\S]+soop-event-owner/i);
  assert.match(sql,/return 'conflict'/i);
  assert.match(sql,/one_live_bj_idx[\s\S]+where state='connected'/i);
  assert.match(sql,/one_live_room_idx[\s\S]+where state='connected'/i);
  assert.match(sql,/record_wallpaper_donation_v5[\s\S]+byeollog_soop_event_ownership/i);
  assert.match(sql,/ingest_soop_external_roulette_result_v3[\s\S]+byeollog_soop_event_ownership/i);
  assert.match(sql,/lower\(workspace\.soop_id\)=donation\.source_bj_id/i);
  assert.match(sql,/foreign key\(workspace_id,donation_event_id\)/i);
  assert.match(sql,/sync_approved_signup_soop_identity_v1/i);
  assert.match(finalize,/revoke all on function public\.ingest_soop_core_donation_v1[\s\S]+from service_role/i);
  assert.match(finalize,/revoke all on function public\.ingest_soop_external_roulette_result_v2[\s\S]+from service_role/i);
  assert.match(indexSql,/byeollog_soop_event_ownership_workspace_idx[\s\S]+\(workspace_id\)/i);
});
