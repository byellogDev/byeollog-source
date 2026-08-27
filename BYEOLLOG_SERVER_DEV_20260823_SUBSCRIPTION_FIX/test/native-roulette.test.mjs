import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  NATIVE_ROULETTE_PROBABILITY_SCALE,
  buildNativeRouletteSponsoredChatDispatch,
  buildNativeRouletteDispatch,
  nativeRouletteSpinCount,
  nativeRouletteTtsVoiceKey,
  normalizeNativeRouletteDraft,
  normalizeSoopChatEnvelope,
  normalizeSoopDonationEnvelope,
  probabilityPercentToPpm,
  selectNativeRouletteItem,
  splitDirectUpboOutputs
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

test('catalog pins exactly the seven final clean-edge WebP identities',async t=>{
  assert.equal(NATIVE_ROULETTE_ASSETS.length,7);
  assert.equal(new Set(NATIVE_ROULETTE_ASSETS.map(asset=>asset.key)).size,7);
  for(const asset of NATIVE_ROULETTE_ASSETS){
    assert.match(asset.fileName,/^roulette-0[1-7]-.*-clean-edge\.webp$/);
    assert.match(asset.previewUrl,/^\/assets\/roulette-previews\/roulette-0[1-7]-.*\.png$/);
    const previewUrl=new URL(`../${asset.previewUrl.slice(1)}`,import.meta.url);
    assert.equal(existsSync(previewUrl),true);
    await t.test(`reviewed preview digest ${asset.previewUrl.split('/').at(-1)}`,async()=>{
      const hash=createHash('sha256');let bytes=0;
      for await(const chunk of createReadStream(fileURLToPath(previewUrl))){hash.update(chunk);bytes+=chunk.length}
      assert.equal(bytes,asset.previewByteSize);assert.equal(hash.digest('hex'),asset.previewSha256);
    });
    assert.equal(asset.mimeType,'image/webp');
    assert.equal(asset.widthPx,1920);assert.equal(asset.heightPx,1080);
    assert.equal(asset.frameCount,91);assert.equal(asset.durationMs,4800);
    assert.equal(asset.deliveryStatus,'staged');assert.match(asset.contentSha256,/^[0-9a-f]{64}$/);
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
  assert.equal(value.followupChatTtsWindowSeconds,10);
  assert.deepEqual(value.items[0].outputTypes,['노래','춤']);
  assert.equal(value.items[0].ttsText,null);assert.equal(value.items[0].ttsVoiceKey,null);
  assert.equal(value.items[1].ttsText,'간식 당첨!');
  assert.equal(value.items[1].ttsVoiceKey,nativeRouletteTtsVoiceKey('간식 당첨!'));
  assert.equal(value.items.reduce((sum,item)=>sum+item.probabilityPpm,0),NATIVE_ROULETTE_PROBABILITY_SCALE);
});

test('direct upbo uses only generic ampersand parsing',()=>{
  assert.deepEqual(splitDirectUpboOutputs('A 단컷 & 움짤'),['A 단컷','움짤']);
  assert.deepEqual(splitDirectUpboOutputs('노래 & 춤 & 벌칙'),['노래','춤','벌칙']);
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
  assert.equal(dispatch.presentation.ttsVoiceKey,nativeRouletteTtsVoiceKey('간식 당첨!'));
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
});

test('message-less donation binds only the same viewer first chat inside the configured window',()=>{
  const profile=normalizeNativeRouletteDraft(draft());
  const donation={
    eventId:'donation-1',actor:{id:'sejuari',name:'로기랑지유니'},amount:33,message:null,
    occurredAt:'2026-08-26T00:36:31.216Z'
  };
  const chat=normalizeSoopChatEnvelope({
    eventId:'chat-1',actor:{id:'SEJUARI',name:'로기랑지유니'},message:'딸깍',
    occurredAt:'2026-08-26T00:36:41.066Z'
  });
  const dispatch=buildNativeRouletteSponsoredChatDispatch({profile,donation,chat});
  assert.equal(dispatch.kind,'donation_chat_tts');
  assert.equal(dispatch.elapsedSeconds,10);
  assert.equal(dispatch.displayText,'[10초전] 로기랑지유니 : 딸깍');
  assert.equal(dispatch.ttsText,'딸깍');
  assert.equal(dispatch.playAfterDonationResults,true);
  assert.equal(dispatch.dynamicTts,true);
  assert.throws(()=>buildNativeRouletteSponsoredChatDispatch({
    profile,donation,chat:{...chat,actor:{id:'other',name:'다른 시청자'}}
  }),/후원자와 채팅 작성자가 다릅니다/);
  assert.throws(()=>buildNativeRouletteSponsoredChatDispatch({
    profile,donation,chat:{...chat,eventId:'late',occurredAt:'2026-08-26T00:36:41.217Z'}
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

test('follow-up chat TTS window is bounded and zero disables deferred matching',()=>{
  assert.throws(()=>normalizeNativeRouletteDraft(draft({followupChatTtsWindowSeconds:61})),/유효시간/);
  const profile=normalizeNativeRouletteDraft(draft({followupChatTtsWindowSeconds:0}));
  assert.equal(profile.followupChatTtsWindowSeconds,0);
  assert.throws(()=>buildNativeRouletteSponsoredChatDispatch({
    profile,
    donation:{eventId:'d',actor:{id:'viewer'},amount:30,occurredAt:'2026-08-26T00:00:00.000Z'},
    chat:{eventId:'c',actor:{id:'viewer'},message:'채팅',occurredAt:'2026-08-26T00:00:00.100Z'}
  }),/꺼져 있습니다/);
});
