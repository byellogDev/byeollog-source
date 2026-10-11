export function readAutomaticRouletteRules(payload){
  if(payload?.result!=='success')throw Error('weflab_settings_unavailable');
  if(payload.data?.checkbox?.item_alert_rouletteuse!=='on')return [];
  const rows=payload.data?.donation?.item_roulette_donation;
  if(!Array.isArray(rows)||rows.length>500)throw Error('weflab_rules_shape');
  const rules=[];
  for(const row of rows){
    if(row.checkbox?.setup_roulette_use!=='on')continue;
    const amount=Number(row.text?.setup_alert_giftmin),amountMax=Number(row.text?.setup_alert_giftmax);
    const spins=row.checkbox.setup_roulette_double==='on'?Number(row.select?.setup_roulette_doublecount):1;
    if(!Number.isSafeInteger(amount)||amount<1||!Number.isSafeInteger(amountMax)||amountMax<amount||amountMax>1e9||!Number.isSafeInteger(spins)||spins<1||spins>1000||row.checkbox.setup_roulette_range==='on')throw Error('weflab_rule_unsupported');
    if(rules.some(r=>r.amount<=amountMax&&r.amountMax>=amount))throw Error('weflab_rules_overlap');
    rules.push({amount,amountMax,spins});
  }
  return rules;
}
async function boundedText(response,limit){
  if(!response.ok||Number(response.headers.get('content-length'))>limit)throw Error('weflab_settings_http');
  const reader=response.body.getReader();let length=0;const chunks=[];
  try{for(;;){const {value,done}=await reader.read();if(done)break;length+=value.length;if(length>limit)throw Error('weflab_settings_size');chunks.push(value)}}finally{await reader.cancel()}
  return Buffer.concat(chunks).toString('utf8');
}
export async function fetchAutomaticRouletteRules(url,owner,{fetchImpl=fetch}={}){
  if(typeof url!=='string'||url.length>256||!/^https:\/\/weflab\.com\/page\/[A-Za-z0-9]+$/.test(url)||!owner)throw Error('weflab_settings_scope');
  const signal=AbortSignal.timeout(10000);
  const html=await boundedText(await fetchImpl(url,{redirect:'error',signal}),2*1024*1024);
  const match=html.match(/const loginData\s*=\s*(\{[^\r\n]*\});/);
  if(!match)throw Error('weflab_settings_context');
  const c=JSON.parse(match[1]);
  if(c.type!=='page'||c.pageid!=='alert'||String(c.platform?.afreeca?.id).toLowerCase()!==String(owner).toLowerCase()||c.idx==null||c.preset==null||!c.config?.ver||typeof c.dir!=='string')throw Error('weflab_settings_account');
  // Configuration read only. Saving and refreshing never call roulette_result.
  const raw=await boundedText(await fetchImpl('https://weflab.com/api/',{method:'POST',redirect:'error',signal,
    body:new URLSearchParams({type:'page_load',pagetype:'page',pageid:'alert',idx:String(c.idx),preset:String(c.preset),dir:c.dir,ver:String(c.config.ver)})}),2*1024*1024);
  return readAutomaticRouletteRules(JSON.parse(raw));
}
export async function refreshAutomaticRouletteRules(workspaceId,{sb,fetchImpl=fetch}={}){
  // The database shares this reservation across runtime instances, including failed attempts.
  const state=await sb('rpc/byeollog_upbo_collection_runtime_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_request:{action:'claim_refresh'}}});
  if(!state?.requestedEnabled||!state.url||!state.refreshAllowed)return;
  const rules=await fetchAutomaticRouletteRules(state.url,state.owner,{fetchImpl});
  await sb('rpc/byeollog_upbo_collection_runtime_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_request:{action:'refresh',url:state.url,rules}}});
}
