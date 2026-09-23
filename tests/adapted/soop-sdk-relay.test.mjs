import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeSoopSdkRelayEnvelope,
  reduceSoopSdkSession,
  soopSdkReconnectDelayMs,
  SOOP_SDK_RELAY_SCHEMA_VERSION
} from '../../apps/collector-runtime/lib/soop-sdk-relay.js';

function envelope(overrides={}){
  return {
    schemaVersion:SOOP_SDK_RELAY_SCHEMA_VERSION,
    provider:'soop',
    eventType:'donation',
    event:{
      eventId:'donation-001',actor:{id:'Viewer01',name:'시청자'},amount:33,
      message:'후원 메시지',occurredAt:'2026-08-28T01:00:00.123Z'
    },
    receivedAt:'2026-08-28T01:00:00.200Z',
    connection:{id:'sdk-session-1',sequence:42,reconnectCount:1},
    rawPayloadSha256:'a'.repeat(64),
    ...overrides
  };
}

test('approved SDK relay boundary normalizes donation identity and records forensic timing',()=>{
  const value=normalizeSoopSdkRelayEnvelope(envelope());
  assert.equal(value.provider,'soop');
  assert.equal(value.event.actor.id,'viewer01');
  assert.equal(value.event.amount,33);
  assert.equal(value.event.donationTypeLabel,'별풍선');
  assert.equal(value.receivedAt,'2026-08-28T01:00:00.200Z');
  assert.equal(value.connection.sequence,42);
  assert.match(value.eventFingerprint,/^[0-9a-f]{64}$/);
});

test('same provider event content has one fingerprint across reconnect delivery',()=>{
  const first=normalizeSoopSdkRelayEnvelope(envelope());
  const replay=normalizeSoopSdkRelayEnvelope(envelope({
    receivedAt:'2026-08-28T01:00:02.000Z',
    connection:{id:'sdk-session-2',sequence:0,reconnectCount:2},
    rawPayloadSha256:'b'.repeat(64)
  }));
  assert.equal(replay.eventFingerprint,first.eventFingerprint);
});

test('chat uses an explicit schema and provider aliases are never guessed',()=>{
  const chat=normalizeSoopSdkRelayEnvelope(envelope({
    eventType:'chat',
    event:{eventId:'chat-001',actor:{id:'Viewer01',name:'시청자'},message:'딸깍',occurredAt:'2026-08-28T01:00:01.000Z'}
  }));
  assert.equal(chat.event.message,'딸깍');
  assert.equal('amount' in chat.event,false);
  assert.throws(()=>normalizeSoopSdkRelayEnvelope({...envelope(),eventType:'gift'}),error=>error?.code==='invalid_soop_relay_event_type');
  assert.throws(()=>normalizeSoopSdkRelayEnvelope({...envelope(),schemaVersion:2}),error=>error?.code==='invalid_soop_relay_schema');
  assert.throws(()=>normalizeSoopSdkRelayEnvelope({...envelope(),provider:'afreeca'}),error=>error?.code==='invalid_soop_relay_provider');
  assert.throws(()=>normalizeSoopSdkRelayEnvelope(envelope({event:{...envelope().event,donationTypeLabel:'임의후원'}})),/후원 종류/);
});

test('relay requires provider time, receive time, connection sequence, and raw payload identity',()=>{
  assert.throws(()=>normalizeSoopSdkRelayEnvelope(envelope({receivedAt:null})),/수신 시각/);
  assert.throws(()=>normalizeSoopSdkRelayEnvelope(envelope({connection:{id:'x',sequence:-1}})),/연결 순번/);
  assert.throws(()=>normalizeSoopSdkRelayEnvelope(envelope({rawPayloadSha256:'not-a-hash'})),/확인값/);
  assert.throws(()=>normalizeSoopSdkRelayEnvelope(envelope({event:{...envelope().event,occurredAt:null}})),/후원 시각/);
});

test('offline broadcast waits safely without being mistaken for an OAuth failure',()=>{
  const connecting=reduceSoopSdkSession({}, {type:'connect_requested'});
  const waiting=reduceSoopSdkSession(connecting,{type:'broadcast_offline'});
  assert.equal(waiting.status,'waiting_for_live');
  assert.equal(waiting.retryAttempt,0);
  assert.equal(waiting.reconnectCount,0);
  assert.equal(waiting.lastReason,'broadcast_offline');
});

test('transient SDK disconnect uses capped backoff and preserves automatic recovery',()=>{
  let state={status:'connected',reconnectCount:0,retryAttempt:0};
  const delays=[];
  for(let index=0;index<8;index++){
    state=reduceSoopSdkSession(state,{type:'connection_closed'});
    delays.push(state.nextRetryMs);
  }
  assert.deepEqual(delays,[1000,2000,4000,8000,16000,30000,30000,30000]);
  assert.equal(state.reconnectCount,8);
  assert.equal(soopSdkReconnectDelayMs(99),30000);
  const recovered=reduceSoopSdkSession(state,{type:'connected'});
  assert.equal(recovered.status,'connected');
  assert.equal(recovered.retryAttempt,0);
  assert.equal(recovered.reconnectCount,8);
});

test('only an explicit authorization failure requires streamer reconnection',()=>{
  const transient=reduceSoopSdkSession({status:'connected'},{type:'temporary_error'});
  const denied=reduceSoopSdkSession(transient,{type:'authorization_failed'});
  assert.equal(transient.status,'retry_wait');
  assert.equal(denied.status,'reauthorization_required');
  assert.equal(denied.nextRetryMs,null);
});
