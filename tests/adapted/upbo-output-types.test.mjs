import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"frontend");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {splitUpboOutputTypes} from '../../apps/web/lib/collector-processor.js';
import {getRouletteClassificationHtml} from '../../apps/web/lib/roulette-classification-html.js';

test('new SDK and learned Upbo processing split every ampersand-delimited product name',()=>{
  assert.deepEqual(splitUpboOutputTypes('노래 & 춤 & 벌칙'),['노래','춤','벌칙']);
  assert.deepEqual(splitUpboOutputTypes('  노래&& 춤  '),['노래','춤']);
  assert.deepEqual(splitUpboOutputTypes('A 단컷 & 움짤'),['A 단컷','움짤']);
});

test('server task creation applies the shared split to learned and fixed Upbo paths',async()=>{
  const source=await readFile(auditURL('../lib/collector-processor.js',import.meta.url),'utf8');
  assert.match(source,/rawOuts\.flatMap\(splitUpboOutputTypes\)/);
  assert.match(source,/types=splitUpboOutputTypes\(reward\.upbo_type\)/);
  assert.match(source,/soopSdk\?'soop_chat_sdk_result'/);
});

test('web fixed Upbo settings explain the ampersand behavior and bound its fan-out',async()=>{
  const page=getRouletteClassificationHtml('test-nonce');
  const api=await readFile(auditURL('../api/admin.js',import.meta.url),'utf8');
  assert.match(page,/여러 업보는 <b>&amp;<\/b>로 구분하면 각각 등록됩니다/);
  assert.match(page,/노래 한 곡 &amp; 춤 한 곡/);
  assert.match(api,/outputTypes\.length>20/);
});
