// Appended to the observer module in a separate container. stdin is a live
// supervisor pipe: losing it must terminate the observer, not orphan a session.
import readline from 'node:readline';
import {once} from 'node:events';
import * as fsp from 'node:fs/promises';
const input=readline.createInterface({input:process.stdin});
let contact=Date.now();
const cancelled=new AbortController();
input.on('line',()=>{contact=Date.now()});
input.on('close',()=>{cancelled.abort();setTimeout(()=>process.exit(2),2000).unref()});
const [first]=await once(input,'line');
const cfg=JSON.parse(first);
await fsp.mkdir('/tmp/observer-ws/lib',{recursive:true});
for(const [name,source] of Object.entries(cfg.wsFiles)){
  if(!/^(?:package.json|wrapper.mjs|index.js|LICENSE|lib\/[a-z-]+\.js)$/.test(name))throw Error('invalid_dependency_path');
  await fsp.writeFile('/tmp/observer-ws/'+name,source);
}
if(JSON.parse(cfg.wsFiles['package.json']).version!=='8.21.0')throw Error('unexpected_ws_version');
delete cfg.wsFiles;
const Transport=(await import('/tmp/observer-ws/wrapper.mjs')).default;
const watchdog=setInterval(()=>{if(Date.now()-contact>30000){cancelled.abort();setTimeout(()=>process.exit(2),2000).unref()}},5000);
try{
  const result=await observe(cfg,{WebSocketImpl:Transport,maxDurationMs:172800000,signal:cancelled.signal,onReport:x=>console.log(JSON.stringify(x))});
  console.log(JSON.stringify({kind:'result',...result}));
}catch{console.log(JSON.stringify({kind:'result',ready:false,reason:'observer_failed'}))}
finally{clearInterval(watchdog);input.close();process.exit(0)}
