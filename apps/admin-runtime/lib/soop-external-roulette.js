const RESULT_PREFIXES=[
  /(?:^|[\s\[|(])룰렛\s*결과\s*(?:는|은)?\s*[:：>-]\s*(?<result>.+)$/iu,
  /(?:^|\s)룰렛\s*결과\s*(?:는|은)\s*(?<result>.+?)(?:\s*(?:입니다|이에요|예요)[.!]?)?$/iu,
  /(?:^|\s)(?<roulette>[^\n:：]{1,60}?)\s*룰렛(?:의)?\s*결과\s*(?:는|은)?\s*[:：>-]?\s*(?<result>.+)$/iu
];

function clean(value,max){
  const normalized=String(value??'').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  return normalized&&normalized.length<=max?normalized:'';
}

function trimResult(value){
  return clean(value,220)
    .replace(/^[\s:：>\-–—|]+/u,'')
    .replace(/\s*(?:입니다|이에요|예요)[.!]?$/u,'')
    .replace(/\s*[🎉🎊]+$/u,'')
    .trim();
}

function donorFromMessage(message){
  const patterns=[
    /(?:^|[\s[(])(?<donor>[^\n()[\]{}:：]{1,80}?)\s*님(?:의|이)?\s*(?:룰렛|후원)/u,
    /(?:후원자|당첨자)\s*[:：]\s*(?<donor>[^\n|,]{1,80})/u
  ];
  for(const pattern of patterns){
    const donor=clean(pattern.exec(message)?.groups?.donor,80);
    if(donor)return donor;
  }
  return null;
}

export function parseExternalRouletteResultMessage(value){
  const message=clean(value,300);
  if(!message)return null;
  for(const pattern of RESULT_PREFIXES){
    const match=pattern.exec(message);
    const resultText=trimResult(match?.groups?.result);
    if(!resultText||resultText.length>120)continue;
    const rouletteName=clean(match?.groups?.roulette,80)
      .replace(/(?:^|\s)[^\s]{1,80}님(?:의|이)?\s*$/u,'')
      .trim()||null;
    return {resultText,rouletteName,donorName:donorFromMessage(message),message};
  }
  return null;
}

// SOOP SDK chat IDs include a numeric connection suffix, e.g. account(0).
// Only this exact provider shape is normalized; display names never authorize.
export function isTrustedExternalRouletteAuthor(actorId,broadcasterId){
  const actor=String(actorId||'').trim().toLowerCase(),owner=String(broadcasterId||'').trim().toLowerCase();
  if(!/^[a-z0-9_.-]{2,80}$/.test(owner))return false;
  const match=/^([a-z0-9_.-]{2,80})(?:\([0-9]{1,3}\))?$/.exec(actor);
  return Boolean(match&&match[1]===owner);
}

export function isPotentialExternalRouletteResultMessage(value){
  return parseExternalRouletteResultMessage(value)!==null;
}
