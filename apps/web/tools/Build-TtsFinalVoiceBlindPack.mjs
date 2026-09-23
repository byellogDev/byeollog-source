#!/usr/bin/env node
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pcm16leToWav,wavPcm16le} from './tts-benchmark/core.mjs';

const root=resolve(import.meta.dirname,'..');
const outputDirectory=resolve(root,'output','tts-phase2','blind-final-voices');
const inworldDirectory=resolve(root,'output','tts-phase2','blind-inworld-korean-voices');
const cartesiaDirectory=resolve(root,'output','tts-phase2','blind-cartesia-korean-voices');
const cases=['short','normal','max_120'];
const finalists=[
  {provider:'Inworld',voice:'Minji',source:'inworld'},
  {provider:'Cartesia',voice:'Soojin',source:'cartesia-e'},
  {provider:'Cartesia',voice:'Minji',source:'cartesia-b'}
];

// Fixed seedless ordering is intentionally different from both earlier blind packs.
const ordered=[finalists[1],finalists[0],finalists[2]];
const labels=['X','Y','Z'];
await mkdir(outputDirectory,{recursive:true});

async function buildInworldAudition(target){
  const chunks=[];
  let sampleRate=null,channels=null;
  for(const caseId of cases){
    const wave=wavPcm16le(await readFile(join(inworldDirectory,`candidate-C--${caseId}.wav`)));
    if(sampleRate===null){sampleRate=wave.sampleRate;channels=wave.channels}
    if(wave.sampleRate!==sampleRate||wave.channels!==channels)throw new Error('Inworld sample formats do not match.');
    chunks.push(wave.pcm,Buffer.alloc(Math.round(sampleRate*0.55)*channels*2));
  }
  await writeFile(target,pcm16leToWav(Buffer.concat(chunks),{sampleRate,channels}));
}

for(let index=0;index<ordered.length;index++){
  const item=ordered[index],target=join(outputDirectory,`candidate-${labels[index]}--audition.wav`);
  if(item.source==='inworld')await buildInworldAudition(target);
  else{
    const previousLabel=item.source==='cartesia-e'?'E':'B';
    await copyFile(join(cartesiaDirectory,`candidate-${previousLabel}--audition.wav`),target);
  }
}

const publicManifest={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  candidates:labels.map(candidate=>({candidate,file:`candidate-${candidate}--audition.wav`})),
  sampleOrder:['초단문','일반 후원','최대 120자']
};
const privateMapping={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  mapping:labels.map((candidate,index)=>({candidate,...ordered[index]}))
};
await writeFile(join(outputDirectory,'manifest.json'),JSON.stringify(publicManifest,null,2)+'\n','utf8');
await writeFile(resolve(root,'output','tts-phase2','blind-final-voices-key.private.json'),JSON.stringify(privateMapping,null,2)+'\n','utf8');
console.log('TTS_FINAL_VOICE_BLIND_PACK_COMPLETE');
console.log(`directory=${outputDirectory}`);
