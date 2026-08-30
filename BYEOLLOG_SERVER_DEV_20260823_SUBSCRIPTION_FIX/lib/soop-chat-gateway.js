import crypto from 'node:crypto';
import {normalizeSoopSdkRelayEnvelope,SOOP_SDK_RELAY_SCHEMA_VERSION} from './soop-sdk-relay.js';

const SOOP_DONATION_ACTION_LABELS=Object.freeze({
  BALLOON_GIFTED:'별풍선',
  BATTLE_MISSION_GIFTED:'대결미션',
  CHALLENGE_MISSION_GIFTED:'도전미션',
  // SOOP emits this packet when balloons are added to an already-running
  // challenge mission.  It carries the same donor/count/image fields as the
  // initial CHALLENGE_MISSION_GIFTED packet and is a real donation event.
  CHALLENGE_MISSION_SPONSORS:'도전미션'
});
const DONATION_ACTIONS=new Set(Object.keys(SOOP_DONATION_ACTION_LABELS));
const ACTIONS=new Set(['MESSAGE','MANAGER_MESSAGE',...DONATION_ACTIONS]);

function clean(value,max){
  const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim();
  return text&&text.length<=max?text:'';
}

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value){return crypto.createHash('sha256').update(String(value),'utf8').digest('hex')}

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
  if(!message||typeof message!=='object'||Array.isArray(message))throw new Error('SOOP SDK message payload is invalid');
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
  const message=input.message;
  if(!message||typeof message!=='object'||Array.isArray(message)){
    return {kind:'ignored',action,reason:'invalid_payload'};
  }
  if(!clean(message.userId,180))return {kind:'ignored',action,reason:'missing_actor_id'};
  if(DONATION_ACTIONS.has(action)){
    const amount=Number(message.count);
    if(!Number.isSafeInteger(amount)||amount<1||amount>1_000_000_000_000){
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
