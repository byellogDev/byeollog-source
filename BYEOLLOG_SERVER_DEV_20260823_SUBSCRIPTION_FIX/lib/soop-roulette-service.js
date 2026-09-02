import crypto from 'node:crypto';
import {getCommonOverlayV8Html} from './common-overlay-v8.js';
import {NATIVE_ROULETTE_ASSET_BY_KEY,nativeRouletteAssetPublicUrl} from './native-roulette-assets.js';
import {rouletteAssetPublicUrl} from './roulette-custom-assets.js';
import {NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,normalizeSoopCeremonyImageUrl,unicodeGraphemes} from './native-roulette.js';
import {hydrateSignatureAssetPreview} from './signature-balloon-assets.js';
import {sb} from './supabase-rest.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ROULETTE_OVERLAY_CLIENT_VERSION='20260902-common-overlay-v15-chat-dry-run-reveal';
export const SOOP_DEFAULT_CEREMONY_BASE_URL='https://res.sooplive.com/new_player/items/';

export function soopDefaultCeremonyImageUrl(amount){
  const count=Math.max(1,Math.trunc(Number(amount)||1));
  const file=count<=50?'ba_step2.png':count<=100?'ba_step3.png':count<=500?'ba_step4.png':count<=1000?'ba_step5.png':'ba_step6.png';
  return SOOP_DEFAULT_CEREMONY_BASE_URL+file;
}

export function rouletteOverlayUrl(token){
  return `/overlay/soop-roulette?v=${encodeURIComponent(ROULETTE_OVERLAY_CLIENT_VERSION)}#token=${encodeURIComponent(token)}`;
}

function serviceSecret(env=process.env){
  const raw=String(env.SOOP_GATEWAY_INGRESS_SECRET||'').trim();
  if(raw.length<32)throw Object.assign(new Error('roulette overlay secret is unavailable'),{code:'roulette_overlay_secret_missing',status:503});
  return crypto.createHash('sha256').update(`byeollog-roulette-overlay-v2|${raw}`,'utf8').digest();
}

function sign(value,env){return crypto.createHmac('sha256',serviceSecret(env)).update(value).digest('base64url')}
function ttsSign(value,env){return crypto.createHmac('sha256',serviceSecret(env)).update(`managed-overlay-tts-v1|${value}`).digest('base64url')}
function safeEqual(leftValue,rightValue){
  const left=Buffer.from(String(leftValue||'')),right=Buffer.from(String(rightValue||''));
  return left.length===right.length&&crypto.timingSafeEqual(left,right);
}

export function overlayTtsText(commandKind,payload){
  if(commandKind==='roulette_spin')return unicodeGraphemes(String(payload?.resultText||'').trim()).slice(0,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES).join('');
  if(commandKind==='donation_chat_tts')return String(payload?.ttsText||payload?.message||'').trim();
  return '';
}

export function createOverlayTtsAuthorization(workspaceId,clientId,commandId,attemptCount,text,{env=process.env,now=Date.now,ttlSeconds=300}={}){
  if(!UUID.test(String(workspaceId||''))||!UUID.test(String(commandId||''))||!/^[A-Za-z0-9._:-]{8,180}$/.test(String(clientId||''))||!Number.isSafeInteger(attemptCount)||attemptCount<1||attemptCount>20)throw new Error('invalid overlay TTS identity');
  const normalized=String(text||'').trim();if(!normalized||normalized.length>240)throw new Error('invalid overlay TTS text');
  const payload={v:1,wid:String(workspaceId).toLowerCase(),cid:String(clientId),oid:String(commandId).toLowerCase(),attempt:attemptCount,th:crypto.createHash('sha256').update(normalized,'utf8').digest('hex'),exp:Math.floor(now()/1000)+Math.max(30,Math.min(600,Number(ttlSeconds)||300))};
  const encoded=Buffer.from(JSON.stringify(payload),'utf8').toString('base64url');
  return `${encoded}.${ttsSign(encoded,env)}`;
}

export function verifyOverlayTtsAuthorization(token,text,{env=process.env,now=Date.now}={}){
  const [encoded,signature,extra]=String(token||'').split('.');
  if(!encoded||!signature||extra!==undefined||!safeEqual(signature,ttsSign(encoded,env)))return null;
  try{
    const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')),normalized=String(text||'').trim();
    if(payload?.v!==1||!UUID.test(String(payload.wid||''))||!UUID.test(String(payload.oid||''))||!/^[A-Za-z0-9._:-]{8,180}$/.test(String(payload.cid||''))||!Number.isSafeInteger(payload.attempt)||payload.attempt<1||payload.attempt>20||!Number.isSafeInteger(payload.exp)||payload.exp<Math.floor(now()/1000)||payload.exp>Math.floor(now()/1000)+600||normalized.length<1||normalized.length>240)return null;
    const hash=crypto.createHash('sha256').update(normalized,'utf8').digest('hex');
    return safeEqual(hash,payload.th)?payload:null;
  }catch{return null}
}

export function createRouletteServiceOverlayToken(workspaceId,tokenVersion,{env=process.env,nonce}={}){
  if(!UUID.test(String(workspaceId||''))||!UUID.test(String(tokenVersion||'')))throw new Error('invalid roulette overlay identity');
  const payload={v:2,wid:String(workspaceId).toLowerCase(),tv:String(tokenVersion).toLowerCase(),nonce:nonce||crypto.randomBytes(18).toString('base64url')};
  const encoded=Buffer.from(JSON.stringify(payload),'utf8').toString('base64url');
  return `${encoded}.${sign(encoded,env)}`;
}

export function verifyRouletteServiceOverlayToken(token,{env=process.env}={}){
  const [encoded,signature,extra]=String(token||'').split('.');
  if(!encoded||!signature||extra!==undefined)return null;
  const expected=sign(encoded,env),left=Buffer.from(signature),right=Buffer.from(expected);
  if(left.length!==right.length||!crypto.timingSafeEqual(left,right))return null;
  try{
    const payload=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    return payload?.v===2&&UUID.test(String(payload.wid||''))&&UUID.test(String(payload.tv||''))&&payload.nonce?payload:null;
  }catch{return null}
}

function first(value){return Array.isArray(value)?value[0]||null:null}

export async function validateRouletteOverlayService(payload,{sbImpl=sb}={}){
  if(!payload)return null;
  const rows=await sbImpl('byeollog_native_roulette_services',`?workspace_id=eq.${encodeURIComponent(payload.wid)}&select=state,overlay_token_version,service_revision,activation_snapshot&limit=1`);
  const service=first(rows);
  if(service?.state!=='active'||String(service.overlay_token_version).toLowerCase()!==String(payload.tv).toLowerCase())return null;
  return service;
}

export async function claimRouletteOverlayCommand(payload,clientId,{sbImpl=sb,env=process.env,preferredEventId=null}={}){
  const rows=await sbImpl('rpc/claim_native_roulette_overlay_v5','',{method:'POST',body:{
    p_workspace_id:payload.wid,p_token_version:payload.tv,
    p_client_id:clientId,p_preferred_event_id:preferredEventId,
    p_limit:1,p_lease_seconds:180
  }});
  const row=first(rows);
  if(!row)return {invalid:false,clientVersion:ROULETTE_OVERLAY_CLIENT_VERSION,command:null};
  const activationSnapshot=row.activation_snapshot||{};
  const commandPayload={...(row.payload||{})};
  commandPayload.eventId=row.event_id;
  commandPayload.eventOccurredAt=row.event_occurred_at;
  if(row.command_kind==='roulette_spin'||row.command_kind==='donation_ceremony'){
    commandPayload.followupChatTtsWindowSeconds=15;
  }
  if(row.command_kind==='roulette_spin'){
    commandPayload.resultText=unicodeGraphemes(String(commandPayload.resultText||'').trim()).slice(0,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES).join('');
    commandPayload.rouletteItems=(activationSnapshot.items||[]).map(item=>unicodeGraphemes(String(item?.resultText||'').trim()).slice(0,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES).join('')).filter(Boolean).slice(0,200);
  }
  if(commandPayload.customImage?.storagePath){
    commandPayload.customImage={...commandPayload.customImage,previewUrl:rouletteAssetPublicUrl(commandPayload.customImage.storagePath,env)};
  }
  commandPayload.ceremony=await resolveCeremonyForOverlay(payload.wid,commandPayload.ceremony,{amount:commandPayload.amount,sbImpl});
  const text=overlayTtsText(row.command_kind,commandPayload);
  if(row.command_kind==='roulette_spin')commandPayload.ttsText=text;
  const ttsAuthorization=text?createOverlayTtsAuthorization(payload.wid,clientId,row.command_id,row.attempt_count,text,{env}):null;
  return {invalid:false,clientVersion:ROULETTE_OVERLAY_CLIENT_VERSION,command:{id:row.command_id,kind:row.command_kind,payload:commandPayload,attemptCount:row.attempt_count,leaseExpiresAt:row.lease_expires_at,ttsAuthorization}};
}

export async function peekRouletteOverlayFollowup(payload,clientId,eventId,{sbImpl=sb}={}){
  if(!UUID.test(String(eventId||'')))return {invalid:true,peek:null};
  const rows=await sbImpl('rpc/peek_native_roulette_followup_v1','',{method:'POST',body:{
    p_workspace_id:payload.wid,p_token_version:payload.tv,
    p_client_id:clientId,p_event_id:String(eventId).toLowerCase()
  }});
  const row=first(rows);
  if(!row)return {invalid:false,peek:null};
  return {invalid:false,peek:{
    commandId:row.command_id,eventId:row.event_id,message:String(row.message||''),
    sourceKind:row.source_kind||null,capturedAt:row.captured_at||null
  }};
}

export async function claimOverlayTtsSynthesis(ttsPayload,{sbImpl=sb}={}){
  const rows=await sbImpl('rpc/claim_native_roulette_tts_v1','',{method:'POST',body:{
    p_workspace_id:ttsPayload.wid,p_command_id:ttsPayload.oid,p_client_id:ttsPayload.cid,
    p_overlay_attempt_count:ttsPayload.attempt,p_text_sha256:ttsPayload.th
  }});
  return first(rows)||null;
}

export async function finishOverlayTtsSynthesis(ttsPayload,requestId,result,{sbImpl=sb}={}){
  return sbImpl('rpc/finish_native_roulette_tts_v1','',{method:'POST',body:{
    p_workspace_id:ttsPayload.wid,p_command_id:ttsPayload.oid,p_overlay_attempt_count:ttsPayload.attempt,p_request_id:requestId,
    p_succeeded:Boolean(result.succeeded),p_provider:result.provider,p_first_audio_ms:result.succeeded?result.firstAudioMs:null,
    p_total_ms:result.succeeded?result.totalMs:null,p_audio_bytes:result.succeeded?result.audioBytes:null,
    p_error_code:result.succeeded?null:String(result.errorCode||'managed_tts_failed').slice(0,80)
  }});
}

export async function touchRouletteOverlayClient(payload,clientId,{sbImpl=sb}={}){
  const touched=await sbImpl('rpc/touch_native_roulette_overlay_client_v2','',{method:'POST',body:{p_workspace_id:payload.wid,p_token_version:payload.tv,p_client_id:clientId}});
  return {invalid:false,touched:Boolean(touched)};
}

export async function recordRouletteChatDryRun(payload,clientId,commandId,{sbImpl=sb}={}){
  const result=await sbImpl('rpc/record_native_roulette_chat_dry_run_v1','',{method:'POST',body:{
    p_workspace_id:payload.wid,p_token_version:payload.tv,
    p_command_id:commandId,p_client_id:clientId
  }});
  return {invalid:false,result};
}

export async function resolveCeremonyForOverlay(workspaceId,ceremony,{hydrate=hydrateSignatureAssetPreview,amount=1,sbImpl=sb}={}){
  const providerUrl=normalizeSoopCeremonyImageUrl(ceremony?.providerUrl||(ceremony?.source==='soop'?ceremony?.url:null));
  const defaultUrl=soopDefaultCeremonyImageUrl(amount);
  if(ceremony?.source==='signature'&&ceremony.asset?.storagePath){
    try{
      const image=await hydrate(workspaceId,ceremony.asset,'pc');
      return {source:'signature',url:image.previewUrl,providerFallbackUrl:providerUrl,defaultFallbackUrl:defaultUrl};
    }catch(error){console.error('[common-overlay] signature image unavailable',{name:error?.name||'Error',status:error?.status||null})}
  }
  if(providerUrl)return {source:'soop',url:providerUrl,providerFallbackUrl:null,defaultFallbackUrl:defaultUrl};
  try{
    const safeAmount=Math.max(1,Math.min(1_000_000,Math.trunc(Number(amount)||1)));
    const rows=await sbImpl('byeollog_default_donation_images',`?workspace_id=eq.${encodeURIComponent(workspaceId)}&min_amount=lte.${safeAmount}&max_amount=gte.${safeAmount}&select=pc_image&order=min_amount.desc&limit=1`);
    const custom=first(rows);
    if(custom?.pc_image?.storagePath){
      const image=await hydrate(workspaceId,custom.pc_image,'default-pc');
      return {source:'workspace_default',url:image.previewUrl,providerFallbackUrl:null,defaultFallbackUrl:defaultUrl};
    }
  }catch(error){console.error('[common-overlay] workspace default image unavailable',{name:error?.name||'Error',status:error?.status||null})}
  return {source:'soop_default',url:defaultUrl,providerFallbackUrl:null,defaultFallbackUrl:null};
}

export async function finishRouletteOverlayCommand(payload,clientId,commandId,succeeded,error,{sbImpl=sb}={}){
  const result=await sbImpl('rpc/finish_native_roulette_overlay_v4','',{method:'POST',body:{
    p_workspace_id:payload.wid,p_token_version:payload.tv,p_command_id:commandId,p_client_id:clientId,
    p_succeeded:succeeded,p_error:succeeded?null:String(error||'overlay playback failed').slice(0,1000)
  }});
  return {invalid:false,result};
}


const ASSET_MAP=Object.fromEntries(Object.values(NATIVE_ROULETTE_ASSET_BY_KEY).map(asset=>[
  asset.key,{previewUrl:asset.previewUrl,animationUrl:nativeRouletteAssetPublicUrl(asset),colors:asset.swatch,widthPx:asset.widthPx,heightPx:asset.heightPx}
]));

export function getRouletteServiceOverlayHtml(nonce){
  return getCommonOverlayV8Html(nonce,{assets:ASSET_MAP,clientVersion:ROULETTE_OVERLAY_CLIENT_VERSION});
}

export function publicPresentationImage(reference){
  return reference?.storagePath?rouletteAssetPublicUrl(reference.storagePath):null;
}
