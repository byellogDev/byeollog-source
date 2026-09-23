import crypto from 'node:crypto';
import {normalizeSoopSdkRelayEnvelope,SOOP_SDK_RELAY_SCHEMA_VERSION} from './soop-sdk-relay.js';
import {isPotentialExternalRouletteResultMessage,isTrustedExternalRouletteAuthor} from './soop-external-roulette.js';
import {SOOP_DONATION_MAX_BALLOONS} from './native-roulette.js';

const SOOP_DONATION_ACTION_LABELS=Object.freeze({
  BALLOON_GIFTED:'별풍선',
  ADBALLOON_GIFTED:'애드벌룬',
  BATTLE_MISSION_GIFTED:'대결미션',
  CHALLENGE_MISSION_GIFTED:'도전미션'
});
const DONATION_ACTIONS=new Set(Object.keys(SOOP_DONATION_ACTION_LABELS));
// The official SDK exposes CHALLENGE_MISSION_SPONSORS as an aggregate
// `userList`, not as a new single donation. Re-ingesting it would duplicate
// CHALLENGE_MISSION_GIFTED and its payload has no top-level donor identity.
const AGGREGATE_SUMMARY_ACTIONS=new Set(['CHALLENGE_MISSION_SPONSORS']);
const ACTIONS=new Set(['MESSAGE','MANAGER_MESSAGE',...DONATION_ACTIONS,...AGGREGATE_SUMMARY_ACTIONS]);

export const SOOP_GATEWAY_HEARTBEAT_POLICY=Object.freeze({
  checkMs:15_000,
  connectedMs:60_000,
  offlineMs:300_000
});

export function isSoopGatewayLeaseExpiredError(error){
  return String(error?.code||'').trim().toLowerCase()==='soop_gateway_lease_expired';
}

// The current SOOP Chat SDK reports an idle channel as error 104 with an
// English message instead of the older invalid-chat-info/broadcast wording.
// Treat every known representation as a normal offline state so an idle
// workspace does not enter the transient-failure retry path.
export function isSoopBroadcastOfflineError(value={}){
  const code=String(value?.code??value?.errorCode??'').trim().toLowerCase();
  const message=String(value?.message??value?.errorMessage??value??'').slice(0,4_000);
  return code==='104'||code==='broadcast_offline'||/invalid[-_ ]?chat[-_ ]?info/i.test(code)
    ||/there are no streams currently in progress(?:\.\s*\(104\))?/i.test(message)
    ||/invalid[-_ ]?chat[-_ ]?info|broadcast(?:\s+is)?\s+offline|방송[^\n]{0,40}(?:없|종료|오프라인)/i.test(message);
}

// Heartbeats are operational telemetry, not part of the donation/action hot
// path.  State or error transitions must still cross the server boundary on
// the next local check; only an unchanged steady state is coalesced.
export function shouldSendSoopGatewayHeartbeat({
  now=Date.now(),lastHeartbeatAt=0,reportedState,lastHeartbeatState,
  lastErrorCode=null,lastHeartbeatError=null
}={}){
  if(reportedState!==lastHeartbeatState||lastErrorCode!==lastHeartbeatError)return true;
  const instant=Number(now),previous=Number(lastHeartbeatAt);
  if(!Number.isFinite(instant)||!Number.isFinite(previous)||previous<=0)return true;
  const interval=reportedState==='connected'
    ?SOOP_GATEWAY_HEARTBEAT_POLICY.connectedMs
    :SOOP_GATEWAY_HEARTBEAT_POLICY.offlineMs;
  return instant-previous>=interval;
}

function clean(value,max){
  const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  return text&&text.length<=max?text:'';
}

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export const SOOP_GATEWAY_SIGNATURE_TOLERANCE_MS=5*60_000;

export function signSoopGatewayRequest({secret,timestamp,nonce,body}={}){
  const normalizedSecret=String(secret||'');
  const normalizedTimestamp=String(timestamp||'');
  const normalizedNonce=String(nonce||'');
  if(normalizedSecret.length<32||!/^[0-9]{10,16}$/.test(normalizedTimestamp)||!/^[a-f0-9]{32,64}$/i.test(normalizedNonce))return '';
  return crypto.createHmac('sha256',normalizedSecret)
    .update(`${normalizedTimestamp}\n${normalizedNonce}\n${stableJson(body)}`,'utf8').digest('hex');
}

export function verifySoopGatewayRequestSignature({secret,timestamp,nonce,signature,body,now=Date.now(),toleranceMs=SOOP_GATEWAY_SIGNATURE_TOLERANCE_MS}={}){
  const instant=Number(timestamp),current=Number(now),tolerance=Math.max(1_000,Number(toleranceMs)||SOOP_GATEWAY_SIGNATURE_TOLERANCE_MS);
  if(!Number.isFinite(instant)||!Number.isFinite(current)||Math.abs(current-instant)>tolerance)return false;
  const expected=signSoopGatewayRequest({secret,timestamp:String(timestamp),nonce,body});
  const supplied=String(signature||'').trim().toLowerCase();
  if(!expected||!/^[a-f0-9]{64}$/.test(supplied))return false;
  const left=Buffer.from(expected,'hex'),right=Buffer.from(supplied,'hex');
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}

function sha256(value){return crypto.createHash('sha256').update(String(value),'utf8').digest('hex')}

export function stableSoopGatewayStaggerMs(seed,maxMs){
  const ceiling=Math.max(0,Math.min(30_000,Math.trunc(Number(maxMs)||0)));
  if(ceiling===0)return 0;
  return Number.parseInt(sha256(seed).slice(0,8),16)%(ceiling+1);
}

function eventInstant(message,receivedAt){
  const candidates=[message?.occurredAt,message?.createdAt,message?.sentAt,message?.timestamp,message?.messageTime];
  for(const candidate of candidates){
    let instant;
    if(typeof candidate==='number'&&Number.isFinite(candidate))instant=new Date(candidate<10_000_000_000?candidate*1000:candidate);
    else if(typeof candidate==='string'&&candidate.trim())instant=new Date(candidate);
    if(instant&&Number.isFinite(instant.getTime()))return {value:instant.toISOString(),source:'provider'};
  }
  return {value:receivedAt,source:'gateway_receive'};
}

function explicitEventId(message){
  return clean(message?.eventId??message?.messageId??message?.chatId??message?.transactionId??message?.id,180);
}

function ceremonyImageDiagnostic(message,normalizedUrl){
  const raw=clean(message?.imageUrl,2048);
  let scheme='missing',hostname=null;
  if(raw){
    if(raw.startsWith('/')&&!raw.startsWith('//')){
      scheme='relative';
      hostname='res.sooplive.com';
    }else try{
      const candidate=raw.startsWith('//')?'https:'+raw:raw;
      const parsed=new URL(candidate);
      scheme=parsed.protocol.replace(':','').toLowerCase()||'unknown';
      hostname=clean(parsed.hostname.toLowerCase(),253)||null;
    }catch{scheme='invalid'}
  }
  return {
    fieldPresent:Object.prototype.hasOwnProperty.call(message,'imageUrl'),
    valuePresent:Boolean(raw),accepted:Boolean(normalizedUrl),scheme,hostname
  };
}

export function normalizeSoopChatSdkCallback({action,message,receivedAt,connection}={}){
  const eventAction=clean(action,40).toUpperCase();
  if(!ACTIONS.has(eventAction))return null;
  if(AGGREGATE_SUMMARY_ACTIONS.has(eventAction))return null;
  if(!message||typeof message!=='object'||Array.isArray(message))throw new Error('SOOP SDK message payload is invalid');
  if(eventAction==='ADBALLOON_GIFTED'&&(message.fromVod===true||message.fromStation===true))return null;
  const receiveInstant=new Date(receivedAt||Date.now());
  if(!Number.isFinite(receiveInstant.getTime()))throw new Error('SOOP SDK receive time is invalid');
  const receivedIso=receiveInstant.toISOString();
  const sequence=Number(connection?.sequence);
  if(!Number.isSafeInteger(sequence)||sequence<0)throw new Error('SOOP SDK sequence is invalid');
  const connectionId=clean(connection?.id,160);
  if(!connectionId)throw new Error('SOOP SDK connection id is invalid');
  const actorId=clean(message.userId,180).toLocaleLowerCase('en-US');
  if(!actorId)throw new Error('SOOP SDK actor id is missing');
  const actorName=clean(message.userNickname,120)||actorId;
  const providerTime=eventInstant(message,receivedIso);
  const providerId=explicitEventId(message);
  const rawPayloadSha256=sha256(stableJson({action:eventAction,message}));
  const eventId=providerId||`sdk:${connectionId}:${sequence}`;
  const eventType=DONATION_ACTIONS.has(eventAction)?'donation':'chat';
  const event=eventType==='donation'
    ?{eventId,actor:{id:actorId,name:actorName},amount:Number(message.count),donationTypeLabel:SOOP_DONATION_ACTION_LABELS[eventAction],message:null,imageUrl:clean(message.imageUrl,2048)||null,occurredAt:providerTime.value}
    :{eventId,actor:{id:actorId,name:actorName},message:clean(message.message,300),occurredAt:providerTime.value};
  const relay=normalizeSoopSdkRelayEnvelope({
    schemaVersion:SOOP_SDK_RELAY_SCHEMA_VERSION,provider:'soop',eventType,event,
    receivedAt:receivedIso,
    connection:{id:connectionId,sequence,reconnectCount:Math.max(0,Math.trunc(Number(connection?.reconnectCount)||0))},
    rawPayloadSha256
  });
  const imageDiagnostic=eventType==='donation'?ceremonyImageDiagnostic(message,relay.event.ceremonyImageUrl):null;
  return {
    relay,
    metadata:{
      action:eventAction,
      occurredAtSource:providerTime.source,
      explicitEventId:Boolean(providerId),
      ...(imageDiagnostic?{ceremonyImage:imageDiagnostic}:{}),
      replaySignature:sha256(stableJson({action:eventAction,message}))
    }
  };
}

// The Chat SDK also emits presence, moderation and system packets through the
// same callback.  Keep strict normalization for accepted content, but classify
// unusable packets before they can become delivery failures.  In particular,
// chats without a provider user id cannot be correlated with a donation and
// must never be assigned an invented identity.
export function classifySoopChatSdkCallback(input={}){
  const action=clean(input.action,40).toUpperCase();
  if(!ACTIONS.has(action))return {kind:'ignored',action,reason:'unsupported_action'};
  if(AGGREGATE_SUMMARY_ACTIONS.has(action)){
    return {kind:'ignored',action,reason:'aggregate_mission_sponsor_summary'};
  }
  const message=input.message;
  if(!message||typeof message!=='object'||Array.isArray(message)){
    return {kind:'ignored',action,reason:'invalid_payload'};
  }
  // VOD/station packets announce an earlier gift when its sender enters live.
  // They are not a new gift in the current broadcast.
  if(action==='ADBALLOON_GIFTED'&&(message.fromVod===true||message.fromStation===true)){
    return {kind:'ignored',action,reason:'historical_adballoon_announcement'};
  }
  if(!clean(message.userId,180))return {kind:'ignored',action,reason:'missing_actor_id'};
  if(DONATION_ACTIONS.has(action)){
    const amount=Number(message.count);
    if(!Number.isSafeInteger(amount)||amount<1||amount>SOOP_DONATION_MAX_BALLOONS){
      return {kind:'ignored',action,reason:'invalid_donation_amount'};
    }
  }else if(!clean(message.message,300)){
    return {kind:'ignored',action,reason:'missing_chat_message'};
  }
  try{return {kind:'event',action,value:normalizeSoopChatSdkCallback({...input,action})}}
  catch(error){return {kind:'ignored',action,reason:clean(error?.code,120)||'invalid_content'}}
}

export class SoopGatewayReplayGuard{
  constructor({ttlMs=15_000,maxEntries=10_000}={}){
    this.ttlMs=Math.max(1_000,Math.min(120_000,Math.trunc(ttlMs)));
    this.maxEntries=Math.max(100,Math.min(100_000,Math.trunc(maxEntries)));
    this.entries=new Map();
  }
  check({signature,connectionId,explicitEventId=false,now=Date.now()}){
    const key=clean(signature,128),connection=clean(connectionId,160);
    if(!key||!connection)throw new Error('SOOP replay identity is invalid');
    for(const [entryKey,entry] of this.entries){if(now-entry.at>this.ttlMs)this.entries.delete(entryKey)}
    const previous=this.entries.get(key);
    const duplicate=Boolean(previous&&(explicitEventId||previous.connectionId!==connection)&&now-previous.at<=this.ttlMs);
    this.entries.set(key,{connectionId:connection,at:now});
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
    return duplicate;
  }
}

// The server only uses chat packets to capture the short donor follow-up
// message associated with a donation.  Forwarding every room message makes
// unrelated viewer chat dominate the hot path, so the gateway keeps a bounded
// local donor window and only relays chats that can still be relevant.  The
// donation itself is armed synchronously before any network await, keeping the
// donation/action path immediate.
export class SoopRelevantChatGate{
  constructor({windowMs=120_000,maxEntries=5_000}={}){
    this.windowMs=Math.max(15_000,Math.min(300_000,Math.trunc(Number(windowMs)||120_000)));
    this.maxEntries=Math.max(100,Math.min(100_000,Math.trunc(Number(maxEntries)||5_000)));
    this.entries=new Map();
  }
  #keys(actor={}){
    const id=clean(actor.id,180).toLocaleLowerCase('en-US');
    const name=clean(actor.name,120).toLocaleLowerCase('ko-KR');
    return [...new Set([id&&`id:${id}`,name&&`name:${name}`].filter(Boolean))];
  }
  #prune(now){
    for(const [key,expiresAt] of this.entries){if(expiresAt<now)this.entries.delete(key)}
    while(this.entries.size>this.maxEntries)this.entries.delete(this.entries.keys().next().value);
  }
  arm(actor,{now=Date.now()}={}){
    const instant=Number(now);
    if(!Number.isFinite(instant))throw new Error('SOOP donor window time is invalid');
    this.#prune(instant);
    const expiresAt=instant+this.windowMs;
    for(const key of this.#keys(actor))this.entries.set(key,expiresAt);
  }
  shouldForward(actor,{now=Date.now()}={}){
    const instant=Number(now);
    if(!Number.isFinite(instant))throw new Error('SOOP chat window time is invalid');
    this.#prune(instant);
    return this.#keys(actor).some(key=>(this.entries.get(key)||0)>=instant);
  }

  shouldForwardEvent(event,{now=Date.now(),broadcasterId}={}){
    if(event?.relay?.eventType!=='chat')return false;
    if(isPotentialExternalRouletteResultMessage(event.relay.event.message))return isTrustedExternalRouletteAuthor(event.relay.event.actor.id,broadcasterId);
    return this.shouldForward(event.relay.event.actor,{now});
  }
}
