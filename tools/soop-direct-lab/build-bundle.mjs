import fs from 'node:fs';
import {createHash} from 'node:crypto';
const here=new URL('./',import.meta.url),common=new URL('../soop-browserless-lab/',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,here),'utf8');
export function buildBundle(){
  const strip=source=>source.replace(/^import .* from '\.\/(?:protocol|client|comparison-record)\.mjs';\r?\n/gm,'').replace(/^import .* from '\.\.\/\.\.\/services\/soop-gateway\/lib\/soop-room-identity\.js';\r?\n/gm,'');
  const identity=fs.readFileSync(new URL('../../services/soop-gateway/lib/soop-room-identity.js',import.meta.url),'utf8');
  const protocol=identity+'\n'+strip(read('protocol.mjs'));
  const recorder=strip(read('comparison-record.mjs'));
  const observer=[protocol,recorder,strip(read('client.mjs')),strip(read('rolling-observer.mjs'))].join('\n');
  const monitor=protocol+'\n'+recorder+'\n'+strip(read('cdp-frames.mjs'))+'\n'+read('cdp-scope.mjs')+'\n'+strip(read('soak-monitor.mjs'));
  const entry=read('rolling-entry.mjs');
  const wsRoot=new URL('../../node_modules/ws/',import.meta.url);
  const names=['package.json','wrapper.mjs','index.js','LICENSE',...fs.readdirSync(new URL('lib/',wsRoot)).filter(x=>x.endsWith('.js')).map(x=>'lib/'+x)];
  const wsFiles=Object.fromEntries(names.map(name=>[name,fs.readFileSync(new URL(name,wsRoot),'utf8')]));
  if(JSON.parse(wsFiles['package.json']).version!=='8.21.0')throw Error('ws_version_changed');
  const files=Object.fromEntries(['soak-controller.py','soak-controller.test.py','soak-compare.py','soak-compare.test.py'].map(name=>[name,read(name)]));
  const hashes=Object.fromEntries(Object.entries({observer,monitor,entry,...files}).map(([name,s])=>[name,createHash('sha256').update(s).digest('hex')]));
  return {bundle:{observer,monitor,entry,wsFiles,adapter:'direct-ws-rolling-v6'},files,hashes};
}
