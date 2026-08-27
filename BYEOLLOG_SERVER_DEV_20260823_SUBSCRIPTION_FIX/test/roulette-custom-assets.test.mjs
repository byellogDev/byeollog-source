import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROULETTE_ASSET_MAX_BYTES,RouletteAssetError,inspectRouletteImageBytes,
  validateRouletteUploadRequest,assertRouletteAssetWorkspace,rouletteAssetPaths
} from '../lib/roulette-custom-assets.js';
import {normalizeNativeRouletteWebDraft} from '../lib/native-roulette.js';

const workspace='11111111-1111-4111-8111-111111111111';
const path=`workspaces/${workspace}/single/22222222-2222-4222-8222-222222222222.png`;

function minimalPng(){
  const bytes=Buffer.alloc(45);
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]).copy(bytes,0);
  bytes.writeUInt32BE(13,8);
  bytes.write('IHDR',12,'ascii');
  bytes.writeUInt32BE(1920,16);
  bytes.writeUInt32BE(1080,20);
  Buffer.from([0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82]).copy(bytes,37);
  return bytes;
}

test('custom roulette upload request is bounded to safe image types and size',()=>{
  assert.deepEqual(validateRouletteUploadRequest({kind:'single',mimeType:'image/png',byteSize:123}),{
    kind:'single',mimeType:'image/png',byteSize:123,extension:'png'
  });
  assert.throws(()=>validateRouletteUploadRequest({kind:'single',mimeType:'image/svg+xml',byteSize:123}),RouletteAssetError);
  assert.throws(()=>validateRouletteUploadRequest({kind:'series',mimeType:'image/png',byteSize:ROULETTE_ASSET_MAX_BYTES+1}),RouletteAssetError);
});

test('custom roulette image inspection uses file signatures and bounded dimensions',()=>{
  const valid=inspectRouletteImageBytes(minimalPng());
  assert.equal(valid.mimeType,'image/png');
  assert.deepEqual([valid.width,valid.height],[1920,1080]);
  assert.match(valid.sha256,/^[0-9a-f]{64}$/);
  const broken=minimalPng();broken[40]=0;
  assert.throws(()=>inspectRouletteImageBytes(broken),RouletteAssetError);
  const huge=minimalPng();huge.writeUInt32BE(4097,16);
  assert.throws(()=>inspectRouletteImageBytes(huge),/4096px/);
});

test('custom roulette image paths stay inside the authenticated workspace',()=>{
  assert.equal(assertRouletteAssetWorkspace(path,workspace),path);
  assert.throws(
    ()=>assertRouletteAssetWorkspace(path,'33333333-3333-4333-8333-333333333333'),
    /다른 워크스페이스/
  );
  assert.deepEqual(rouletteAssetPaths({customSingleImage:{storagePath:path},customSeriesImage:{storagePath:path}}),[path]);
});

test('web draft keeps custom single image and falls back to it when series image is absent',()=>{
  const reference={
    storagePath:path,mimeType:'image/png',byteSize:45,width:1920,height:1080,
    sha256:'a'.repeat(64),previewUrl:'https://untrusted.example/ignored.png'
  };
  const draft=normalizeNativeRouletteWebDraft({
    name:'사용자 이미지 룰렛',balloonsPerSpin:30,seriesEnabled:true,seriesBalloons:100,seriesSpinCount:4,
    overlayAssetKey:'roulette_navy_gold_v1',customSingleImage:reference,customSeriesImage:null,
    items:[
      {resultText:'당첨',probabilityPpm:500000,directUpbo:false},
      {resultText:'꽝',probabilityPpm:500000,directUpbo:false}
    ]
  });
  assert.equal(draft.customSingleImage.storagePath,path);
  assert.equal(draft.customSeriesImage,null);
  assert.equal(Object.hasOwn(draft.customSingleImage,'previewUrl'),false);
});
