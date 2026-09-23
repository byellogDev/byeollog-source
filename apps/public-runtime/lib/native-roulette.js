import crypto from 'node:crypto';
import {NATIVE_ROULETTE_ASSET_BY_KEY} from './native-roulette-assets.js';

export const NATIVE_ROULETTE_PROBABILITY_SCALE=1_000_000;
// Public Weflab roulettes in active use can exceed 100 entries (the verified
// migration fixture has 109). Keep a bounded ceiling while allowing a lossless
// user-directed import.
export const NATIVE_ROULETTE_MAX_ITEMS=200;
export const NATIVE_ROULETTE_MAX_SPINS=100;
export const NATIVE_ROULETTE_MAX_SERIES_SPINS=1_000;
export const NATIVE_ROULETTE_TTS_KEY_DOMAIN='native-roulette-result-v1|';
export const NATIVE_ROULETTE_SOUND_KEYS=Object.freeze(['roulette_spin_v1']);
// Weflab-compatible donor message window. Keep this identical across saved
// drafts, active services and OBS clients so delayed donor chat is correlated
// consistently without keeping the visual alert on screen for the full window.
export const NATIVE_ROULETTE_DEFAULT_FOLLOWUP_CHAT_TTS_WINDOW_SECONDS=30;
export const NATIVE_ROULETTE_MAX_FOLLOWUP_CHAT_TTS_WINDOW_SECONDS=30;
export const NATIVE_ROULETTE_MAX_CHAT_TTS_CHARACTERS=300;
export const NATIVE_ROULETTE_TRIGGER_KINDS=Object.freeze(['single','series']);
export const SOOP_DONATION_TYPE_LABELS=Object.freeze(['별풍선','대결미션','도전미션']);
// This is also the database contract for core donations, wallpaper rows and
// upbo amount mappings. Keep the provider boundary aligned with durable data.
export const SOOP_DONATION_MAX_BALLOONS=1_000_000_000;
export const NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES=20;
export const NATIVE_ROULETTE_MAX_RESULT_CODE_POINTS=200;

export class NativeRouletteValidationError extends Error{
  constructor(message,code='invalid_native_roulette'){
    super(message);
    this.name='NativeRouletteValidationError';
    this.code=code;
    this.status=400;
  }
}

function boundedText(value,max){
  return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max);
}

export function unicodeGraphemes(value){
  const text=String(value??'');
  try{
    return [...new Intl.Segmenter('ko',{granularity:'grapheme'}).segment(text)].map(part=>part.segment);
  }catch{
    return [...text];
  }
}

export function unicodeGraphemeCount(value){
  return unicodeGraphemes(value).length;
}

function requiredGraphemeText(value,max,label){
  const text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().normalize('NFC');
  if(!text)throw new NativeRouletteValidationError(`${label}을(를) 입력하세요.`);
  if([...text].length>NATIVE_ROULETTE_MAX_RESULT_CODE_POINTS){
    throw new NativeRouletteValidationError(`${label} 입력 내용이 너무 깁니다.`,'native_roulette_text_too_large');
  }
  if(unicodeGraphemeCount(text)>max){
    throw new NativeRouletteValidationError(`${label}은(는) ${max}자 이내로 입력하세요.`,'native_roulette_text_too_long');
  }
  return text;
}

function requiredText(value,max,label){
  const text=boundedText(value,max);
  if(!text)throw new NativeRouletteValidationError(`${label}을(를) 입력하세요.`);
  return text;
}

function safeInteger(value,min,max,label){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max){
    throw new NativeRouletteValidationError(`${label} 값이 올바르지 않습니다.`);
  }
  return number;
}

function requiredChoice(value,choices,label){
  const text=boundedText(value,100);
  if(!choices.includes(text))throw new NativeRouletteValidationError(`${label} 값이 올바르지 않습니다.`);
  return text;
}

function requiredSha256(value,label){
  const text=requiredText(value,64,label).toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(text))throw new NativeRouletteValidationError(`${label} 값이 올바르지 않습니다.`);
  return text;
}

export function nativeRouletteTtsVoiceKey(value){
  const text=requiredGraphemeText(value,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,'TTS 문구');
  return crypto.createHash('sha256').update(NATIVE_ROULETTE_TTS_KEY_DOMAIN+text,'utf8').digest('hex');
}

export function probabilityPercentToPpm(value){
  const text=String(value??'').trim();
  const match=text.match(/^(\d{1,3})(?:\.(\d{1,4}))?$/);
  if(!match)throw new NativeRouletteValidationError('확률은 소수점 넷째 자리까지 입력하세요.');
  const whole=Number(match[1]);
  const fraction=Number(String(match[2]||'').padEnd(4,'0'));
  if(whole>100||(whole===100&&fraction!==0)){
    throw new NativeRouletteValidationError('확률은 100% 이하여야 합니다.');
  }
  return whole*10_000+fraction;
}

export function probabilityPpmToPercent(value){
  const ppm=safeInteger(value,0,NATIVE_ROULETTE_PROBABILITY_SCALE,'확률');
  return (ppm/10_000).toFixed(4).replace(/\.0+$|(?<=\.[0-9]*?)0+$/g,'').replace(/\.$/,'');
}

export function splitDirectUpboOutputs(value){
  const text=requiredGraphemeText(value,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,'상품명');
  const outputs=text.split(/\s*&\s*/).map(item=>item.trim()).filter(Boolean);
  if(!outputs.length||outputs.length>20){
    throw new NativeRouletteValidationError('업보 상품의 & 분리 결과가 올바르지 않습니다.');
  }
  return outputs;
}

function normalizeNativeRouletteItems(input,name){
  if(!Array.isArray(input.items)||input.items.length<2||input.items.length>NATIVE_ROULETTE_MAX_ITEMS){
    throw new NativeRouletteValidationError(`상품은 2개 이상 ${NATIVE_ROULETTE_MAX_ITEMS}개 이하로 설정하세요.`);
  }

  const seen=new Set();
  let total=0;
  const items=input.items.map((item,index)=>{
    const resultText=requiredGraphemeText(
      item?.resultText,
      NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,
      `${index+1}번 상품명`
    );
    const identity=resultText.toLocaleLowerCase('ko-KR');
    if(seen.has(identity))throw new NativeRouletteValidationError('같은 상품명을 두 번 사용할 수 없습니다.');
    seen.add(identity);
    const probabilityPpm=safeInteger(
      item?.probabilityPpm,
      1,
      NATIVE_ROULETTE_PROBABILITY_SCALE-1,
      `${resultText} 확률`
    );
    if(typeof item?.directUpbo!=='boolean'){
      throw new NativeRouletteValidationError(`${resultText}의 업보 체크 여부가 필요합니다.`);
    }
    const directUpbo=item.directUpbo;
    const upboEventName=directUpbo
      ? boundedText(item?.upboEventName,120)||name
      : null;
    const outputTypes=directUpbo?splitDirectUpboOutputs(resultText):[];
    const ttsText=directUpbo?null:resultText;
    const ttsVoiceKey=ttsText?nativeRouletteTtsVoiceKey(ttsText):null;
    total+=probabilityPpm;
    return {
      id:boundedText(item?.id,64)||null,
      position:index,
      resultText,
      probabilityPpm,
      directUpbo,
      upboEventName,
      outputTypes,
      ttsText,
      ttsVoiceKey
    };
  });
  if(total!==NATIVE_ROULETTE_PROBABILITY_SCALE){
    throw new NativeRouletteValidationError('전체 상품 확률의 합이 정확히 100%여야 합니다.','probability_total_mismatch');
  }
  return items;
}

export function normalizeNativeRouletteDraft(input={}){
  const name=requiredText(input.name,120,'룰렛 이름');
  const balloonsPerSpin=safeInteger(input.balloonsPerSpin,1,1_000_000,'1회당 별풍선');
  const overlayAssetKey=requiredChoice(
    input.overlayAssetKey,
    Object.keys(NATIVE_ROULETTE_ASSET_BY_KEY),
    '룰렛 이미지'
  );
  const overlayAsset=NATIVE_ROULETTE_ASSET_BY_KEY[overlayAssetKey];
  const soundKey=requiredChoice(input.soundKey||'roulette_spin_v1',NATIVE_ROULETTE_SOUND_KEYS,'효과음');
  const soundVolumePercent=safeInteger(input.soundVolumePercent??80,0,100,'효과음 음량');
  const ttsVolumePercent=safeInteger(input.ttsVolumePercent??80,0,100,'TTS 음량');
  const followupChatTtsWindowSeconds=NATIVE_ROULETTE_DEFAULT_FOLLOWUP_CHAT_TTS_WINDOW_SECONDS;
  const agentDeviceId=requiredText(input.agentDeviceId,64,'캐시 대상 PC');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentDeviceId)){
    throw new NativeRouletteValidationError('캐시 대상 PC 식별값이 올바르지 않습니다.');
  }
  if(typeof input.allowMultipleSpins!=='boolean'){
    throw new NativeRouletteValidationError('배수 후원 허용 여부가 필요합니다.');
  }
  const allowMultipleSpins=input.allowMultipleSpins;
  const items=normalizeNativeRouletteItems(input,name);
  return {
    name,
    balloonsPerSpin,
    allowMultipleSpins,
    agentDeviceId:agentDeviceId.toLowerCase(),
    overlayAssetKey,
    overlayAssetSha256:overlayAsset.contentSha256,
    overlayAssetBytes:overlayAsset.byteSize,
    soundKey,
    soundVolumePercent,
    ttsVolumePercent,
    followupChatTtsWindowSeconds,
    items
  };
}

export function normalizeRouletteCustomImageReference(input){
  if(input===null||input===undefined)return null;
  if(!input||typeof input!=='object'||Array.isArray(input)){
    throw new NativeRouletteValidationError('사용자 이미지 정보가 올바르지 않습니다.');
  }
  const storagePath=requiredText(input.storagePath,260,'사용자 이미지 경로');
  if(!/^workspaces\/[0-9a-f-]{36}\/(?:single|series)\/[0-9a-f-]{36}\.(?:png|jpg|webp|gif)$/.test(storagePath)){
    throw new NativeRouletteValidationError('사용자 이미지 경로가 올바르지 않습니다.');
  }
  const mimeType=requiredChoice(input.mimeType,['image/png','image/jpeg','image/webp','image/gif'],'사용자 이미지 형식');
  const byteSize=safeInteger(input.byteSize,1,12*1024*1024,'사용자 이미지 용량');
  const width=safeInteger(input.width,1,4096,'사용자 이미지 가로 크기');
  const height=safeInteger(input.height,1,4096,'사용자 이미지 세로 크기');
  const sha256=requiredSha256(input.sha256,'사용자 이미지 확인값');
  return {storagePath,mimeType,byteSize,width,height,sha256};
}

// Web product-control drafts deliberately omit PC routing and audio volume.
// Those settings belong to the overlay control plane and are applied only when
// the dormant roulette runtime is activated after SOOP approval.
export function normalizeNativeRouletteWebDraft(input={}){
  const name=requiredText(input.name,120,'룰렛 이름');
  const balloonsPerSpin=safeInteger(input.balloonsPerSpin,1,1_000_000,'1회당 별풍선');
  const overlayAssetKey=requiredChoice(
    input.overlayAssetKey,
    Object.keys(NATIVE_ROULETTE_ASSET_BY_KEY),
    '룰렛 이미지'
  );
  const overlayAsset=NATIVE_ROULETTE_ASSET_BY_KEY[overlayAssetKey];
  const followupChatTtsWindowSeconds=NATIVE_ROULETTE_DEFAULT_FOLLOWUP_CHAT_TTS_WINDOW_SECONDS;
  if(input.seriesEnabled!==undefined&&typeof input.seriesEnabled!=='boolean'){
    throw new NativeRouletteValidationError('연차 설정 여부가 올바르지 않습니다.');
  }
  const seriesEnabled=input.seriesEnabled===true;
  const seriesBalloons=seriesEnabled
    ? safeInteger(input.seriesBalloons,1,1_000_000,'연차 별풍선 개수')
    : null;
  const seriesSpinCount=seriesEnabled
    ? safeInteger(input.seriesSpinCount,1,NATIVE_ROULETTE_MAX_SERIES_SPINS,'연차 룰렛 횟수')
    : null;
  if(seriesEnabled&&seriesBalloons===balloonsPerSpin){
    throw new NativeRouletteValidationError(
      '단차와 연차의 별풍선 개수는 서로 달라야 합니다.',
      'ambiguous_roulette_trigger'
    );
  }
  const customSingleImage=normalizeRouletteCustomImageReference(input.customSingleImage);
  const customSeriesImage=seriesEnabled
    ? normalizeRouletteCustomImageReference(input.customSeriesImage)
    : null;
  const items=normalizeNativeRouletteItems(input,name);
  return {
    name,
    balloonsPerSpin,
    seriesEnabled,
    seriesBalloons,
    seriesSpinCount,
    overlayAssetKey,
    overlayAssetSha256:overlayAsset.contentSha256,
    overlayAssetBytes:overlayAsset.byteSize,
    customSingleImage,
    customSeriesImage,
    followupChatTtsWindowSeconds,
    items
  };
}

// The web draft owns content while the overlay control plane owns the target
// Agent and audio levels.  Activation joins the two only after both sides have
// been validated, so saving content can never accidentally make it executable.
export function normalizeNativeRouletteOverlayRuntime(input={}){
  const agentDeviceId=requiredText(input.agentDeviceId,64,'실행 대상 PC');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentDeviceId)){
    throw new NativeRouletteValidationError('실행 대상 PC 식별값이 올바르지 않습니다.');
  }
  return {
    agentDeviceId:agentDeviceId.toLowerCase(),
    soundKey:requiredChoice(input.soundKey||'roulette_spin_v1',NATIVE_ROULETTE_SOUND_KEYS,'효과음'),
    soundVolumePercent:safeInteger(input.soundVolumePercent??80,0,100,'효과음 음량'),
    ttsVolumePercent:safeInteger(input.ttsVolumePercent??80,0,100,'TTS 음량')
  };
}

function activationImage(draft,kind){
  const custom=kind==='series'
    ? draft.customSeriesImage||draft.customSingleImage
    : draft.customSingleImage;
  if(custom)return {source:'custom',...custom};
  return {
    source:'catalog',
    assetKey:draft.overlayAssetKey,
    sha256:draft.overlayAssetSha256,
    byteSize:draft.overlayAssetBytes
  };
}

export function normalizeNativeRouletteActivation(input={}){
  const draft=normalizeNativeRouletteWebDraft(input.draft||{});
  const overlay=normalizeNativeRouletteOverlayRuntime(input.overlay||{});
  const triggers=[{
    kind:'single',
    balloons:draft.balloonsPerSpin,
    spinCount:1,
    image:activationImage(draft,'single')
  }];
  if(draft.seriesEnabled){
    triggers.push({
      kind:'series',
      balloons:draft.seriesBalloons,
      spinCount:draft.seriesSpinCount,
      image:activationImage(draft,'series')
    });
  }
  return {
    schemaVersion:2,
    ...draft,
    ...overlay,
    triggers
  };
}

// Native roulette v2 intentionally has no implicit multiplier rule.  A
// donation activates only one explicitly configured single/series trigger.
export function nativeRouletteSpinPlan(amount,activation){
  const donation=safeInteger(amount,1,1_000_000_000_000,'후원 별풍선');
  const triggers=Array.isArray(activation?.triggers)?activation.triggers:[];
  const matched=triggers.filter(trigger=>trigger?.balloons===donation);
  if(matched.length===0)return null;
  if(matched.length!==1){
    throw new NativeRouletteValidationError(
      '같은 별풍선 개수에 여러 룰렛 발동 조건이 연결되어 있습니다.',
      'ambiguous_roulette_trigger'
    );
  }
  const trigger=matched[0];
  return {
    kind:requiredChoice(trigger.kind,NATIVE_ROULETTE_TRIGGER_KINDS,'룰렛 발동 종류'),
    balloons:donation,
    spinCount:safeInteger(trigger.spinCount,1,NATIVE_ROULETTE_MAX_SERIES_SPINS,'룰렛 횟수'),
    image:trigger.image
  };
}

export function nativeRouletteSpinCount(amount,draft){
  const donation=safeInteger(amount,1,1_000_000_000_000,'후원 별풍선');
  const unit=safeInteger(draft?.balloonsPerSpin,1,1_000_000,'1회당 별풍선');
  if(draft?.allowMultipleSpins===true){
    return Math.min(NATIVE_ROULETTE_MAX_SPINS,Math.floor(donation/unit));
  }
  return donation===unit?1:0;
}

export function selectNativeRouletteItem(items,sample){
  const value=safeInteger(sample,0,NATIVE_ROULETTE_PROBABILITY_SCALE-1,'추첨 표본');
  let cursor=0;
  for(const item of items||[]){
    cursor+=safeInteger(item?.probabilityPpm,1,NATIVE_ROULETTE_PROBABILITY_SCALE,'상품 확률');
    if(value<cursor)return item;
  }
  throw new NativeRouletteValidationError('룰렛 확률 합계가 100%가 아닙니다.','probability_total_mismatch');
}

export function normalizeSoopDonationEnvelope(input={}, {allowWallpaperAdballoon=false,allowWallpaperVideo=false}={}){
  const eventId=requiredText(input.eventId,200,'SOOP 이벤트 ID');
  const actorId=requiredText(input.actor?.id,180,'후원자 SOOP ID').toLocaleLowerCase('en-US');
  const actorName=boundedText(input.actor?.name,120)||actorId;
  const amount=safeInteger(input.amount,1,SOOP_DONATION_MAX_BALLOONS,'후원 별풍선');
  const donationTypeLabel=requiredChoice(
    input.donationTypeLabel??'별풍선',[...SOOP_DONATION_TYPE_LABELS,...(allowWallpaperAdballoon?['애드벌룬']:[]),...(allowWallpaperVideo?['영상후원']:[])],'SOOP 후원 종류'
  );
  const message=boundedText(input.message,1000)||null;
  if(input.occurredAt===undefined||input.occurredAt===null||input.occurredAt===''){
    throw new NativeRouletteValidationError('SOOP 후원 시각이 필요합니다.');
  }
  const occurredAt=new Date(input.occurredAt);
  if(!Number.isFinite(occurredAt.getTime())){
    throw new NativeRouletteValidationError('후원 시각이 올바르지 않습니다.');
  }
  return {eventId,actor:{id:actorId,name:actorName},amount,donationTypeLabel,message,
    ceremonyImageUrl:normalizeSoopCeremonyImageUrl(input.ceremonyImageUrl??input.imageUrl),
    occurredAt:occurredAt.toISOString()};
}

const SOOP_CEREMONY_HOSTS=Object.freeze(['sooplive.com','afreecatv.com','afreecatvcdn.com']);
export function normalizeSoopCeremonyImageUrl(value){
  const raw=String(value??'').trim();
  if(!raw||raw.length>2048)return null;
  try{
    // The Chat SDK has historically returned both absolute and protocol-relative
    // ceremony URLs.  Upgrade allow-listed HTTP variants to HTTPS before the
    // strict URL check so an otherwise valid SOOP image is not discarded.
    const candidate=raw.startsWith('//')
      ?'https:'+raw
      :raw.startsWith('/')
        ?new URL(raw,'https://res.sooplive.com').href
        :raw.replace(/^http:\/\//i,'https://');
    const url=new URL(candidate);
    const hostname=url.hostname.toLowerCase();
    if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
    if(!SOOP_CEREMONY_HOSTS.some(root=>hostname===root||hostname.endsWith('.'+root)))return null;
    url.hash='';
    return url.href;
  }catch{return null}
}

export function normalizeSoopChatEnvelope(input={}){
  const eventId=requiredText(input.eventId,200,'SOOP 채팅 이벤트 ID');
  const actorId=requiredText(input.actor?.id,180,'채팅 작성자 SOOP ID').toLocaleLowerCase('en-US');
  const actorName=boundedText(input.actor?.name,120)||actorId;
  const message=requiredText(input.message,NATIVE_ROULETTE_MAX_CHAT_TTS_CHARACTERS,'채팅 메시지');
  if(input.occurredAt===undefined||input.occurredAt===null||input.occurredAt===''){
    throw new NativeRouletteValidationError('SOOP 채팅 시각이 필요합니다.');
  }
  const occurredAt=new Date(input.occurredAt);
  if(!Number.isFinite(occurredAt.getTime())){
    throw new NativeRouletteValidationError('채팅 시각이 올바르지 않습니다.');
  }
  return {eventId,actor:{id:actorId,name:actorName},message,occurredAt:occurredAt.toISOString()};
}

export function buildNativeRouletteSponsoredChatDispatch({
  profile,donation,chat=null,sourceKind='followup_chat'
}={}){
  const kind=requiredChoice(sourceKind,['donation_message','followup_chat'],'후원 채팅 종류');
  const donationEventId=requiredText(donation?.eventId,200,'SOOP 후원 이벤트 ID');
  const actor={
    id:requiredText(donation?.actor?.id,180,'후원자 SOOP ID').toLocaleLowerCase('en-US'),
    name:boundedText(donation?.actor?.name,120)||String(donation?.actor?.id||'')
  };
  const donatedAt=new Date(donation?.occurredAt);
  if(!Number.isFinite(donatedAt.getTime())){
    throw new NativeRouletteValidationError('후원 시각이 올바르지 않습니다.');
  }
  const windowSeconds=NATIVE_ROULETTE_DEFAULT_FOLLOWUP_CHAT_TTS_WINDOW_SECONDS;
  let message;
  let chatEventId=null;
  let chatOccurredAt=donatedAt;
  let elapsedSeconds=0;
  if(kind==='donation_message'){
    message=requiredText(donation?.message,NATIVE_ROULETTE_MAX_CHAT_TTS_CHARACTERS,'후원 메시지');
  }else{
    if(windowSeconds===0){
      throw new NativeRouletteValidationError('후원 후 첫 채팅 TTS가 꺼져 있습니다.');
    }
    chatEventId=requiredText(chat?.eventId,200,'SOOP 채팅 이벤트 ID');
    const chatActorId=requiredText(chat?.actor?.id,180,'채팅 작성자 SOOP ID').toLocaleLowerCase('en-US');
    if(chatActorId!==actor.id){
      throw new NativeRouletteValidationError('후원자와 채팅 작성자가 다릅니다.');
    }
    message=requiredText(chat?.message,NATIVE_ROULETTE_MAX_CHAT_TTS_CHARACTERS,'채팅 메시지');
    chatOccurredAt=new Date(chat?.occurredAt);
    if(!Number.isFinite(chatOccurredAt.getTime())){
      throw new NativeRouletteValidationError('채팅 시각이 올바르지 않습니다.');
    }
    const elapsedMilliseconds=chatOccurredAt.getTime()-donatedAt.getTime();
    elapsedSeconds=Math.round(elapsedMilliseconds/1000);
    if(elapsedMilliseconds<0||elapsedMilliseconds>windowSeconds*1000){
      throw new NativeRouletteValidationError('채팅이 후원 TTS 유효시간을 벗어났습니다.','followup_chat_outside_window');
    }
  }
  const displayText=kind==='followup_chat'?`[${elapsedSeconds}초전] ${actor.name} : ${message}`:message;
  const ttsText=message;
  return {
    schemaVersion:'1.0',
    kind:'donation_chat_tts',
    sourceEventKey:kind==='followup_chat'
      ?`soop-native-roulette-chat:${chatEventId}`
      :`soop-native-roulette-chat:${donationEventId}:donation-message`,
    donationEventId,
    chatEventId,
    sourceKind:kind,
    actor,
    amount:safeInteger(donation?.amount,1,1_000_000_000_000,'후원 별풍선'),
    message,
    displayText,
    ttsText,
    elapsedSeconds,
    chatOccurredAt:chatOccurredAt.toISOString(),
    playAfterDonationResults:true,
    dynamicTts:true,
    ttsVolumePercent:safeInteger(profile?.ttsVolumePercent,0,100,'TTS 음량')
  };
}

export function buildNativeRouletteDispatch({profile,item,donation,spinIndex,sourceEventKey}){
  const resultText=requiredGraphemeText(item?.resultText,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,'룰렛 결과');
  const eventKey=requiredText(sourceEventKey,240,'결과 이벤트 ID');
  const actor={
    id:requiredText(donation?.actor?.id,180,'후원자 SOOP ID'),
    name:boundedText(donation?.actor?.name,120)||String(donation?.actor?.id||'')
  };
  if(item?.directUpbo===true){
    return {
      kind:'direct_upbo',
      skipAutomation:true,
      skipPresentation:true,
      sourceEventKey:eventKey,
      profileId:profile?.id||null,
      itemId:item?.id||null,
      result:resultText,
      eventName:boundedText(item?.upboEventName,120)||requiredText(profile?.name,120,'룰렛 이름'),
      outputTypes:splitDirectUpboOutputs(resultText),
      quantity:1,
      actor
    };
  }
  return {
    kind:'automation_event',
    skipAutomation:false,
    skipPresentation:false,
    presentation:{
      schemaVersion:'1.0',
      kind:'native_roulette_result',
      overlayAssetKey:requiredText(profile?.overlayAssetKey,64,'룰렛 이미지'),
      overlayAssetSha256:requiredSha256(profile?.overlayAssetSha256,'룰렛 이미지 해시'),
      soundKey:requiredText(profile?.soundKey,64,'효과음'),
      soundVolumePercent:safeInteger(profile?.soundVolumePercent,0,100,'효과음 음량'),
      ttsText:requiredGraphemeText(item?.ttsText,NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,'TTS 문구'),
      ttsVoiceKey:requiredSha256(item?.ttsVoiceKey,'TTS 캐시 키'),
      ttsVolumePercent:safeInteger(profile?.ttsVolumePercent,0,100,'TTS 음량')
    },
    event:{
      schemaVersion:'1.0',
      externalEventId:eventKey,
      source:'byeollog',
      platform:'soop',
      eventType:'roulette',
      subtype:'native',
      actor,
      amount:donation?.amount??null,
      currency:'balloon',
      occurredAt:donation?.occurredAt||null,
      payload:{
        result:resultText,
        spinIndex:safeInteger(spinIndex,0,NATIVE_ROULETTE_MAX_SPINS-1,'룰렛 회차'),
        rouletteProfileId:profile?.id||null,
        rouletteItemId:item?.id||null,
        donationEventId:donation?.eventId||null
      }
    }
  };
}
