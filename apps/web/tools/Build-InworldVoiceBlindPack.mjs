#!/usr/bin/env node
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const sourceDirectory=resolve(root,'output','tts-phase2','samples-inworld-korean-voices');
const outputDirectory=resolve(root,'output','tts-phase2','blind-inworld-korean-voices');
const mapping=[
  {candidate:'A',provider:'inworld_yoona_ws'},
  {candidate:'B',provider:'inworld_hyunwoo_ws'},
  {candidate:'C',provider:'inworld_minji_ws'},
  {candidate:'D',provider:'inworld_seojun_ws'}
];
const cases=[
  {id:'short',label:'초단문'},
  {id:'normal',label:'일반 후원'},
  {id:'max_120',label:'최대 120자'}
];

await mkdir(outputDirectory,{recursive:true});
const publicManifest={schemaVersion:1,generatedAt:new Date().toISOString(),candidates:mapping.map(({candidate})=>({candidate,samples:cases.map(item=>({caseId:item.id,label:item.label,file:`candidate-${candidate}--${item.id}.wav`}))}))};
for(const {candidate,provider} of mapping){
  for(const item of cases){
    const source=join(sourceDirectory,`${provider}--${item.id}.wav`);
    const target=join(outputDirectory,`candidate-${candidate}--${item.id}.wav`);
    await copyFile(source,target);
  }
}
await writeFile(join(outputDirectory,'manifest.json'),JSON.stringify(publicManifest,null,2)+'\n','utf8');
await writeFile(join(dirname(outputDirectory),'blind-inworld-korean-voices-key.private.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),mapping},null,2)+'\n','utf8');
console.log('INWORLD_BLIND_VOICE_PACK_COMPLETE');
console.log(`directory=${outputDirectory}`);
console.log(`manifest=${join(outputDirectory,'manifest.json')}`);
