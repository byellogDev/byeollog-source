import {readBoundedResponse} from './data-query-policy.js';

export function publicReadConfig(environment=process.env){
  const url=String(environment.SUPABASE_URL||'').replace(/\/+$/,'');
  const apikey=String(environment.SUPABASE_ANON_KEY||'');
  const token=String(environment.BYEOLLOG_PUBLIC_READ_TOKEN||'');
  if(!url||!/^[a-f0-9]{64}$/.test(token))return null;
  if(apikey.startsWith('sb_publishable_'))return {url,apikey,token};
  try{
    const parts=apikey.split('.');
    if(parts.length!==3||JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')).role!=='anon')return null;
  }catch{return null}
  return {url,apikey,token,authorization:'Bearer '+apikey};
}

export async function fetchPublicRead(config,operation,args){
  const response=await fetch(`${config.url}/rest/v1/rpc/byeollog_public_read_v1`,{
    method:'POST',headers:{apikey:config.apikey,'Content-Type':'application/json',
      ...(config.authorization?{Authorization:config.authorization}:{})},
    body:JSON.stringify({p_token:config.token,p_operation:operation,p_args:args}),
    cache:'no-store',signal:AbortSignal.timeout(10000)
  });
  return {upstreamStatus:response.status,text:await readBoundedResponse(response)};
}
