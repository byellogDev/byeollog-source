#!/usr/bin/env node
import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {pcm16leToWav,wavPcm16le} from './tts-benchmark/core.mjs';

const root=resolve(import.meta.dirname,'..');
const sourceDirectory=resolve(root,'output','tts-phase2','samples-cartesia-korean-voices');
const outputDirectory=resolve(root,'output','tts-phase2','blind-cartesia-korean-voices');
const mappingPath=resolve(root,'output','tts-phase2','cartesia-korean-voices-key.private.json');
const mappingDocument=JSON.parse(await readFile(mappingPath,'utf8'));
const mapping=mappingDocument.mapping||[];
const cases=[
  {id:'short',label:'초단문'},
  {id:'normal',label:'일반 후원'},
  {id:'max_120',label:'최대 120자'}
];

if(!mapping.length)throw new Error('Cartesia blind mapping is empty.');
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
    if(wave.sampleRate!==auditionSampleRate||wave.channels!==auditionChannels)throw new Error('Cartesia sample formats do not match.');
    auditionChunks.push(wave.pcm);
    const silenceFrames=Math.round(wave.sampleRate*0.55);
    auditionChunks.push(Buffer.alloc(silenceFrames*wave.channels*2));
  }
  const auditionPcm=Buffer.concat(auditionChunks);
  await writeFile(join(outputDirectory,`candidate-${candidate}--audition.wav`),pcm16leToWav(auditionPcm,{sampleRate:auditionSampleRate,channels:auditionChannels}));
}
const manifest={
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  candidates:mapping.map(({candidate})=>({
    candidate,
    auditionFile:`candidate-${candidate}--audition.wav`,
    samples:cases.map(item=>({caseId:item.id,label:item.label,file:`candidate-${candidate}--${item.id}.wav`}))
  }))
};
await writeFile(join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
console.log('CARTESIA_BLIND_VOICE_PACK_COMPLETE');
console.log(`directory=${outputDirectory}`);
console.log(`manifest=${join(outputDirectory,'manifest.json')}`);
console.log(`privateMapping=${mappingPath}`);
