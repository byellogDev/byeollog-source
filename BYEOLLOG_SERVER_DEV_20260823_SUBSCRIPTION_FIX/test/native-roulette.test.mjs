import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import sharp from 'sharp';
import {
  NATIVE_ROULETTE_PROBABILITY_SCALE,
  NATIVE_ROULETTE_MAX_RESULT_CODE_POINTS,
  NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,
  buildNativeRouletteSponsoredChatDispatch,
  buildNativeRouletteDispatch,
  nativeRouletteSpinCount,
  nativeRouletteSpinPlan,
  nativeRouletteTtsVoiceKey,
  normalizeNativeRouletteActivation,
  normalizeNativeRouletteDraft,
  normalizeNativeRouletteWebDraft,
  normalizeSoopChatEnvelope,
  normalizeSoopDonationEnvelope,
  probabilityPercentToPpm,
  selectNativeRouletteItem,
  splitDirectUpboOutputs,
  unicodeGraphemeCount
} from '../lib/native-roulette.js';
import {NATIVE_ROULETTE_ASSETS} from '../lib/native-roulette-assets.js';

const DEVICE_ID='20000000-0000-4000-8000-000000000001';

function draft(overrides={}){
  return {
    name:'방송 룰렛',balloonsPerSpin:30,allowMultipleSpins:true,agentDeviceId:DEVICE_ID,
    overlayAssetKey:'roulette_navy_gold_v1',soundKey:'roulette_spin_v1',
    soundVolumePercent:75,ttsVolumePercent:85,
    followupChatTtsWindowSeconds:10,
    items:[
      {resultText:'노래 & 춤',probabilityPpm:250000,directUpbo:true,upboEventName:'8월 이벤트'},
      {resultText:'간식 당첨',probabilityPpm:750000,directUpbo:false,ttsText:'간식 당첨!'}
    ],
    ...overrides
  };
}

test('catalog pins exactly the seven final wheel-only WebP identities',async t=>{
  assert.equal(NATIVE_ROULETTE_ASSETS.length,7);
  assert.equal(new Set(NATIVE_ROULETTE_ASSETS.map(asset=>asset.key)).size,7);
  for(const asset of NATIVE_ROULETTE_ASSETS){
    assert.match(asset.fileName,/^roulette-0[1-7]-.*-clean-edge\.webp$/);
    assert.match(asset.previewUrl,/^\/assets\/roulette-previews\/roulette-0[1-7]-.*\.webp$/);
    const previewUrl=new URL(`../${asset.previewUrl.slice(1)}`,import.meta.url);
    assert.equal(existsSync(previewUrl),true);
    await t.test(`reviewed preview digest ${asset.previewUrl.split('/').at(-1)}`,async()=>{
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of createReadStream(fileURLToPath(previewUrl))){hash.update(chunk);bytes+=chunk.length}
      assert.equal(bytes,asset.previewByteSize);assert.equal(hash.digest('hex'),asset.previewSha256);
      const {data,info}=await sharp(fileURLToPath(previewUrl))
        .ensureAlpha()
        .raw()
        .toBuffer({resolveWithObject:true});
      let lowerAlphaMax=0;
      for(let y=720;y<info.height;y+=1){
        for(let x=0;x<info.width;x+=1){
          lowerAlphaMax=Math.max(lowerAlphaMax,data[(y*info.width+x)*info.channels+3]);
        }
      }
      assert.equal(lowerAlphaMax,0,'result bar area must remain fully transparent');
    });
    assert.equal(asset.mimeType,'image/webp');
    assert.equal(asset.widthPx,1920);assert.equal(asset.heightPx,1080);
    assert.equal(asset.frameCount,91);assert.equal(asset.durationMs,4800);
    assert.equal(asset.presentationDurationMs,3000);
    assert.equal(asset.deliveryStatus,'published');assert.match(asset.contentSha256,/^[0-9a-f]{64}$/);
    assert.match(asset.publishedPath,/^assets\/native-roulette\/[0-9a-f]{64}\.webp$/);
    const sourceUrl=new URL(`../../${asset.sourceRelativePath}`,import.meta.url);
    if(!existsSync(sourceUrl))continue;
    await t.test(`local source digest ${asset.fileName}`,async()=>{
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of createReadStream(fileURLToPath(sourceUrl))){hash.update(chunk);bytes+=chunk.length}
      assert.equal(bytes,asset.byteSize);assert.equal(hash.digest('hex'),asset.contentSha256);
    });
  }
});

test('draft normalization binds WebP, sound, exact TTS keys, and direct upbo split',()=>{
  const value=normalizeNativeRouletteDraft(draft());
  assert.equal(value.overlayAssetSha256,NATIVE_ROULETTE_ASSETS[0].contentSha256);
  assert.equal(value.overlayAssetBytes,NATIVE_ROULETTE_ASSETS[0].byteSize);
  assert.equal(value.followupChatTtsWindowSeconds,15);
  assert.deepEqual(value.items[0].outputTypes,['노래','춤']);
  assert.equal(value.items[0].ttsText,null);assert.equal(value.items[0].ttsVoiceKey,null);
  assert.equal(value.items[1].ttsText,'간식 당첨');
  assert.equal(value.items[1].ttsVoiceKey,nativeRouletteTtsVoiceKey('간식 당첨'));
  assert.equal(value.items.reduce((sum,item)=>sum+item.probabilityPpm,0),NATIVE_ROULETTE_PROBABILITY_SCALE);
});

test('direct upbo uses only generic ampersand parsing',()=>{
  assert.deepEqual(splitDirectUpboOutputs('A 단컷 & 움짤'),['A 단컷','움짤']);
  assert.deepEqual(splitDirectUpboOutputs('노래 & 춤 & 벌칙'),['노래','춤','벌칙']);
});

test('roulette product names use a Unicode-safe 20 grapheme contract',()=>{
  const twenty='가나다라마바사아자차카타파하거너더러머버';
  assert.equal(unicodeGraphemeCount(twenty),NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES);
  assert.equal(unicodeGraphemeCount('가족👨‍👩‍👧‍👦'),3);
  const normalized=normalizeNativeRouletteDraft(draft({items:[
    {resultText:twenty,probabilityPpm:500000,directUpbo:false},
    {resultText:'짧은 상품',probabilityPpm:500000,directUpbo:false}
  ]}));
  assert.equal(normalized.items[0].resultText,twenty);
  assert.throws(()=>normalizeNativeRouletteDraft(draft({items:[
    {resultText:twenty+'보',probabilityPpm:500000,directUpbo:false},
    {resultText:'짧은 상품',probabilityPpm:500000,directUpbo:false}
  ]})),error=>error?.code==='native_roulette_text_too_long'&&/20자 이내/.test(error.message));

  const family='👨‍👩‍👧‍👦';
  const twentyFamilies=family.repeat(20);
  assert.equal(unicodeGraphemeCount(twentyFamilies),20);
  assert.equal(normalizeNativeRouletteDraft(draft({items:[
    {resultText:twentyFamilies,probabilityPpm:500000,directUpbo:false},
    {resultText:'짧은 상품',probabilityPpm:500000,directUpbo:false}
  ]})).items[0].resultText,twentyFamilies);
  assert.throws(()=>normalizeNativeRouletteDraft(draft({items:[
    {resultText:family.repeat(21),probabilityPpm:500000,directUpbo:false},
    {resultText:'짧은 상품',probabilityPpm:500000,directUpbo:false}
  ]})),error=>error?.code==='native_roulette_text_too_long');

  const oversizedSingleGrapheme='가'+'\u0301'.repeat(NATIVE_ROULETTE_MAX_RESULT_CODE_POINTS);
  assert.equal(unicodeGraphemeCount(oversizedSingleGrapheme),1);
  assert.throws(()=>normalizeNativeRouletteDraft(draft({items:[
    {resultText:oversizedSingleGrapheme,probabilityPpm:500000,directUpbo:false},
    {resultText:'짧은 상품',probabilityPpm:500000,directUpbo:false}
  ]})),error=>error?.code==='native_roulette_text_too_large');

  assert.throws(()=>normalizeNativeRouletteDraft(draft({items:[
    {resultText:'é',probabilityPpm:500000,directUpbo:false},
    {resultText:'e\u0301',probabilityPpm:500000,directUpbo:false}
  ]})),error=>error instanceof Error&&/같은 상품명/.test(error.message));
});

test('direct upbo dispatch skips presentation and every automation action',()=>{
  const normalized=normalizeNativeRouletteDraft(draft());
  const dispatch=buildNativeRouletteDispatch({
    profile:{id:'profile',...normalized},item:{id:'item',...normalized.items[0]},
    donation:{actor:{id:'viewer',name:'시청자'},amount:30,eventId:'event',occurredAt:'2026-08-25T00:00:00.000Z'},
    spinIndex:0,sourceEventKey:'soop-native-roulette:event:0'
  });
  assert.equal(dispatch.kind,'direct_upbo');assert.equal(dispatch.skipAutomation,true);
  assert.equal(dispatch.skipPresentation,true);assert.equal('event' in dispatch,false);
  assert.deepEqual(dispatch.outputTypes,['노래','춤']);
});

test('ordinary result dispatch carries overlay, sound, cached TTS, and canonical action condition event',()=>{
  const normalized=normalizeNativeRouletteDraft(draft());
  const dispatch=buildNativeRouletteDispatch({
    profile:{id:'profile',...normalized},item:{id:'item',...normalized.items[1]},
    donation:{actor:{id:'viewer',name:'시청자'},amount:30,eventId:'event',occurredAt:'2026-08-25T00:00:00.000Z'},
    spinIndex:0,sourceEventKey:'soop-native-roulette:event:0'
  });
  assert.equal(dispatch.kind,'automation_event');assert.equal(dispatch.skipPresentation,false);
  assert.equal(dispatch.presentation.overlayAssetKey,'roulette_navy_gold_v1');
  assert.equal(dispatch.presentation.soundKey,'roulette_spin_v1');
  assert.equal(dispatch.presentation.ttsVoiceKey,nativeRouletteTtsVoiceKey('간식 당첨'));
  assert.equal(dispatch.event.source,'byeollog');assert.equal(dispatch.event.platform,'soop');
  assert.equal(dispatch.event.eventType,'roulette');assert.equal(dispatch.event.payload.result,'간식 당첨');
});

test('probability and spin boundaries are exact and deterministic',()=>{
  assert.equal(probabilityPercentToPpm('12.3456'),123456);
  assert.throws(()=>normalizeNativeRouletteDraft(draft({items:[
    {resultText:'A',probabilityPpm:1,directUpbo:false},{resultText:'B',probabilityPpm:2,directUpbo:false}
  ]})),/정확히 100%/);
  const normalized=normalizeNativeRouletteDraft(draft());
  assert.equal(nativeRouletteSpinCount(29,normalized),0);assert.equal(nativeRouletteSpinCount(90,normalized),3);
  assert.equal(selectNativeRouletteItem(normalized.items,249999).resultText,'노래 & 춤');
  assert.equal(selectNativeRouletteItem(normalized.items,250000).resultText,'간식 당첨');
});

test('SOOP donation identity requires the provider event time instead of inventing one',()=>{
  assert.throws(()=>normalizeSoopDonationEnvelope({
    eventId:'event',actor:{id:'Viewer',name:'시청자'},amount:30
  }),/후원 시각/);
  const value=normalizeSoopDonationEnvelope({
    eventId:'event',actor:{id:'Viewer',name:'시청자'},amount:30,
    occurredAt:'2026-08-25T00:00:00.000Z'
  });
  assert.equal(value.actor.id,'viewer');assert.equal(value.occurredAt,'2026-08-25T00:00:00.000Z');
  assert.equal(value.donationTypeLabel,'별풍선');
  assert.equal(normalizeSoopDonationEnvelope({...value,donationTypeLabel:'도전미션'}).donationTypeLabel,'도전미션');
  assert.throws(()=>normalizeSoopDonationEnvelope({...value,donationTypeLabel:'임의후원'}),/후원 종류/);
});

test('message-less donation binds only the same viewer first chat inside the configured window',()=>{
  const profile=normalizeNativeRouletteDraft(draft());
  const donation={
    eventId:'donation-1',actor:{id:'viewer_example',name:'테스트 시청자'},amount:33,message:null,
    occurredAt:'2026-08-26T00:36:31.216Z'
  };
  const chat=normalizeSoopChatEnvelope({
    eventId:'chat-1',actor:{id:'VIEWER_EXAMPLE',name:'테스트 시청자'},message:'딸깍',
    occurredAt:'2026-08-26T00:36:41.066Z'
  });
  const dispatch=buildNativeRouletteSponsoredChatDispatch({profile,donation,chat});
  assert.equal(dispatch.kind,'donation_chat_tts');
  assert.equal(dispatch.elapsedSeconds,10);
  assert.equal(dispatch.displayText,'[10초전] 테스트 시청자 : 딸깍');
  assert.equal(dispatch.ttsText,'딸깍');
  assert.equal(dispatch.playAfterDonationResults,true);
  assert.equal(dispatch.dynamicTts,true);
  assert.throws(()=>buildNativeRouletteSponsoredChatDispatch({
    profile,donation,chat:{...chat,actor:{id:'other',name:'다른 시청자'}}
  }),/후원자와 채팅 작성자가 다릅니다/);
  assert.throws(()=>buildNativeRouletteSponsoredChatDispatch({
    profile,donation,chat:{...chat,eventId:'late',occurredAt:'2026-08-26T00:36:46.217Z'}
  }),/유효시간/);
});

test('donation message is dispatched once without arming a follow-up chat',()=>{
  const profile=normalizeNativeRouletteDraft(draft());
  const dispatch=buildNativeRouletteSponsoredChatDispatch({
    profile,sourceKind:'donation_message',
    donation:{
      eventId:'donation-message',actor:{id:'viewer',name:'시청자'},amount:30,
      message:'후원과 함께 보낸 메시지',occurredAt:'2026-08-26T00:00:00.000Z'
    }
  });
  assert.equal(dispatch.sourceKind,'donation_message');
  assert.equal(dispatch.elapsedSeconds,0);
  assert.equal(dispatch.displayText,'후원과 함께 보낸 메시지');
  assert.equal(dispatch.ttsText,'후원과 함께 보낸 메시지');
});

test('follow-up chat TTS window is fixed at 15 seconds regardless of stale draft input',()=>{
  assert.equal(normalizeNativeRouletteDraft(draft({followupChatTtsWindowSeconds:61})).followupChatTtsWindowSeconds,15);
  const profile=normalizeNativeRouletteDraft(draft({followupChatTtsWindowSeconds:0}));
  assert.equal(profile.followupChatTtsWindowSeconds,15);
  const dispatch=buildNativeRouletteSponsoredChatDispatch({
    profile,
    donation:{eventId:'d',actor:{id:'viewer'},amount:30,occurredAt:'2026-08-26T00:00:00.000Z'},
    chat:{eventId:'c',actor:{id:'viewer'},message:'채팅',occurredAt:'2026-08-26T00:00:00.100Z'}
  });
  assert.equal(dispatch.ttsText,'채팅');
});

test('activation joins web content with overlay routing without restoring multiplier donations',()=>{
  const activation=normalizeNativeRouletteActivation({
    draft:{
      name:'자체 룰렛',balloonsPerSpin:33,seriesEnabled:true,
      seriesBalloons:330,seriesSpinCount:10,
      overlayAssetKey:'roulette_navy_gold_v1',followupChatTtsWindowSeconds:10,
      customSingleImage:null,customSeriesImage:null,
      items:[
        {resultText:'A',probabilityPpm:500000,directUpbo:false},
        {resultText:'B',probabilityPpm:500000,directUpbo:true}
      ]
    },
    overlay:{agentDeviceId:DEVICE_ID,soundVolumePercent:70,ttsVolumePercent:90}
  });
  assert.equal(activation.schemaVersion,2);
  assert.equal(activation.agentDeviceId,DEVICE_ID);
  assert.deepEqual(activation.triggers.map(item=>[item.kind,item.balloons,item.spinCount]),[
    ['single',33,1],['series',330,10]
  ]);
  assert.equal(nativeRouletteSpinPlan(33,activation).spinCount,1);
  assert.equal(nativeRouletteSpinPlan(330,activation).spinCount,10);
  assert.equal(nativeRouletteSpinPlan(66,activation),null);
});

test('series image falls back to the single image and ambiguous trigger prices fail closed',()=>{
  const singleImage={
    storagePath:'workspaces/20000000-0000-4000-8000-000000000001/single/30000000-0000-4000-8000-000000000001.webp',
    mimeType:'image/webp',byteSize:1024,width:1920,height:1080,
    sha256:'a'.repeat(64)
  };
  const activation=normalizeNativeRouletteActivation({
    draft:{
      name:'이미지 룰렛',balloonsPerSpin:10,seriesEnabled:true,
      seriesBalloons:100,seriesSpinCount:10,
      overlayAssetKey:'roulette_navy_gold_v1',customSingleImage:singleImage,
      items:[
        {resultText:'A',probabilityPpm:500000,directUpbo:false},
        {resultText:'B',probabilityPpm:500000,directUpbo:false}
      ]
    },
    overlay:{agentDeviceId:DEVICE_ID}
  });
  assert.equal(activation.triggers[0].image.source,'custom');
  assert.deepEqual(activation.triggers[1].image,activation.triggers[0].image);
  assert.throws(()=>normalizeNativeRouletteWebDraft({
    name:'충돌 룰렛',balloonsPerSpin:100,seriesEnabled:true,
    seriesBalloons:100,seriesSpinCount:10,
    overlayAssetKey:'roulette_navy_gold_v1',
    items:[
      {resultText:'A',probabilityPpm:500000,directUpbo:false},
      {resultText:'B',probabilityPpm:500000,directUpbo:false}
    ]
  }),error=>error?.code==='ambiguous_roulette_trigger');
});
