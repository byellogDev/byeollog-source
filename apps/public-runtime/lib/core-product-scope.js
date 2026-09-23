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
  legacyWeflabCollector:false,
  weflabShadowValidation:true
});

export function legacyWeflabCollectorMode(env=process.env){
  const explicit=String(env.LEGACY_WEFLAB_COLLECTOR_MODE||'').trim().toLowerCase();
  if(explicit==='shadow'||explicit==='active')return explicit;
  return String(env.LEGACY_WEFLAB_COLLECTOR_ENABLED||'').trim().toLowerCase()==='true'?'active':'retired';
}

export function legacyWeflabCollectorEnabled(env=process.env){
  return legacyWeflabCollectorMode(env)!=='retired';
}

export function legacyWeflabValidationWorkspaceAllowed(workspaceId,env=process.env){
  const wanted=String(workspaceId||'').trim().toLowerCase();
  if(!wanted)return false;
  return String(env.LEGACY_WEFLAB_VALIDATION_WORKSPACE_IDS||'')
    .split(',').map(value=>value.trim().toLowerCase()).filter(Boolean).includes(wanted);
}

export function retiredRuntimeOperation(operation){
  return RETIRED_RUNTIME_OPERATIONS.has(String(operation||''));
}
