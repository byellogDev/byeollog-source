import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"collector-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  collectorSubscriptionInfo,
  normalizeCollectorRawPayload
} from '../../apps/collector-runtime/lib/collector-subscription.js';
import {ADMIN_HTML_BASE64} from '../../apps/collector-runtime/lib/admin-html.js';

test('FOLLOW_ITEM_EFFECT with gudok image is a subscription, not three balloons',()=>{
  const raw={
    type:'FOLLOW_ITEM_EFFECT',
    subtype:'FOLLOW_ITEM_EFFECT',
    value:'3',
    img:'https://static.file.sooplive.com/subscription_ceremony/m/gudok_3.png'
  };
  assert.deepEqual(
    collectorSubscriptionInfo(raw),
    {
      isSubscription:true,
      months:3,
      type:'FOLLOW_ITEM_EFFECT',
      subtype:'FOLLOW_ITEM_EFFECT',
      img:raw.img
    }
  );
  assert.deepEqual(normalizeCollectorRawPayload(raw),{
    ...raw,
    collector_event_kind:'subscription',
    subscription_months:3
  });
});

test('normal SENDBALLOON remains a donation',()=>{
  const raw={type:'SENDBALLOON',subtype:'SENDBALLOON',value:'3'};
  assert.equal(collectorSubscriptionInfo(raw).isSubscription,false);
  assert.deepEqual(normalizeCollectorRawPayload(raw),raw);
});

test('normalized validation marker remains a subscription when raw type is absent',()=>{
  const row={validation:'subscription',raw_payload:{value:'3'}};
  assert.deepEqual(collectorSubscriptionInfo(row),{
    isSubscription:true,
    months:3,
    type:'',
    subtype:'',
    img:''
  });
});

test('collector ingestion and processor both hard-stop subscription donation handling',async()=>{
  const collector=await readFile(auditURL('../api/collector.js',import.meta.url),'utf8');
  const processor=await readFile(auditURL('../lib/collector-processor.js',import.meta.url),'utf8');
  assert.match(collector,/balloons:subscription\.isSubscription\?0:amountOf\(rec\)/);
  assert.match(collector,/validation:subscription\.isSubscription\?'subscription'/);
  assert.match(collector,/fixed_rewards:subscription\.isSubscription\?\[\]/);
  assert.match(processor,/if\(collectorSubscriptionInfo\(row\)\.isSubscription\)return 'subscription'/);
  assert.match(processor,/kind==='subscription'.*recordDonation:false/);
});

test('admin history labels subscriptions and excludes them from donation statistics',()=>{
  const html=Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8');
  assert.match(html,/function collectorSubscriptionInfo\(row\)/);
  assert.match(html,/validation==='subscription'/);
  assert.match(html,/FOLLOW_ITEM_EFFECT/);
  assert.match(html,/subscription_ceremony/);
  assert.match(html,/collectorAmountText\(r\)/);
  assert.match(html,/구독 자동처리/);
  assert.match(html,/rows\.filter\(r=>!collectorSubscriptionInfo\(r\)\.isSubscription\)/);
  assert.match(html,/donationStatsRows\.filter\(r=>!isSubscriptionDonation\(r\)\)/);
});
