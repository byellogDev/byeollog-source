#!/usr/bin/env node
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {latencySummary} from './native-roulette-readiness-lab.mjs';

function integer(value,label,min,max){
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw new Error(`${label} 범위가 올바르지 않습니다.`);
  return parsed;
}
function parseArgs(values){
  const options={endpoint:'http://127.0.0.1:8080',iterations:10,warmups:2,timeoutMs:30_000,
    secretEnv:'BYEOLLOG_TTS_SHARED_SECRET',output:null};
  for(let index=0;index<values.length;index++){
    const key=values[index];const value=values[index+1];
    if(key==='--endpoint'){options.endpoint=String(value||'');index++}
    else if(key==='--iterations'){options.iterations=integer(value,'iterations',1,100);index++}
    else if(key==='--warmups'){options.warmups=integer(value,'warmups',0,20);index++}
    else if(key==='--timeout-ms'){options.timeoutMs=integer(value,'timeout-ms',1_000,120_000);index++}
    else if(key==='--secret-env'){options.secretEnv=String(value||'');index++}
    else if(key==='--json-output'){options.output=resolve(value);index++}
    else if(key==='--help'){
      console.log('Usage: node tools/Benchmark-NativeRouletteTtsEndpoint.mjs [--endpoint http://127.0.0.1:8080] [--iterations 10] [--warmups 2] [--timeout-ms 30000] [--secret-env BYEOLLOG_TTS_SHARED_SECRET] [--json-output path]');
      process.exit(0);
    }else throw new Error(`알 수 없는 인자입니다: ${key}`);
  }
  return options;
}
function validateLoopback(value){
  const url=new URL(value);
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash){
    throw new Error('실측 도구는 방송 경로 보호를 위해 로컬 HTTP TTS 주소만 허용합니다.');
  }
  return url;
}
function voiceKey(text){return createHash('sha256').update(`native-roulette-result-v1|${text}`,'utf8').digest('hex')}

const options=parseArgs(process.argv.slice(2));
const endpoint=validateLoopback(options.endpoint);
const secret=String(process.env[options.secretEnv]||'').trim();
if(secret.length<43)throw new Error(`${options.secretEnv} 환경변수에 TTS 공유 비밀을 설정하세요.`);
const healthUrl=new URL('/healthz',endpoint);
const healthResponse=await fetch(healthUrl,{signal:AbortSignal.timeout(Math.min(10_000,options.timeoutMs))});
const health=await healthResponse.json().catch(()=>({}));
if(!healthResponse.ok||health.healthy!==true)throw new Error('로컬 TTS가 준비되지 않았습니다.');

const prompts=['관측계정A 용돈, 당첨!','아봉 십 초, 당첨!','다음 보상 두 배, 당첨!'];
const results=[];let failures=0;let requestIndex=0;
async function request(text,measured){
  const key=voiceKey(text);const started=performance.now();
  const response=await fetch(new URL('/v1/roulette-result',endpoint),{
    method:'POST',headers:{authorization:`Bearer ${secret}`,'content-type':'application/json'},
    body:JSON.stringify({text,voiceKey:key}),signal:AbortSignal.timeout(options.timeoutMs)
  });
  const bytes=new Uint8Array(await response.arrayBuffer());
  const elapsedMs=Math.round((performance.now()-started)*100)/100;
  const digest=createHash('sha256').update(bytes).digest('hex');
  const valid=response.ok&&bytes.length>=44&&Buffer.from(bytes.subarray(0,4)).toString('ascii')==='RIFF'
    &&Buffer.from(bytes.subarray(8,12)).toString('ascii')==='WAVE'
    &&response.headers.get('x-byeollog-voice-key')===key
    &&response.headers.get('x-byeollog-audio-sha256')===digest;
  if(measured)results.push({elapsedMs,bytes:bytes.length,valid,status:response.status});
  if(!valid&&measured)failures++;
}
for(let index=0;index<options.warmups;index++)await request(prompts[index%prompts.length],false);
for(let index=0;index<options.iterations;index++){
  await request(prompts[requestIndex++%prompts.length],true);
}
const report={
  schemaVersion:1,generatedAt:new Date().toISOString(),measurementKind:'real-local-complete-wav',
  endpointOrigin:endpoint.origin,serviceVersion:health.version||null,iterations:options.iterations,
  failures,errorRatePercent:Math.round(failures/options.iterations*100_000)/1_000,
  responseLatencyMs:latencySummary(results.map(item=>item.elapsedMs)),
  responseBytes:latencySummary(results.map(item=>item.bytes)),
  limitations:['완성 WAV 응답 시간이며 스트리밍 첫 PCM 조각 TTFA가 아닙니다.','로컬 단일 클라이언트 직렬 요청입니다.'],
  passed:failures===0&&results.every(item=>item.valid)
};
console.log(`NATIVE_ROULETTE_TTS_LOCAL_${report.passed?'PASS':'FAIL'}`);
console.log(`service=${report.serviceVersion} iterations=${report.iterations} failures=${report.failures}`);
console.log(`completeWavP50=${report.responseLatencyMs.p50}ms completeWavP95=${report.responseLatencyMs.p95}ms`);
if(options.output){
  await mkdir(dirname(options.output),{recursive:true});
  await writeFile(options.output,`${JSON.stringify(report,null,2)}\n`,'utf8');
  console.log(`report=${options.output}`);
}
if(!report.passed)process.exitCode=1;
