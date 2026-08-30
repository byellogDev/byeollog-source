#!/usr/bin/env node
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pcm16leToWav,wavPcm16le} from './tts-benchmark/core.mjs';

const root=resolve(import.meta.dirname,'..');
const sourceDirectory=resolve(root,'output','tts-phase2','samples-google-chirp3-korean');
const outputDirectory=resolve(root,'output','tts-phase2','blind-google-chirp3-korean');
const mapping=[
  {candidate:'A',provider:'google_chirp3_kore'},
  {candidate:'B',provider:'google_chirp3_zephyr'},
  {candidate:'C',provider:'google_chirp3_achernar'},
  {candidate:'D',provider:'google_chirp3_pulcherrima'},
  {candidate:'E',provider:'google_chirp3_aoede'},
  {candidate:'F',provider:'google_chirp3_leda'}
];
const cases=[
  {id:'short',label:'초단문'},
  {id:'normal',label:'일반 후원'},
  {id:'max_120',label:'최대 120자'}
];

await mkdir(outputDirectory,{recursive:true});
for(const {candidate,provider} of mapping){
  const auditionChunks=[];
  let auditionSampleRate=null,auditionChannels=null;
  for(const item of cases){
    const source=join(sourceDirectory,`${provider}--${item.id}.wav`);
    const target=join(outputDirectory,`candidate-${candidate}--${item.id}.wav`);
    await copyFile(source,target);
    const wave=wavPcm16le(await readFile(source));
    if(auditionSampleRate===null){auditionSampleRate=wave.sampleRate;auditionChannels=wave.channels}
    if(wave.sampleRate!==auditionSampleRate||wave.channels!==auditionChannels)throw new Error('Google Chirp 3 sample formats do not match.');
    auditionChunks.push(wave.pcm,Buffer.alloc(Math.round(wave.sampleRate*0.55)*wave.channels*2));
  }
  await writeFile(join(outputDirectory,`candidate-${candidate}--audition.wav`),pcm16leToWav(Buffer.concat(auditionChunks),{sampleRate:auditionSampleRate,channels:auditionChannels}));
}

const manifest={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  candidates:mapping.map(({candidate})=>({
    candidate,
    auditionFile:`candidate-${candidate}--audition.wav`,
    samples:cases.map(item=>({caseId:item.id,label:item.label,file:`candidate-${candidate}--${item.id}.wav`}))
  })),
  sampleOrder:cases.map(item=>item.label)
};
await writeFile(join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
await writeFile(join(dirname(outputDirectory),'blind-google-chirp3-korean-key.private.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),mapping},null,2)+'\n','utf8');
console.log('GOOGLE_CHIRP3_BLIND_VOICE_PACK_COMPLETE');
console.log(`directory=${outputDirectory}`);
console.log(`manifest=${join(outputDirectory,'manifest.json')}`);
