import crypto from 'node:crypto';
import {getCommonOverlayV8Html} from './common-overlay-v8.js';
import {NATIVE_ROULETTE_ASSET_BY_KEY,nativeRouletteAssetPublicUrl} from './native-roulette-assets.js';
import {rouletteAssetPublicUrl} from './roulette-custom-assets.js';
import {NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,normalizeSoopCeremonyImageUrl,unicodeGraphemes} from './native-roulette.js';
import {hydrateSignatureAssetPreview} from './signature-balloon-assets.js';
import {sb} from './supabase-rest.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const ROULETTE_OVERLAY_CLIENT_VERSION='20260830-common-overlay-v14-fixed-followup-queue';
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
  commandPayload.ceremony=await resolveCeremonyForOverlay(payload.wid,commandPayload.ceremony,{amount:commandPayload.amount});
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

export async function resolveCeremonyForOverlay(workspaceId,ceremony,{hydrate=hydrateSignatureAssetPreview,amount=1}={}){
  const providerUrl=normalizeSoopCeremonyImageUrl(ceremony?.providerUrl||(ceremony?.source==='soop'?ceremony?.url:null));
  const defaultUrl=soopDefaultCeremonyImageUrl(amount);
  if(ceremony?.source==='signature'&&ceremony.asset?.storagePath){
    try{
      const image=await hydrate(workspaceId,ceremony.asset,'pc');
      return {source:'signature',url:image.previewUrl,providerFallbackUrl:providerUrl,defaultFallbackUrl:defaultUrl};
    }catch(error){console.error('[common-overlay] signature image unavailable',{name:error?.name||'Error',status:error?.status||null})}
  }
  if(providerUrl)return {source:'soop',url:providerUrl,providerFallbackUrl:null,defaultFallbackUrl:defaultUrl};
  return {source:'soop_default',url:defaultUrl,providerFallbackUrl:null,defaultFallbackUrl:null};
}

export async function finishRouletteOverlayCommand(payload,clientId,commandId,succeeded,error,{sbImpl=sb}={}){
  const result=await sbImpl('rpc/finish_native_roulette_overlay_v4','',{method:'POST',body:{
    p_workspace_id:payload.wid,p_token_version:payload.tv,p_command_id:commandId,p_client_id:clientId,
    p_succeeded:succeeded,p_error:succeeded?null:String(error||'overlay playback failed').slice(0,1000)
  }});
  return {invalid:false,result};
}

function escapeHtml(value){return String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}

const ASSET_MAP=Object.fromEntries(Object.values(NATIVE_ROULETTE_ASSET_BY_KEY).map(asset=>[
  asset.key,{previewUrl:asset.previewUrl,animationUrl:nativeRouletteAssetPublicUrl(asset),colors:asset.swatch,widthPx:asset.widthPx,heightPx:asset.heightPx}
]));

function getRouletteServiceOverlayHtmlLegacy(nonce){
  const n=escapeHtml(nonce),assets=JSON.stringify(ASSET_MAP).replace(/</g,'\\u003c'),clientVersion=JSON.stringify(ROULETTE_OVERLAY_CLIENT_VERSION);
  const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>별록 룰렛 오버레이</title><style nonce="${n}">
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:Pretendard,"Noto Sans KR",system-ui,sans-serif;color:#fff}.stage{position:fixed;inset:0;display:grid;place-items:center;opacity:0;pointer-events:none;transition:opacity .16s}.stage.show{opacity:1}.veil{position:absolute;inset:0;background:radial-gradient(circle at 50% 47%,#07162c44,#0207118f 75%,#0000);backdrop-filter:blur(1px)}.rouletteGroup{position:absolute;inset:0;display:grid;place-items:center;padding:1.5vmin}.rouletteCard{width:min(97vw,calc((97vh - clamp(74px,10vh,118px))*1.7777778));filter:drop-shadow(0 18px 36px #000b)}.panel{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border:3px solid #102746;border-bottom:0;border-radius:14px 14px 0 0}.resultPanel{position:relative;width:100%}.visual{position:absolute;inset:0;display:grid;place-items:center;transition:opacity .2s}.presentation{display:block;width:100%;height:100%;object-fit:contain}.wheelWrap{position:relative;display:grid;place-items:center}.wheel{width:min(50vw,540px);aspect-ratio:1;border-radius:50%;border:13px solid #fff;box-shadow:0 0 0 7px #102746,0 0 58px #ffc44d82;position:relative;overflow:hidden}.wheel:after{content:"";position:absolute;inset:39%;border-radius:50%;background:#fff;border:8px solid #102746;box-shadow:0 4px 14px #0005}.pointer{position:absolute;top:-27px;left:50%;translate:-50% 0;width:0;height:0;border-left:24px solid transparent;border-right:24px solid transparent;border-top:55px solid #ffc44d;z-index:4;filter:drop-shadow(0 4px 2px #0006)}.spin{animation:spin 3s cubic-bezier(.12,.68,.14,1) forwards}.headline{position:absolute;left:50%;bottom:10.8%;translate:-50% 0;width:min(70vw,900px);text-align:center;font-size:clamp(23px,2.7vw,40px);font-weight:950;letter-spacing:-.045em;text-shadow:0 4px 15px #000}.sub{position:absolute;left:50%;bottom:7%;translate:-50% 0;color:#dbe7f5;font-size:clamp(13px,1.5vw,21px);font-weight:760;text-shadow:0 3px 10px #000}.slot{width:min(62vw,820px);padding:10px;border-radius:25px;background:linear-gradient(135deg,#0b1d38,#17395f);border:2px solid #ffffff6b;box-shadow:0 20px 55px #0009,0 0 32px #ffc44d30;transition:transform .2s,filter .2s}.slotInner{display:flex;align-items:center;gap:20px;min-height:112px;padding:18px 30px;border:4px solid #ffc44d;border-radius:17px;background:linear-gradient(180deg,#fff,#f5f8fc);overflow:hidden}.slotLabel{color:#c6870c;font-size:clamp(15px,1.6vw,23px);font-weight:950;white-space:nowrap}.slotValue{min-width:0;flex:1;overflow:hidden;color:#102746;font-size:clamp(28px,3.7vw,58px);font-weight:950;letter-spacing:-.045em;text-align:center;text-overflow:ellipsis;white-space:nowrap}.slotValue.tick{animation:slotTick .11s ease-out}.slot.winner{transform:scale(1.025);filter:drop-shadow(0 0 18px #ffc44d99)}.ceremony{position:absolute;inset:0;display:grid;place-items:center;opacity:0;scale:.94;transition:opacity .16s,scale .22s}.ceremony.show{opacity:1;scale:1}.ceremonyCard{display:grid;justify-items:center;width:min(58vw,820px)}.ceremonyImage{display:block;width:100%;height:min(58vh,560px);object-fit:contain;filter:drop-shadow(0 20px 38px #000b)}.ceremonyCaption{max-width:100%;margin-top:10px;padding:10px 18px;border-radius:999px;background:#102746e8;border:2px solid #ffc44d;color:#fff;font-size:clamp(18px,2.2vw,32px);font-weight:950;text-align:center;box-shadow:0 14px 30px #0007}.chat{position:absolute;left:50%;bottom:5%;translate:-50% 12px;min-width:min(80vw,760px);padding:18px 26px;border-radius:20px;background:#102746ef;border:2px solid #ffc44d;color:#fff;text-align:center;font-size:clamp(20px,2.4vw,34px);font-weight:850;opacity:0;transition:.22s}.chat.show{opacity:1;translate:-50% 0}.ready{display:none!important}.hidden{display:none!important}.rouletteCard .slot{width:100%;padding:0;border:3px solid #102746;border-top:0;border-radius:0 0 14px 14px;background:#fff;box-shadow:0 16px 40px #0009;transition:transform .2s,filter .2s}.rouletteCard .slotInner{min-height:clamp(74px,10vh,118px);padding:clamp(10px,1.4vh,16px) clamp(18px,2vw,30px);border:0;border-radius:0 0 11px 11px;background:#fff}.rouletteCard .slotLabel{padding:7px 11px;border-radius:8px;background:#ffc44d;color:#102746;font-size:clamp(16px,1.55vw,28px)}.rouletteCard .slotValue{color:#102746;font-size:clamp(28px,3vw,54px)}.headline,.sub{display:none}.rouletteCard.builtin{position:relative}.rouletteCard.builtin .resultPanel{position:absolute;left:27%;right:27%;bottom:13%;width:auto}.rouletteCard.builtin .slot{width:100%;border:0;border-radius:0;background:transparent;box-shadow:none}.rouletteCard.builtin .slotInner{min-height:0;padding:0;border:0;background:transparent}.rouletteCard.builtin .slotLabel{display:none}.rouletteCard.builtin .slotValue{color:#fff;font-size:clamp(38px,3vw,56px);text-shadow:0 3px 10px #000}@keyframes spin{from{transform:rotate(0)}to{transform:rotate(1440deg)}}@keyframes slotTick{from{opacity:.15;transform:translateY(-35%);filter:blur(3px)}to{opacity:1;transform:translateY(0);filter:blur(0)}}
</style></head><body><div id="stage" class="stage"><div class="veil"></div><div id="rouletteGroup" class="rouletteGroup hidden"><div id="rouletteCard" class="rouletteCard"><div id="panel" class="panel"><div id="visual" class="visual"><img id="presentation" class="presentation" alt=""><div id="fallback" class="wheelWrap hidden"><div class="pointer"></div><div id="wheel" class="wheel"></div></div></div><div id="headline" class="headline"></div><div id="sub" class="sub"></div></div><div id="resultPanel" class="resultPanel"><div id="slot" class="slot"><div class="slotInner"><span class="slotLabel">당첨 결과</span><strong id="slotValue" class="slotValue">룰렛 결과</strong></div></div></div></div></div><div id="ceremony" class="ceremony"><div class="ceremonyCard"><img id="ceremonyImage" class="ceremonyImage" alt="후원 세레모니"><div id="ceremonyCaption" class="ceremonyCaption"></div></div></div><div id="chat" class="chat"></div></div><div id="ready" class="ready" aria-hidden="true"></div><audio id="spinSound" preload="auto" src="/api/auth/soop/roulette-overlay/sound"></audio><script nonce="${n}">
(()=>{const $=id=>document.getElementById(id),assets=${assets},clientVersion=${clientVersion},params=new URLSearchParams(location.hash.slice(1)),suppliedToken=params.get('token')||'';if(suppliedToken)sessionStorage.setItem('byeollogOverlayToken',suppliedToken);const token=suppliedToken||sessionStorage.getItem('byeollogOverlayToken')||'';history.replaceState(null,'',location.pathname);const clientId=sessionStorage.getItem('byeollogOverlayClient')||crypto.randomUUID();sessionStorage.setItem('byeollogOverlayClient',clientId);const playedStorage='byeollogPlayedOverlayCommands';function loadPlayed(){try{return new Set(JSON.parse(sessionStorage.getItem(playedStorage)||'[]'))}catch{return new Set()}}const playedCommands=loadPlayed();function remember(id){playedCommands.add(id);const recent=[...playedCommands].slice(-64);playedCommands.clear();for(const value of recent)playedCommands.add(value);sessionStorage.setItem(playedStorage,JSON.stringify(recent))}function wasPlayed(id){return playedCommands.has(id)}let busy=false,stopped=false,claimedOnce=false,slotTimer=null,audioContext=null;const sleep=ms=>new Promise(r=>setTimeout(r,ms));function fallbackSpeak(text,volume){return new Promise(resolve=>{try{speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang='ko-KR';u.rate=1.12;u.volume=Math.max(0,Math.min(1,Number(volume??80)/100));let settled=false;const done=()=>{if(settled)return;settled=true;resolve()};u.onend=done;u.onerror=done;speechSynthesis.speak(u);setTimeout(done,Math.min(30000,3000+String(text||'').length*220))}catch{resolve()}})}function appendBytes(a,b){const joined=new Uint8Array(a.length+b.length);joined.set(a);joined.set(b,a.length);return joined}function schedulePcm(state,bytes){const usable=bytes.length-(bytes.length%2);if(!usable)return;const samples=usable/2,buffer=state.context.createBuffer(1,samples,24000),channel=buffer.getChannelData(0),view=new DataView(bytes.buffer,bytes.byteOffset,usable);for(let i=0;i<samples;i++)channel[i]=view.getInt16(i*2,true)/32768;const source=state.context.createBufferSource();source.buffer=buffer;source.connect(state.gain);state.nextAt=Math.max(state.nextAt,state.context.currentTime+.1);source.start(state.nextAt);state.nextAt+=buffer.duration;state.played=true}async function speak(command,text,volume){const normalized=String(text||'').trim();if(!normalized)return;if(!command.ttsAuthorization)return fallbackSpeak(normalized,volume);let streamed=false;try{audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});await audioContext.resume();const gain=audioContext.createGain();gain.gain.value=Math.max(0,Math.min(1,Number(volume??80)/100));gain.connect(audioContext.destination);const response=await fetch('/api/auth/soop/roulette-overlay/tts',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({commandId:command.id,text:normalized,authorization:command.ttsAuthorization}),cache:'no-store'});if(!response.ok||!response.body)throw new Error('managed tts unavailable');const reader=response.body.getReader(),state={context:audioContext,gain,nextAt:audioContext.currentTime+.1,played:false};let pending=new Uint8Array(0),completed=false,streamError=null;while(true){const read=await reader.read();if(read.value?.length)pending=appendBytes(pending,read.value);let offset=0;while(pending.length-offset>=5){const view=new DataView(pending.buffer,pending.byteOffset+offset,pending.length-offset),type=view.getUint8(0),length=view.getUint32(1,false);if(length>2097152)throw new Error('tts frame too large');if(pending.length-offset<5+length)break;const payload=pending.slice(offset+5,offset+5+length);offset+=5+length;if(type===1){schedulePcm(state,payload);streamed=state.played}else if(type===2)completed=true;else if(type===3){try{streamError=JSON.parse(new TextDecoder().decode(payload))}catch{streamError={partial:state.played}}}}if(offset)pending=pending.slice(offset);if(read.done)break}if(state.played)await sleep(Math.max(0,(state.nextAt-audioContext.currentTime)*1000+80));if(!completed&&!state.played)throw new Error('managed tts incomplete');if(streamError&&!state.played)throw new Error('managed tts failed')}catch{if(streamed)return;return fallbackSpeak(normalized,volume)}}async function ack(id,ok,error){const response=await fetch('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({commandId:id,succeeded:ok,error:error||null}),cache:'no-store'});if(!response.ok)throw new Error('overlay acknowledgement failed')}async function heartbeat(){if(!token||stopped||!claimedOnce)return;try{const r=await fetch('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({heartbeat:true}),cache:'no-store'});if(r.status===401||r.status===409)stopped=true}catch{}}setInterval(heartbeat,5000);function prime(){try{$('spinSound').load();audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});void audioContext.resume()}catch{}}document.addEventListener('click',prime,{passive:true});function stopSlot(){clearInterval(slotTimer);slotTimer=null}function setSlot(text,tick=true){$('slotValue').textContent=text||'룰렛 결과';if(tick){$('slotValue').classList.remove('tick');void $('slotValue').offsetWidth;$('slotValue').classList.add('tick')}}function startSlot(items){stopSlot();const values=Array.isArray(items)&&items.length?items:['보너스 상품','아봉 10초','다음 보상 2배','시크릿 단컷'];let index=0;$('slot').classList.remove('winner');setSlot(values[0]);slotTimer=setInterval(()=>{index=(index+1)%values.length;setSlot(values[index])},92)}function hidePresentation(){stopSlot();$('rouletteGroup').classList.add('hidden');$('ceremony').classList.remove('show');$('chat').classList.remove('show')}async function showCeremony(p,duration,keepStage=false){const ceremony=p.ceremony||{},image=$('ceremonyImage'),providerFallback=ceremony.providerFallbackUrl||null;if(!ceremony.url)return;hidePresentation();image.classList.remove('hidden');image.onerror=()=>{if(providerFallback&&image.src!==providerFallback){image.src=providerFallback;return}image.onerror=null;image.removeAttribute('src');image.classList.add('hidden')};image.src=ceremony.url;$('ceremonyCaption').textContent=(p.actor?.name||'시청자')+'님 · 별풍선 '+Number(p.amount||0).toLocaleString()+'개';$('stage').classList.add('show');$('ceremony').classList.add('show');await sleep(duration);$('ceremony').classList.remove('show');if(!keepStage){$('stage').classList.remove('show');await sleep(180)}image.removeAttribute('src');image.classList.add('hidden')}async function roulette(command){const p=command.payload;if(p.ceremony?.url)await showCeremony(p,700,true);stopSlot();$('rouletteGroup').classList.remove('hidden');const asset=assets[p.overlayAssetKey]||{},colors=asset.colors||['#102746','#ffc44d'],custom=p.customImage?.previewUrl||null;$('rouletteCard').classList.toggle('builtin',!custom);const animation=custom||asset.animationUrl||asset.previewUrl||'',presentation=$('presentation'),fallback=$('fallback');$('wheel').style.background='conic-gradient('+colors[0]+' 0 12.5%,'+colors[1]+' 12.5% 25%,'+colors[0]+' 25% 37.5%,'+colors[1]+' 37.5% 50%,'+colors[0]+' 50% 62.5%,'+colors[1]+' 62.5% 75%,'+colors[0]+' 75% 87.5%,'+colors[1]+' 87.5% 100%)';presentation.classList.toggle('hidden',!animation);fallback.classList.toggle('hidden',!!animation);if(animation){presentation.src='';await sleep(0);presentation.src=animation}else{$('wheel').classList.remove('spin');void $('wheel').offsetWidth;$('wheel').classList.add('spin')}$('headline').textContent=(p.actor?.name||'시청자')+'님 룰렛';$('sub').textContent=Number(p.amount||0).toLocaleString()+'개 후원 · '+(p.rouletteName||'별록 룰렛');$('visual').style.opacity='1';startSlot(p.rouletteItems);$('stage').classList.add('show');try{$('spinSound').volume=Math.max(0,Math.min(1,Number(p.soundVolumePercent??80)/100));$('spinSound').currentTime=0;void $('spinSound').play()}catch{}await sleep(3000);stopSlot();setSlot(p.resultText||'당첨!');$('slot').classList.add('winner');$('visual').style.opacity='.55';await speak(command,p.ttsText||((p.resultText||'')+', 당첨!'),p.ttsVolumePercent);await sleep(650);$('stage').classList.remove('show');$('rouletteGroup').classList.add('hidden');$('slot').classList.remove('winner');presentation.src='';await sleep(180)}async function ceremony(p){if(p.ceremony?.url)await showCeremony(p,2300,false)}async function chat(command){const p=command.payload;hidePresentation();$('chat').textContent=p.displayText||p.message||'';$('stage').classList.add('show');$('chat').classList.add('show');await speak(command,p.ttsText||p.message||'',p.ttsVolumePercent);await sleep(450);$('chat').classList.remove('show');$('stage').classList.remove('show');await sleep(180)}async function play(command){busy=true;let succeeded=false,failure=null;try{if(command.kind==='roulette_spin')await roulette(command);else if(command.kind==='donation_ceremony')await ceremony(command.payload);else if(command.kind==='donation_chat_tts')await chat(command);remember(command.id);succeeded=true}catch(error){failure=String(error?.message||error);hidePresentation();$('stage').classList.remove('show');await sleep(1200)}finally{busy=false}await ack(command.id,succeeded,failure)}async function poll(){if(stopped||busy)return setTimeout(poll,180);if(!token){$('ready').textContent='오버레이 주소를 다시 복사해주세요.';$('ready').className='ready error';return}try{const r=await fetch('/api/auth/soop/roulette-overlay/poll',{headers:{Authorization:'Bearer '+token,'X-Byeollog-Overlay-Client':clientId},cache:'no-store'});if(r.status===401||r.status===409){$('ready').textContent=r.status===409?'오버레이가 일시정지되었습니다.':'오버레이 주소가 변경되었습니다.';$('ready').className='ready error';stopped=true;return}if(r.status===423){$('ready').textContent='다른 OBS에서 사용 중입니다.';$('ready').className='ready error';return setTimeout(poll,2500)}if(!r.ok)throw new Error('poll failed');const data=await r.json();claimedOnce=true;if(data.clientVersion&&data.clientVersion!==clientVersion){location.reload();return}$('ready').textContent='별록 공통 오버레이 연결됨';$('ready').className='ready connected';if(data.command){if(wasPlayed(data.command.id))await ack(data.command.id,true);else await play(data.command)}}catch{$('ready').textContent='서버 재연결 중';$('ready').className='ready'}setTimeout(poll,500)}poll()})();
</script><script nonce="${n}">
(()=>{const card=document.getElementById('rouletteCard'),panel=document.getElementById('panel'),image=document.getElementById('presentation');let ratio=16/9;function fitRouletteCard(){if(image.naturalWidth>0&&image.naturalHeight>0)ratio=Math.max(.5,Math.min(4,image.naturalWidth/image.naturalHeight));const builtin=card.classList.contains('builtin'),slotHeight=builtin?0:Math.max(74,Math.min(innerHeight*.1,118)),width=Math.max(240,Math.min(innerWidth*.97,(innerHeight*.97-slotHeight)*ratio));card.style.width=width+'px';panel.style.aspectRatio=String(ratio)}image.addEventListener('load',fitRouletteCard);addEventListener('resize',fitRouletteCard);new MutationObserver(fitRouletteCard).observe(card,{attributes:true,attributeFilter:['class']});fitRouletteCard()})();
</script></body></html>`;
  return html
    .replace("setSlot(p.resultText||'당첨!')","setSlot(p.resultText||'룰렛 결과')")
    .replace("await speak(command,p.ttsText||((p.resultText||'')+', 당첨!'),p.ttsVolumePercent)","await speak(command,p.resultText||'',p.ttsVolumePercent)");
}

function getRouletteServiceOverlayHtmlV7(nonce){
  const n=escapeHtml(nonce);
  const assets=JSON.stringify(ASSET_MAP).replace(/</g,'\\u003c');
  const clientVersion=JSON.stringify(ROULETTE_OVERLAY_CLIENT_VERSION);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>별록 룰렛 오버레이</title><style nonce="${n}">
*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:Pretendard,"Noto Sans KR",system-ui,sans-serif;color:#fff}.stage{position:fixed;inset:0;display:grid;place-items:center;opacity:0;pointer-events:none;transition:opacity .16s}.stage.show{opacity:1}.rouletteGroup{position:absolute;inset:0;display:grid;place-items:center;padding:2vmin}.rouletteCard{width:min(92vw,960px);transform-origin:50% 50%;filter:drop-shadow(0 18px 34px #000a)}.rouletteCard.enter{animation:cardEnter .52s cubic-bezier(.18,.86,.22,1.18)}.panel{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border:3px solid #26354a;border-bottom:0;border-radius:18px 18px 0 0;background:transparent}.visual{position:absolute;inset:0;display:grid;place-items:center;transition:opacity .2s}.presentation{display:block;width:100%;height:100%;object-fit:contain}.wheelWrap{position:relative;display:grid;place-items:center}.wheel{width:min(50vw,540px);aspect-ratio:1;border-radius:50%;border:13px solid #fff;box-shadow:0 0 0 7px #102746,0 0 58px #ffc44d82;position:relative;overflow:hidden}.wheel:after{content:"";position:absolute;inset:39%;border-radius:50%;background:#fff;border:8px solid #102746;box-shadow:0 4px 14px #0005}.pointer{position:absolute;top:-27px;left:50%;translate:-50% 0;width:0;height:0;border-left:24px solid transparent;border-right:24px solid transparent;border-top:55px solid #ffc44d;z-index:4;filter:drop-shadow(0 4px 2px #0006)}.spin{animation:spin 3s cubic-bezier(.12,.68,.14,1) forwards}.resultPanel{width:100%;overflow:hidden;border:3px solid #26354a;border-top:0;border-radius:0 0 18px 18px;background:linear-gradient(180deg,#fff,#f5f7fb);box-shadow:0 15px 38px #0008}.donationMeta{display:flex;align-items:center;justify-content:center;gap:10px;min-height:46px;padding:8px 20px 5px;color:#435066;font-size:clamp(16px,2vw,27px);font-weight:900;letter-spacing:-.035em;text-align:center}.donorName{color:#132945}.donationSummary{color:#596579}.seriesCounter{margin-left:auto;padding:5px 10px;border-radius:999px;background:#ffc44d;color:#102746;font-size:.78em;font-weight:950;white-space:nowrap;box-shadow:0 4px 14px #ffc44d66}.seriesCounter.bump{animation:counterBump .38s cubic-bezier(.18,.9,.22,1.3)}.slot{width:100%;transition:filter .2s}.slotInner{display:grid;place-items:center;min-height:clamp(62px,8.5vh,98px);padding:8px 20px 14px;overflow:hidden}.slotValue{max-width:100%;overflow:hidden;color:#102746;font-size:clamp(29px,3.7vw,57px);font-weight:950;letter-spacing:-.05em;text-align:center;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 2px 0 #d8e0eb}.slotValue.tick{animation:slotTick .11s ease-out}.slot.winner .slotValue{animation:winnerReveal .58s cubic-bezier(.15,.78,.18,1.2)}.donationMessage{max-height:0;overflow:hidden;padding:0 24px;color:#24344c;font-size:clamp(19px,2.35vw,34px);font-weight:880;letter-spacing:-.035em;line-height:1.35;text-align:center;opacity:0;transform:translateY(-10px);transition:max-height .34s ease,padding .34s ease,opacity .25s ease,transform .34s ease}.donationMessage.show{max-height:180px;padding:14px 24px 17px;border-top:2px solid #d7deea;opacity:1;transform:translateY(0)}.donationMessage.show .messageText{display:inline-block;animation:messagePop .55s cubic-bezier(.15,.8,.2,1.25)}.ceremony{position:absolute;inset:0;display:grid;place-items:center;opacity:0;scale:.94;transition:opacity .16s,scale .22s}.ceremony.show{opacity:1;scale:1}.ceremonyCard{display:grid;justify-items:center;width:min(58vw,820px)}.ceremonyImage{display:block;width:100%;height:min(58vh,560px);object-fit:contain;filter:drop-shadow(0 20px 38px #000b)}.ceremonyCaption{max-width:100%;margin-top:10px;padding:10px 18px;border-radius:999px;background:#102746e8;border:2px solid #ffc44d;color:#fff;font-size:clamp(18px,2.2vw,32px);font-weight:950;text-align:center;box-shadow:0 14px 30px #0007}.chat{position:absolute;left:50%;bottom:5%;translate:-50% 12px;min-width:min(80vw,760px);padding:18px 26px;border-radius:20px;background:#102746ef;border:2px solid #ffc44d;color:#fff;text-align:center;font-size:clamp(20px,2.4vw,34px);font-weight:850;opacity:0;transition:.22s}.chat.show{opacity:1;translate:-50% 0}.ready{display:none!important}.hidden{display:none!important}@keyframes cardEnter{0%{opacity:0;transform:translateY(28px) scale(.84) rotate(-1.2deg)}68%{opacity:1;transform:translateY(-4px) scale(1.035) rotate(.25deg)}100%{opacity:1;transform:none}}@keyframes spin{from{transform:rotate(0)}to{transform:rotate(1440deg)}}@keyframes slotTick{from{opacity:.12;transform:translateY(-42%) scale(.96);filter:blur(5px)}to{opacity:1;transform:none;filter:blur(0)}}@keyframes winnerReveal{0%{opacity:.15;filter:blur(10px);transform:scale(1.28)}55%{opacity:1;filter:blur(0);transform:scale(.96)}100%{transform:scale(1)}}@keyframes counterBump{0%{transform:scale(.75);filter:brightness(1.8)}70%{transform:scale(1.17)}100%{transform:scale(1)}}@keyframes messagePop{0%{opacity:0;transform:translateY(-14px) scale(.94);filter:blur(5px)}65%{opacity:1;transform:translateY(2px) scale(1.025);filter:blur(0)}100%{transform:none}}
</style></head><body><div id="stage" class="stage"><div id="rouletteGroup" class="rouletteGroup hidden"><div id="rouletteCard" class="rouletteCard"><div id="panel" class="panel"><div id="visual" class="visual"><img id="presentation" class="presentation" alt=""><div id="fallback" class="wheelWrap hidden"><div class="pointer"></div><div id="wheel" class="wheel"></div></div></div></div><div id="resultPanel" class="resultPanel"><div class="donationMeta"><strong id="donorName" class="donorName"></strong><span id="donationSummary" class="donationSummary"></span><span id="seriesCounter" class="seriesCounter hidden"></span></div><div id="slot" class="slot"><div class="slotInner"><strong id="slotValue" class="slotValue">룰렛 결과</strong></div></div><div id="donationMessage" class="donationMessage"><span id="messageText" class="messageText"></span></div></div></div></div><div id="ceremony" class="ceremony"><div class="ceremonyCard"><img id="ceremonyImage" class="ceremonyImage" alt="후원 세레모니"><div id="ceremonyCaption" class="ceremonyCaption"></div></div></div><div id="chat" class="chat"></div></div><div id="ready" class="ready" aria-hidden="true"></div><audio id="spinSound" preload="auto" src="/api/auth/soop/roulette-overlay/sound"></audio><script nonce="${n}">
(()=>{
const $=id=>document.getElementById(id),assets=${assets},clientVersion=${clientVersion};
const params=new URLSearchParams(location.hash.slice(1)),suppliedToken=params.get('token')||'';
if(suppliedToken)sessionStorage.setItem('byeollogOverlayToken',suppliedToken);
const token=suppliedToken||sessionStorage.getItem('byeollogOverlayToken')||'';
history.replaceState(null,'',location.pathname+location.search);
const clientId=sessionStorage.getItem('byeollogOverlayClient')||crypto.randomUUID();
sessionStorage.setItem('byeollogOverlayClient',clientId);
const playedStorage='byeollogPlayedOverlayCommands';
function loadPlayed(){try{return new Set(JSON.parse(sessionStorage.getItem(playedStorage)||'[]'))}catch{return new Set()}}
const playedCommands=loadPlayed();
function remember(id){playedCommands.add(id);const recent=[...playedCommands].slice(-64);playedCommands.clear();for(const value of recent)playedCommands.add(value);sessionStorage.setItem(playedStorage,JSON.stringify(recent))}
function wasPlayed(id){return playedCommands.has(id)}
let busy=false,stopped=false,claimedOnce=false,slotTimer=null,audioContext=null,activeEventId=null,cardVisible=false,closeTimer=null;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function fallbackSpeak(text,volume){return new Promise(resolve=>{try{speechSynthesis.cancel();const utterance=new SpeechSynthesisUtterance(text);utterance.lang='ko-KR';utterance.rate=1.12;utterance.volume=Math.max(0,Math.min(1,Number(volume??80)/100));let settled=false;const done=()=>{if(settled)return;settled=true;resolve()};utterance.onend=done;utterance.onerror=done;speechSynthesis.speak(utterance);setTimeout(done,Math.min(30000,3000+String(text||'').length*220))}catch{resolve()}})}
function appendBytes(a,b){const joined=new Uint8Array(a.length+b.length);joined.set(a);joined.set(b,a.length);return joined}
function schedulePcm(state,bytes){const usable=bytes.length-(bytes.length%2);if(!usable)return;const samples=usable/2,buffer=state.context.createBuffer(1,samples,24000),channel=buffer.getChannelData(0),view=new DataView(bytes.buffer,bytes.byteOffset,usable);for(let i=0;i<samples;i++)channel[i]=view.getInt16(i*2,true)/32768;const source=state.context.createBufferSource();source.buffer=buffer;source.connect(state.gain);state.nextAt=Math.max(state.nextAt,state.context.currentTime+.1);source.start(state.nextAt);state.nextAt+=buffer.duration;state.played=true}
async function speak(command,text,volume){const normalized=String(text||'').trim();if(!normalized)return;if(!command.ttsAuthorization)return fallbackSpeak(normalized,volume);let streamed=false;try{audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});await audioContext.resume();const gain=audioContext.createGain();gain.gain.value=Math.max(0,Math.min(1,Number(volume??80)/100));gain.connect(audioContext.destination);const response=await fetch('/api/auth/soop/roulette-overlay/tts',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({commandId:command.id,text:normalized,authorization:command.ttsAuthorization}),cache:'no-store'});if(!response.ok||!response.body)throw new Error('managed tts unavailable');const reader=response.body.getReader(),state={context:audioContext,gain,nextAt:audioContext.currentTime+.1,played:false};let pending=new Uint8Array(0),completed=false,streamError=null;while(true){const read=await reader.read();if(read.value?.length)pending=appendBytes(pending,read.value);let offset=0;while(pending.length-offset>=5){const view=new DataView(pending.buffer,pending.byteOffset+offset,pending.length-offset),type=view.getUint8(0),length=view.getUint32(1,false);if(length>2097152)throw new Error('tts frame too large');if(pending.length-offset<5+length)break;const payload=pending.slice(offset+5,offset+5+length);offset+=5+length;if(type===1){schedulePcm(state,payload);streamed=state.played}else if(type===2)completed=true;else if(type===3){try{streamError=JSON.parse(new TextDecoder().decode(payload))}catch{streamError={partial:state.played}}}}if(offset)pending=pending.slice(offset);if(read.done)break}if(state.played)await sleep(Math.max(0,(state.nextAt-audioContext.currentTime)*1000+80));if(!completed&&!state.played)throw new Error('managed tts incomplete');if(streamError&&!state.played)throw new Error('managed tts failed')}catch{if(streamed)return;return fallbackSpeak(normalized,volume)}}
async function ack(id,ok,error){const response=await fetch('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({commandId:id,succeeded:ok,error:error||null}),cache:'no-store'});if(!response.ok)throw new Error('overlay acknowledgement failed')}
async function heartbeat(){if(!token||stopped||!claimedOnce)return;try{const response=await fetch('/api/auth/soop/roulette-overlay/poll',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json','X-Byeollog-Overlay-Client':clientId},body:JSON.stringify({heartbeat:true}),cache:'no-store'});if(response.status===401||response.status===409)stopped=true}catch{}}
setInterval(heartbeat,5000);
function prime(){try{$('spinSound').load();audioContext=audioContext||new (window.AudioContext||window.webkitAudioContext)({sampleRate:24000});void audioContext.resume()}catch{}}
document.addEventListener('click',prime,{passive:true});
function stopSlot(){clearInterval(slotTimer);slotTimer=null}
function setSlot(text,tick=true){$('slotValue').textContent=text||'룰렛 결과';if(tick){$('slotValue').classList.remove('tick');void $('slotValue').offsetWidth;$('slotValue').classList.add('tick')}}
function startSlot(items){stopSlot();const values=Array.isArray(items)&&items.length?items:['보너스 상품','아봉 10초','다음 보상 2배','시크릿 단컷'];let index=0;$('slot').classList.remove('winner');setSlot(values[0]);slotTimer=setInterval(()=>{index=(index+1)%values.length;setSlot(values[index])},92)}
function clearCloseTimer(){if(closeTimer){clearTimeout(closeTimer);closeTimer=null}}
function resizeCard(){dispatchEvent(new Event('roulette-card-resize'))}
function hideRoulette(){clearCloseTimer();stopSlot();$('rouletteGroup').classList.add('hidden');$('rouletteCard').classList.remove('enter');$('donationMessage').classList.remove('show');$('slot').classList.remove('winner');$('presentation').removeAttribute('src');activeEventId=null;cardVisible=false}
function hidePresentation(){hideRoulette();$('ceremony').classList.remove('show');$('chat').classList.remove('show')}
function eventIdOf(command){return String(command?.payload?.eventId||'')}
function seriesPosition(payload){const total=Math.max(1,Number(payload.spinCount)||1),current=Math.max(1,Math.min(total,(Number(payload.spinIndex)||0)+1));return {current,total}}
function setSeriesCounter(payload){const position=seriesPosition(payload),counter=$('seriesCounter');counter.classList.toggle('hidden',position.total<=1);counter.textContent=position.current+' / '+position.total;counter.classList.remove('bump');void counter.offsetWidth;counter.classList.add('bump');return position}
function configureVisual(payload){const asset=assets[payload.overlayAssetKey]||{},colors=asset.colors||['#102746','#ffc44d'],custom=payload.customImage?.previewUrl||null,animation=custom||asset.animationUrl||asset.previewUrl||'',presentation=$('presentation'),fallback=$('fallback');$('wheel').style.background='conic-gradient('+colors[0]+' 0 12.5%,'+colors[1]+' 12.5% 25%,'+colors[0]+' 25% 37.5%,'+colors[1]+' 37.5% 50%,'+colors[0]+' 50% 62.5%,'+colors[1]+' 62.5% 75%,'+colors[0]+' 75% 87.5%,'+colors[1]+' 87.5% 100%)';presentation.classList.toggle('hidden',!animation);fallback.classList.toggle('hidden',Boolean(animation));if(animation)presentation.src=animation;else{$('wheel').classList.remove('spin');void $('wheel').offsetWidth;$('wheel').classList.add('spin')}}
function openRoulette(command){const payload=command.payload;hidePresentation();activeEventId=eventIdOf(command);cardVisible=true;$('donorName').textContent=(payload.actor?.name||'시청자')+'님';const donationType=String(payload.donationTypeLabel||payload.balloonTypeLabel||'별풍선').trim()||'별풍선';$('donationSummary').textContent=donationType+' '+Number(payload.amount||0).toLocaleString()+'개';$('messageText').textContent='';$('donationMessage').classList.remove('show');configureVisual(payload);$('rouletteGroup').classList.remove('hidden');$('stage').classList.add('show');const card=$('rouletteCard');card.classList.remove('enter');void card.offsetWidth;card.classList.add('enter');resizeCard()}
function scheduleFinalClose(payload){clearCloseTimer();let delay=1800;const occurredAt=Date.parse(payload.eventOccurredAt||''),windowSeconds=Math.max(0,Math.min(60,Number(payload.followupChatTtsWindowSeconds??10)));if(Number.isFinite(occurredAt)&&windowSeconds>0)delay=Math.max(1800,Math.min(12000,occurredAt+windowSeconds*1000+1500-Date.now()));const expected=activeEventId;closeTimer=setTimeout(()=>{if(activeEventId===expected){hideRoulette();$('stage').classList.remove('show')}},delay)}
async function showCeremony(payload,duration,keepStage=false){const ceremony=payload.ceremony||{},image=$('ceremonyImage'),providerFallback=ceremony.providerFallbackUrl||null;if(!ceremony.url)return;hidePresentation();image.classList.remove('hidden');image.onerror=()=>{if(providerFallback&&image.src!==providerFallback){image.src=providerFallback;return}image.onerror=null;image.removeAttribute('src');image.classList.add('hidden')};image.src=ceremony.url;$('ceremonyCaption').textContent=(payload.actor?.name||'시청자')+'님 · 별풍선 '+Number(payload.amount||0).toLocaleString()+'개';$('stage').classList.add('show');$('ceremony').classList.add('show');await sleep(duration);$('ceremony').classList.remove('show');if(!keepStage){$('stage').classList.remove('show');await sleep(180)}image.removeAttribute('src');image.classList.add('hidden')}
async function roulette(command){const payload=command.payload,sameCard=cardVisible&&activeEventId===eventIdOf(command);clearCloseTimer();if(!sameCard)openRoulette(command);const position=setSeriesCounter(payload);$('visual').style.opacity='1';startSlot(payload.rouletteItems);$('stage').classList.add('show');try{$('spinSound').volume=Math.max(0,Math.min(1,Number(payload.soundVolumePercent??80)/100));$('spinSound').currentTime=0;void $('spinSound').play()}catch{}await sleep(3000);stopSlot();setSlot(payload.resultText||'룰렛 결과');$('slot').classList.add('winner');$('visual').style.opacity='.82';await speak(command,payload.resultText||'',payload.ttsVolumePercent);if(position.current<position.total){await sleep(260);$('slot').classList.remove('winner');return}scheduleFinalClose(payload)}
async function ceremony(payload){if(payload.ceremony?.url)await showCeremony(payload,2300,false)}
async function chat(command){const payload=command.payload,belongsToCard=cardVisible&&activeEventId===eventIdOf(command);if(belongsToCard){clearCloseTimer();$('messageText').textContent=payload.message||payload.ttsText||'';$('donationMessage').classList.add('show');resizeCard();await speak(command,payload.ttsText||payload.message||'',payload.ttsVolumePercent);await sleep(1500);hideRoulette();$('stage').classList.remove('show');await sleep(180);return}hidePresentation();$('chat').textContent=payload.displayText||payload.message||'';$('stage').classList.add('show');$('chat').classList.add('show');await speak(command,payload.ttsText||payload.message||'',payload.ttsVolumePercent);await sleep(450);$('chat').classList.remove('show');$('stage').classList.remove('show');await sleep(180)}
async function play(command){busy=true;let succeeded=false,failure=null;try{if(command.kind==='roulette_spin')await roulette(command);else if(command.kind==='donation_ceremony')await ceremony(command.payload);else if(command.kind==='donation_chat_tts')await chat(command);remember(command.id);succeeded=true}catch(error){failure=String(error?.message||error);hidePresentation();$('stage').classList.remove('show');await sleep(1200)}finally{busy=false}await ack(command.id,succeeded,failure)}
async function poll(){if(stopped||busy)return setTimeout(poll,120);if(!token){$('ready').textContent='오버레이 주소를 다시 복사해주세요.';$('ready').className='ready error';return}try{const response=await fetch('/api/auth/soop/roulette-overlay/poll',{headers:{Authorization:'Bearer '+token,'X-Byeollog-Overlay-Client':clientId},cache:'no-store'});if(response.status===401||response.status===409){$('ready').textContent=response.status===409?'오버레이가 일시정지되었습니다.':'오버레이 주소가 변경되었습니다.';$('ready').className='ready error';stopped=true;return}if(response.status===423){$('ready').textContent='다른 OBS에서 사용 중입니다.';$('ready').className='ready error';return setTimeout(poll,2500)}if(!response.ok)throw new Error('poll failed');const data=await response.json();claimedOnce=true;if(data.clientVersion&&data.clientVersion!==clientVersion){location.reload();return}$('ready').textContent='별록 공통 오버레이 연결됨';$('ready').className='ready connected';if(data.command){if(wasPlayed(data.command.id))await ack(data.command.id,true);else await play(data.command)}}catch{$('ready').textContent='서버 재연결 중';$('ready').className='ready'}setTimeout(poll,cardVisible?120:500)}
poll();
})();
</script><script nonce="${n}">
(()=>{const card=document.getElementById('rouletteCard'),panel=document.getElementById('panel'),image=document.getElementById('presentation');let ratio=16/9;function fitRouletteCard(){if(image.naturalWidth>0&&image.naturalHeight>0)ratio=Math.max(.5,Math.min(4,image.naturalWidth/image.naturalHeight));const result=document.getElementById('resultPanel'),resultHeight=Math.max(110,result.offsetHeight||110),width=Math.max(240,Math.min(innerWidth*.92,(innerHeight*.94-resultHeight)*ratio));card.style.width=width+'px';panel.style.aspectRatio=String(ratio)}image.addEventListener('load',fitRouletteCard);addEventListener('resize',fitRouletteCard);addEventListener('roulette-card-resize',()=>requestAnimationFrame(fitRouletteCard));fitRouletteCard()})();
</script></body></html>`;
}

export function getRouletteServiceOverlayHtml(nonce){
  return getCommonOverlayV8Html(nonce,{assets:ASSET_MAP,clientVersion:ROULETTE_OVERLAY_CLIENT_VERSION});
}

export function publicPresentationImage(reference){
  return reference?.storagePath?rouletteAssetPublicUrl(reference.storagePath):null;
}
