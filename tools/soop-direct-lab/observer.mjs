import {createHmac} from 'node:crypto';
import {runDirect} from './client.mjs';
import {CONTENT_CODES} from './protocol.mjs';
// Same supervisor interface as the old candidate, but no SDK is loaded.
export async function observe(config,{fetchImpl=fetch,WebSocketImpl,onReport=()=>{},signal,maxDurationMs=120000}={}){
  if(typeof config.salt!=='string'||config.salt.length<32)throw new Error('invalid_observer_salt');
  const durationMs=Math.min(maxDurationMs,Math.max(1000,Number(config.durationMs)||120000));
  return runDirect({...config,durationMs},{fetchImpl,WebSocketImpl,signal,onReport,
    onFrame:p=>{if(CONTENT_CODES.includes(p.code))onReport({kind:'frame',code:p.code,at:Date.now(),digest:createHmac('sha256',config.salt).update(p.bytes).digest('hex')})}});
}
