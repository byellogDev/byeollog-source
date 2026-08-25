import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReadStream,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {
  NATIVE_ROULETTE_PROBABILITY_SCALE,
  buildNativeRouletteDispatch,
  nativeRouletteSpinCount,
  nativeRouletteTtsVoiceKey,
  normalizeNativeRouletteDraft,
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
