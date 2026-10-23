import {runDirect} from './client.mjs';
import {CONTENT_CODES} from './protocol.mjs';
import {comparisonRecord} from './comparison-record.mjs';
// Same supervisor interface as the old candidate, but no SDK is loaded.
export async function observe(config,{fetchImpl=fetch,WebSocketImpl,onReport=()=>{},signal,maxDurationMs=120000}={}){
  if(typeof config.salt!=='string'||config.salt.length<32)throw new Error('invalid_observer_salt');
  const durationMs=Math.min(maxDurationMs,Math.max(1000,Number(config.durationMs)||120000));
  let chatNumber;
  return runDirect({...config,durationMs},{fetchImpl,WebSocketImpl,signal,onReport:e=>{if(e.kind==='ready')chatNumber=e.chatNumber;onReport(e)},
    onFrame:p=>{if(CONTENT_CODES.includes(p.code))onReport({kind:'frame',...comparisonRecord(p,{broadcasterId:config.broadcasterId,chatNumber},config.salt)})}});
}
