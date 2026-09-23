#!/usr/bin/env node
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pcm16leToWav,wavPcm16le} from './tts-benchmark/core.mjs';

const root=resolve(import.meta.dirname,'..');
const sourceDirectory=resolve(root,'output','tts-phase2','samples-tts-final-wink');
const outputDirectory=resolve(root,'output','tts-phase2','blind-tts-final-wink');
const mapping=[
  {candidate:'P',provider:'final_cartesia',engine:'Cartesia',voice:'Soojin'},
  {candidate:'Q',provider:'final_google',engine:'Google Chirp 3 HD',voice:'Leda'},
  {candidate:'R',provider:'final_inworld',engine:'Inworld TTS-2 Flash',voice:'Minji'}
];
const cases=[
  {id:'wink',label:'윙크 단독'},
  {id:'normal',label:'일반 후원'},
  {id:'max_120',label:'최대 120자'}
];

function normalizeVoice(pcm){
  const targetRms=4_300;
  const limitedSample=(value,gain)=>{
    const scaled=value*gain,absolute=Math.abs(scaled),sign=Math.sign(scaled);
    if(absolute<=24_000)return Math.round(scaled);
    return Math.round(sign*(24_000+6_000*(1-Math.exp(-(absolute-24_000)/6_000))));
  };
  const gatedRms=gain=>{
    let sumSquares=0,count=0;
    for(let offset=0;offset<pcm.length;offset+=2){
      const source=pcm.readInt16LE(offset);
      if(Math.abs(source)<96)continue;
      const sample=limitedSample(source,gain);
      sumSquares+=sample*sample;count++;
    }
    return count?Math.sqrt(sumSquares/count):0;
  };
  if(!gatedRms(1))return pcm;
  let lower=0.1,upper=12;
  for(let step=0;step<24;step++){
    const middle=(lower+upper)/2;
    if(gatedRms(middle)<targetRms)lower=middle;else upper=middle;
  }
  const gain=(lower+upper)/2;
  const normalized=Buffer.allocUnsafe(pcm.length);
  for(let offset=0;offset<pcm.length;offset+=2){
    const sample=limitedSample(pcm.readInt16LE(offset),gain);
    normalized.writeInt16LE(sample,offset);
  }
  return normalized;
}

await mkdir(outputDirectory,{recursive:true});
for(const item of mapping){
  const chunks=[];
  let sampleRate=null,channels=null;
  for(const sampleCase of cases){
    const wave=wavPcm16le(await readFile(join(sourceDirectory,`${item.provider}--${sampleCase.id}.wav`)));
    if(sampleRate===null){sampleRate=wave.sampleRate;channels=wave.channels}
    if(wave.sampleRate!==sampleRate||wave.channels!==channels)throw new Error('Final TTS sample formats do not match.');
    chunks.push(wave.pcm,Buffer.alloc(Math.round(sampleRate*0.65)*channels*2));
  }
  const normalized=normalizeVoice(Buffer.concat(chunks));
  await writeFile(join(outputDirectory,`candidate-${item.candidate}--audition.wav`),pcm16leToWav(normalized,{sampleRate,channels}));
}

await writeFile(join(outputDirectory,'manifest.json'),JSON.stringify({
  schemaVersion:1,
  generatedAt:new Date().toISOString(),
  focusWord:'윙크',
  sampleOrder:cases.map(item=>item.label),
  loudnessNormalization:'gated-rms target 4300, soft peak ceiling 30000',
  candidates:mapping.map(({candidate})=>({candidate,file:`candidate-${candidate}--audition.wav`}))
},null,2)+'\n','utf8');
await writeFile(resolve(root,'output','tts-phase2','blind-tts-final-wink-key.private.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),mapping},null,2)+'\n','utf8');
console.log('TTS_WINK_FINAL_BLIND_PACK_COMPLETE');
console.log(`directory=${outputDirectory}`);
