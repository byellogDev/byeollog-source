import fs from 'node:fs';
import {createHash} from 'node:crypto';
const here=new URL('./',import.meta.url),common=new URL('../soop-browserless-lab/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,here),'utf8');
export function buildBundle(){
  const protocol=read('protocol.mjs');
  const strip=source=>source.replace(/^import .* from '\.\/(?:protocol|client)\.mjs';\r?\n/gm,'');
  const observer=[protocol,strip(read('client.mjs')),strip(read('observer.mjs'))].join('\n');
  const monitor=protocol+'\n'+strip(read('cdp-frames.mjs'))+'\n'+read('soak-monitor.mjs');
  const entry=fs.readFileSync(new URL('soak-entry.mjs',common),'utf8');
  const wsRoot=new URL('../../node_modules/ws/',import.meta.url);
  const names=['package.json','wrapper.mjs','index.js','LICENSE',...fs.readdirSync(new URL('lib/',wsRoot)).filter(x=>x.endsWith('.js')).map(x=>'lib/'+x)];
  const wsFiles=Object.fromEntries(names.map(name=>[name,fs.readFileSync(new URL(name,wsRoot),'utf8')]));
  if(JSON.parse(wsFiles['package.json']).version!=='8.21.0')throw Error('ws_version_changed');
  const files={'soak-controller.py':read('soak-controller.py'),'soak-controller.test.py':read('soak-controller.test.py'),...Object.fromEntries(['soak-compare.py','soak-compare.test.py'].map(name=>[name,fs.readFileSync(new URL(name,common),'utf8')]))};
  const hashes=Object.fromEntries(Object.entries({observer,monitor,entry,...files}).map(([name,s])=>[name,createHash('sha256').update(s).digest('hex')]));
  return {bundle:{observer,monitor,entry,wsFiles,adapter:'direct-ws-v1'},files,hashes};
}
