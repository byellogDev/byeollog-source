const RETIRED_RUNTIME_OPERATIONS=new Set([
  'soop-roulette-overlay-page',
  'soop-roulette-overlay-poll',
  'soop-roulette-overlay-sound',
  'soop-roulette-overlay-tts',
  'internal-raffle-tts'
]);

export const CORE_PRODUCT_SCOPE=Object.freeze({
  wallpaper:true,
  upbo:true,
  nativeRoulette:false,
  localActions:false,
  legacyWeflabCollector:false
});

export function legacyWeflabCollectorEnabled(env=process.env){
  return String(env.LEGACY_WEFLAB_COLLECTOR_ENABLED||'').trim().toLowerCase()==='true';
}

export function retiredRuntimeOperation(operation){
  return RETIRED_RUNTIME_OPERATIONS.has(String(operation||''));
}
