#!/usr/bin/env node
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const mappingPath=resolve(root,'output','tts-phase2','cartesia-korean-voices-key.private.json');
const targetPath=resolve(root,'output','tts-phase2','providers.cartesia.soojin.websocket.generated.json');
const document=JSON.parse(await readFile(mappingPath,'utf8'));
const selected=(document.mapping||[]).find(item=>item.voiceName==='Soojin - Helpful Tone');
if(!selected)throw new Error('Cartesia Soojin voice was not found in the benchmark mapping.');
const provider={
  id:'cartesia_soojin_ws',
  label:'Cartesia Sonic 3.6 Soojin WebSocket',
  kind:'cartesia-websocket-v1',
  endpoint:'wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14',
  apiKeyEnv:'CARTESIA_API_KEY',
  voiceId:selected.voiceId,
  modelId:'sonic-3.6',
  sampleRate:24000,
  metadata:{language:'ko',transport:'persistent WebSocket raw PCM16LE',role:'fallback candidate'}
};
await writeFile(targetPath,JSON.stringify({schemaVersion:1,providers:[provider]},null,2)+'\n','utf8');
console.log('CARTESIA_FALLBACK_BENCHMARK_PREPARED');
console.log(`config=${targetPath}`);
