import crypto from 'node:crypto';
import {NATIVE_ROULETTE_ASSET_BY_KEY} from './native-roulette-assets.js';

export const NATIVE_ROULETTE_PROBABILITY_SCALE=1_000_000;
export const NATIVE_ROULETTE_MAX_ITEMS=100;
export const NATIVE_ROULETTE_MAX_SPINS=100;
export const NATIVE_ROULETTE_TTS_KEY_DOMAIN='native-roulette-result-v1|';
export const NATIVE_ROULETTE_SOUND_KEYS=Object.freeze(['roulette_spin_v1']);

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
  const text=requiredText(value,160,'TTS 문구');
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
  const text=requiredText(value,200,'상품명');
  const outputs=text.split(/\s*&\s*/).map(item=>item.trim()).filter(Boolean);
  if(!outputs.length||outputs.length>20||outputs.some(item=>item.length>120)){
    throw new NativeRouletteValidationError('업보 상품의 & 분리 결과가 올바르지 않습니다.');
  }
  return outputs;
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
  const agentDeviceId=requiredText(input.agentDeviceId,64,'캐시 대상 PC');
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agentDeviceId)){
    throw new NativeRouletteValidationError('캐시 대상 PC 식별값이 올바르지 않습니다.');
  }
  if(typeof input.allowMultipleSpins!=='boolean'){
    throw new NativeRouletteValidationError('배수 후원 허용 여부가 필요합니다.');
  }
  const allowMultipleSpins=input.allowMultipleSpins;
  if(!Array.isArray(input.items)||input.items.length<2||input.items.length>NATIVE_ROULETTE_MAX_ITEMS){
    throw new NativeRouletteValidationError(`상품은 2개 이상 ${NATIVE_ROULETTE_MAX_ITEMS}개 이하로 설정하세요.`);
  }

  const seen=new Set();
  let total=0;
  const items=input.items.map((item,index)=>{
    const resultText=requiredText(item?.resultText,200,`${index+1}번 상품명`);
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
    const ttsText=directUpbo
      ? null
      : boundedText(item?.ttsText,160)||`${resultText}, 당첨!`;
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
    items
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

export function normalizeSoopDonationEnvelope(input={}){
  const eventId=requiredText(input.eventId,200,'SOOP 이벤트 ID');
  const actorId=requiredText(input.actor?.id,180,'후원자 SOOP ID').toLocaleLowerCase('en-US');
  const actorName=boundedText(input.actor?.name,120)||actorId;
  const amount=safeInteger(input.amount,1,1_000_000_000_000,'후원 별풍선');
  const message=boundedText(input.message,1000)||null;
  if(input.occurredAt===undefined||input.occurredAt===null||input.occurredAt===''){
    throw new NativeRouletteValidationError('SOOP 후원 시각이 필요합니다.');
  }
  const occurredAt=new Date(input.occurredAt);
  if(!Number.isFinite(occurredAt.getTime())){
    throw new NativeRouletteValidationError('후원 시각이 올바르지 않습니다.');
  }
  return {eventId,actor:{id:actorId,name:actorName},amount,message,occurredAt:occurredAt.toISOString()};
}

export function buildNativeRouletteDispatch({profile,item,donation,spinIndex,sourceEventKey}){
  const resultText=requiredText(item?.resultText,200,'룰렛 결과');
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
      ttsText:requiredText(item?.ttsText,160,'TTS 문구'),
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
