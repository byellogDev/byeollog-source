import crypto from 'node:crypto';
import {
  NativeRouletteValidationError,
  normalizeSoopChatEnvelope,
  normalizeSoopDonationEnvelope
} from './native-roulette.js';

export const SOOP_SDK_RELAY_SCHEMA_VERSION=1;
export const SOOP_SDK_RELAY_EVENT_TYPES=Object.freeze(['donation','chat']);
export const SOOP_SDK_SESSION_STATES=Object.freeze([
  'idle','connecting','waiting_for_live','connected','retry_wait','reauthorization_required'
]);

export function soopSdkReconnectDelayMs(attempt){
  const value=Math.max(0,Math.min(10,Math.trunc(Number(attempt)||0)));
  return Math.min(30_000,1_000*(2**value));
}

// Pure lifecycle reducer shared by the future SDK worker and the offline test
// harness.  A channel being offline is deliberately not treated as an OAuth
// failure, and transient disconnects never force the streamer to reconnect.
export function reduceSoopSdkSession(current={},event={}){
  const status=SOOP_SDK_SESSION_STATES.includes(current.status)?current.status:'idle';
  const reconnectCount=Math.max(0,Math.trunc(Number(current.reconnectCount)||0));
  const retryAttempt=Math.max(0,Math.trunc(Number(current.retryAttempt)||0));
  const base={status,reconnectCount,retryAttempt,nextRetryMs:null,lastReason:null};
  switch(String(event.type||'')){
    case 'connect_requested':return {...base,status:'connecting'};
    case 'connected':return {...base,status:'connected',retryAttempt:0};
    case 'broadcast_offline':return {...base,status:'waiting_for_live',retryAttempt:0,lastReason:'broadcast_offline'};
    case 'connection_closed':
    case 'temporary_error':{
      const nextAttempt=retryAttempt+1;
      return {...base,status:'retry_wait',reconnectCount:reconnectCount+1,retryAttempt:nextAttempt,nextRetryMs:soopSdkReconnectDelayMs(nextAttempt-1),lastReason:String(event.type)};
    }
    case 'authorization_failed':return {...base,status:'reauthorization_required',retryAttempt:0,lastReason:'authorization_failed'};
    case 'stopped':return {status:'idle',reconnectCount,retryAttempt:0,nextRetryMs:null,lastReason:'stopped'};
    default:return base;
  }
}

function requiredText(value,max,label){
  const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  if(!text||text.length>max)throw new NativeRouletteValidationError(`${label} 값이 올바르지 않습니다.`);
  return text;
}

function requiredIso(value,label){
  if(typeof value!=='string'||!value.trim()){
    throw new NativeRouletteValidationError(`${label} 값이 필요합니다.`);
  }
  const instant=new Date(value);
  if(!Number.isFinite(instant.getTime())){
    throw new NativeRouletteValidationError(`${label} 값이 올바르지 않습니다.`);
  }
  return instant.toISOString();
}

function requiredSha256(value,label){
  const text=requiredText(value,64,label).toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(text)){
    throw new NativeRouletteValidationError(`${label} 값이 올바르지 않습니다.`);
  }
  return text;
}

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object'){
    return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function soopSdkRelayEventFingerprint(event){
  const canonical={
    eventType:event.eventType,
    eventId:event.event.eventId,
    actor:event.event.actor,
    amount:event.event.amount??null,
    donationTypeLabel:event.event.donationTypeLabel??null,
    message:event.event.message,
    ceremonyImageUrl:event.event.ceremonyImageUrl??null,
    occurredAt:event.event.occurredAt
  };
  return crypto.createHash('sha256').update(stableJson(canonical),'utf8').digest('hex');
}

// This is the stable boundary between the approved SOOP SDK adapter and the
// server.  Provider-specific field names must be mapped explicitly in the
// Agent adapter; the server deliberately does not guess aliases.
export function normalizeSoopSdkRelayEnvelope(input={}){
  if(input.schemaVersion!==SOOP_SDK_RELAY_SCHEMA_VERSION){
    throw new NativeRouletteValidationError('SOOP SDK 전달 규격 버전이 올바르지 않습니다.','invalid_soop_relay_schema');
  }
  if(input.provider!=='soop'){
    throw new NativeRouletteValidationError('SOOP SDK 제공자 값이 올바르지 않습니다.','invalid_soop_relay_provider');
  }
  if(!SOOP_SDK_RELAY_EVENT_TYPES.includes(input.eventType)){
    throw new NativeRouletteValidationError('SOOP SDK 이벤트 종류가 올바르지 않습니다.','invalid_soop_relay_event_type');
  }
  const connection=input.connection;
  if(!connection||typeof connection!=='object'||Array.isArray(connection)){
    throw new NativeRouletteValidationError('SOOP SDK 연결 정보가 필요합니다.');
  }
  const sequence=Number(connection.sequence);
  if(!Number.isSafeInteger(sequence)||sequence<0){
    throw new NativeRouletteValidationError('SOOP SDK 연결 순번이 올바르지 않습니다.');
  }
  const receivedAt=requiredIso(input.receivedAt,'별록 수신 시각');
  const rawPayloadSha256=requiredSha256(input.rawPayloadSha256,'SOOP 원본 이벤트 확인값');
  const event=input.eventType==='donation'
    ?normalizeSoopDonationEnvelope(input.event)
    :normalizeSoopChatEnvelope(input.event);
  const normalized={
    schemaVersion:SOOP_SDK_RELAY_SCHEMA_VERSION,
    provider:'soop',
    eventType:input.eventType,
    event,
    receivedAt,
    connection:{
      id:requiredText(connection.id,160,'SOOP SDK 연결 ID'),
      sequence,
      reconnectCount:Number.isSafeInteger(connection.reconnectCount)&&connection.reconnectCount>=0
        ?connection.reconnectCount
        :0
    },
    rawPayloadSha256
  };
  return {...normalized,eventFingerprint:soopSdkRelayEventFingerprint(normalized)};
}
