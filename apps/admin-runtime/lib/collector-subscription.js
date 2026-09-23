const SUBSCRIPTION_TYPES=new Set(['FOLLOW_ITEM','FOLLOW_ITEM_EFFECT']);

function asObject(value){
  return value&&typeof value==='object'&&!Array.isArray(value)?value:{};
}

function rawPayload(source){
  const row=asObject(source);
  return asObject(row.raw_payload||row.raw||row.Raw||row);
}

function positiveInt(value){
  const number=Math.trunc(Number(value));
  return Number.isFinite(number)&&number>0?number:null;
}

export function collectorSubscriptionInfo(source){
  const row=asObject(source);
  const raw=rawPayload(source);
  const type=String(raw.type||'').trim().toUpperCase();
  const subtype=String(raw.subtype||'').trim().toUpperCase();
  const kind=String(raw.collector_event_kind||raw.collectorEventKind||'').trim().toLowerCase();
  const validation=String(row.validation||raw.validation||'').trim().toLowerCase();
  const img=String(raw.img||raw.image||raw.image_url||raw.imageUrl||'').trim();
  const typeMatch=SUBSCRIPTION_TYPES.has(type)||SUBSCRIPTION_TYPES.has(subtype);
  const imageMatch=/(?:^|\/)subscription_ceremony(?:\/|$)/i.test(img)
    ||/(?:^|\/)gudok_(\d+)\.png(?:[?#].*)?$/i.test(img);
  const isSubscription=validation==='subscription'||kind==='subscription'||typeMatch||imageMatch;
  const imageMonths=positiveInt(img.match(/(?:^|\/)gudok_(\d+)\.png(?:[?#].*)?$/i)?.[1]);
  const months=isSubscription
    ? positiveInt(raw.subscription_months??raw.subscriptionMonths)
      ??positiveInt(raw.value)
      ??imageMonths
      ??positiveInt(row.balloons)
    : null;
  return {isSubscription,months,type,subtype,img};
}

export function normalizeCollectorRawPayload(source){
  const raw={...rawPayload(source)};
  const info=collectorSubscriptionInfo(raw);
  if(!info.isSubscription)return raw;
  raw.collector_event_kind='subscription';
  if(info.months!==null)raw.subscription_months=info.months;
  return raw;
}
