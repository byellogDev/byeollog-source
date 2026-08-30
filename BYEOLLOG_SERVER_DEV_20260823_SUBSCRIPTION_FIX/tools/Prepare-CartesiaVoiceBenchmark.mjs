#!/usr/bin/env node
import process from 'node:process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';

const projectRoot=resolve(import.meta.dirname,'..');
const stateRoot=process.env.LOCALAPPDATA;
if(!stateRoot)throw new Error('LOCALAPPDATA is unavailable.');
const catalogPath=join(stateRoot,'ByeollogTtsBenchmark','cartesia.korean-voices.json');
const outputDirectory=resolve(projectRoot,'output','tts-phase2');
const configPath=join(outputDirectory,'providers.cartesia.korean-voices.generated.json');
const mappingPath=join(outputDirectory,'cartesia-korean-voices-key.private.json');
const selectedNames=[
  'Taehyun - Friendly Host',
  'Minji - Modern Communicator',
  'Soyeon - Bright Companion',
  'Minho - Friendly Spirit',
  'Soojin - Helpful Tone',
  'Yuna - Kind Unnie'
];

const catalog=JSON.parse((await readFile(catalogPath,'utf8')).replace(/^\uFEFF/,''));
const byName=new Map((catalog.voices||[]).map(voice=>[String(voice.name),voice]));
const selected=selectedNames.map(name=>{
  const voice=byName.get(name);
  if(!voice)throw new Error(`Cartesia Korean voice is unavailable: ${name}`);
  return voice;
});
const providers=selected.map((voice,index)=>({
  id:`cartesia_ko_${String(index+1).padStart(2,'0')}`,
  label:`Cartesia Korean voice ${index+1}`,
  kind:'cartesia-sse-v1',
  endpoint:'https://api.cartesia.ai/tts/sse',
  apiVersion:'2026-08-14',
  apiKeyEnv:'CARTESIA_API_KEY',
  voiceId:String(voice.id),
  modelId:'sonic-3.6',
  metadata:{language:'ko',transport:'SSE raw PCM16LE'}
}));
const mapping=providers.map((provider,index)=>({
  candidate:String.fromCharCode(65+index),
  provider:provider.id,
  voiceId:String(selected[index].id),
  voiceName:String(selected[index].name),
  gender:String(selected[index].gender||''),
  description:String(selected[index].description||'')
}));

await mkdir(outputDirectory,{recursive:true});
await writeFile(configPath,JSON.stringify({schemaVersion:1,providers},null,2)+'\n','utf8');
await writeFile(mappingPath,JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),mapping},null,2)+'\n','utf8');
console.log('CARTESIA_VOICE_BENCHMARK_PREPARED');
console.log(`candidateCount=${mapping.length}`);
console.log(`config=${configPath}`);
console.log(`mapping=${mappingPath}`);
