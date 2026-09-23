#!/usr/bin/env node
import process from 'node:process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHttpPcmAdapter} from './tts-benchmark/http-pcm-adapter.mjs';
import {createByeollogCosyWavAdapter} from './tts-benchmark/byeollog-cosy-wav-adapter.mjs';
import {createCartesiaSseAdapter} from './tts-benchmark/cartesia-sse-adapter.mjs';
import {createCartesiaWebSocketAdapter} from './tts-benchmark/cartesia-websocket-adapter.mjs';
import {createElevenLabsHttpAdapter} from './tts-benchmark/elevenlabs-http-adapter.mjs';
import {createInworldHttpStreamAdapter} from './tts-benchmark/inworld-http-stream-adapter.mjs';
import {createInworldWebSocketAdapter} from './tts-benchmark/inworld-websocket-adapter.mjs';
import {createGoogleChirp3StreamingAdapter} from './tts-benchmark/google-chirp3-streaming-adapter.mjs';
import {evaluateLatencyGate,pcm16leToWav,runProviderBenchmark} from './tts-benchmark/core.mjs';
import {listenFixture} from './tts-benchmark/fixture-server.mjs';

const HERE=dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS=join(HERE,'tts-benchmark','corpus.ko.json');
const TARGETS={p50Ms:450,p95Ms:800,p99Ms:1200,minSuccessRatePercent:99.9};

function integer(value,label,min,max){
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw new Error(`${label} 범위가 올바르지 않습니다.`);
  return parsed;
}

function parseArgs(args){
  const options={config:null,corpus:DEFAULT_CORPUS,iterations:3,warmups:1,concurrency:1,timeoutMs:15_000,
    jsonOutput:resolve('output','tts-phase1','benchmark-report.json'),samplesDir:resolve('output','tts-phase1','samples'),allowRemote:false,selfTest:false};
  for(let index=0;index<args.length;index++){
    const key=args[index],value=args[index+1];
    if(key==='--config'){options.config=resolve(String(value||''));index++}
    else if(key==='--corpus'){options.corpus=resolve(String(value||''));index++}
    else if(key==='--iterations'){options.iterations=integer(value,'iterations',1,100);index++}
    else if(key==='--warmups'){options.warmups=integer(value,'warmups',0,20);index++}
    else if(key==='--concurrency'){options.concurrency=integer(value,'concurrency',1,32);index++}
    else if(key==='--timeout-ms'){options.timeoutMs=integer(value,'timeout-ms',500,120_000);index++}
    else if(key==='--json-output'){options.jsonOutput=resolve(String(value||''));index++}
    else if(key==='--samples-dir'){options.samplesDir=resolve(String(value||''));index++}
    else if(key==='--allow-remote')options.allowRemote=true;
    else if(key==='--self-test')options.selfTest=true;
    else if(key==='--help'){
      console.log('Usage: node tools/Benchmark-TtsCandidates.mjs --self-test | --config providers.json [--iterations 3] [--warmups 1] [--concurrency 1] [--timeout-ms 15000] [--corpus corpus.json] [--json-output report.json] [--samples-dir dir] [--allow-remote]');
      process.exit(0);
    }else throw new Error(`알 수 없는 인자입니다: ${key}`);
  }
  if(!options.selfTest&&!options.config)throw new Error('--self-test 또는 --config가 필요합니다.');
  return options;
}

async function json(path){return JSON.parse(await readFile(path,'utf8'))}
function isLoopback(url){return ['127.0.0.1','localhost','[::1]'].includes(url.hostname)}
function validateProvider(provider,allowRemote){
  if(!/^[a-z0-9][a-z0-9_-]{1,47}$/.test(String(provider.id||'')))throw new Error('provider id가 올바르지 않습니다.');
  if(!['http-pcm-v1','byeollog-cosy-wav-v1','cartesia-sse-v1','cartesia-websocket-v1','elevenlabs-http-stream-v1','inworld-http-stream-v1','inworld-websocket-v1','google-chirp3-streaming-v1'].includes(provider.kind))throw new Error(`지원하지 않는 provider kind입니다: ${provider.kind}`);
  const endpoint=new URL(provider.endpoint);
  if(endpoint.username||endpoint.password||endpoint.hash)throw new Error('provider endpoint에 인증정보나 fragment를 넣을 수 없습니다.');
  if(!isLoopback(endpoint)&&!allowRemote)throw new Error('원격 후보 측정은 --allow-remote를 명시해야 합니다.');
  const secureProtocol=['inworld-websocket-v1','cartesia-websocket-v1'].includes(provider.kind)?'wss:':'https:';
  if(!isLoopback(endpoint)&&endpoint.protocol!==secureProtocol)throw new Error(`원격 후보는 ${secureProtocol}// 연결만 허용합니다.`);
}
function adapterFor(provider){
  if(provider.kind==='http-pcm-v1')return createHttpPcmAdapter(provider);
  if(provider.kind==='byeollog-cosy-wav-v1')return createByeollogCosyWavAdapter(provider);
  if(provider.kind==='cartesia-sse-v1')return createCartesiaSseAdapter(provider);
  if(provider.kind==='cartesia-websocket-v1')return createCartesiaWebSocketAdapter(provider);
  if(provider.kind==='elevenlabs-http-stream-v1')return createElevenLabsHttpAdapter(provider);
  if(provider.kind==='inworld-http-stream-v1')return createInworldHttpStreamAdapter(provider);
  if(provider.kind==='inworld-websocket-v1')return createInworldWebSocketAdapter(provider);
  if(provider.kind==='google-chirp3-streaming-v1')return createGoogleChirp3StreamingAdapter(provider);
  throw new Error(`adapter가 없습니다: ${provider.kind}`);
}
function safeCaseId(value){return String(value).replace(/[^a-z0-9_-]/gi,'_').slice(0,80)}

const options=parseArgs(process.argv.slice(2));
const corpusDocument=await json(options.corpus),corpus=corpusDocument.cases;
if(!Array.isArray(corpus)||!corpus.length||corpus.some(item=>!item?.id||!item?.ttsText))throw new Error('TTS corpus가 올바르지 않습니다.');

let fixture=null,configuration;
if(options.selfTest){
  fixture=await listenFixture({firstAudioDelayMs:30,chunkIntervalMs:2});
  configuration={schemaVersion:1,providers:[{id:'local_fixture',label:'로컬 PCM 검증 서버',kind:'http-pcm-v1',endpoint:fixture.origin+'/v1/tts',sampleRate:24_000,channels:1,metadata:{purpose:'harness-self-test'}}]};
}else configuration=await json(options.config);

const providers=configuration.providers||[];
if(!providers.length)throw new Error('측정할 provider가 없습니다.');
for(const provider of providers)validateProvider(provider,options.allowRemote);
await mkdir(options.samplesDir,{recursive:true});

try{
  const results=[];
  for(const provider of providers){
    const adapter=adapterFor(provider);
    let result;
    try{
      result=await runProviderBenchmark({
        provider,adapter,corpus,iterations:options.iterations,warmups:options.warmups,
        concurrency:options.concurrency,timeoutMs:options.timeoutMs,
        onSample:async({item,pcm,sampleRate,channels})=>{
          const target=join(options.samplesDir,`${safeCaseId(provider.id)}--${safeCaseId(item.id)}.wav`);
          await writeFile(target,pcm16leToWav(pcm,{sampleRate,channels}));
        }
      });
    }finally{await adapter.close?.()}
    result.gate=evaluateLatencyGate(result,TARGETS);
    results.push(result);
  }
  const report={
    schemaVersion:1,generatedAt:new Date().toISOString(),measurementKind:'streaming-pcm-candidate-benchmark',
    environment:{node:process.version,platform:process.platform,architecture:process.arch},
    corpus:{path:options.corpus,language:corpusDocument.language||'ko-KR',caseCount:corpus.length,cases:corpus.map(item=>({id:item.id,category:item.category,ttsText:item.ttsText}))},
    run:{iterations:options.iterations,warmups:options.warmups,concurrency:options.concurrency,timeoutMs:options.timeoutMs},
    targets:TARGETS,providers:results,
    limitations:[
      'TTFA는 별록이 첫 재생 가능한 PCM16LE 조각을 받은 시점이며 실제 OBS 스피커 출력 시각은 4단계 E2E에서 별도 계측합니다.',
      '자동 음성 검사는 무음·클리핑·길이·포맷만 판정합니다. 한국어 자연스러움과 감정 품질은 생성된 WAV 블라인드 청취 평가가 필요합니다.',
      '원격 공급자 비용과 상업 이용 조건은 이 보고서가 자동 판정하지 않습니다.'
    ]
  };
  await mkdir(dirname(options.jsonOutput),{recursive:true});
  await writeFile(options.jsonOutput,JSON.stringify(report,null,2)+'\n','utf8');
  console.log('BYEOLLOG_TTS_BENCHMARK_COMPLETE');
  for(const result of results){
    const metric=result.metrics.requestToFirstAudioMs;
    console.log(`${result.provider.id} success=${result.successRatePercent}% ttfaP50=${metric.p50}ms ttfaP95=${metric.p95}ms ttfaP99=${metric.p99}ms gate=${result.gate.passed?'PASS':'FAIL'}`);
  }
  console.log(`report=${options.jsonOutput}`);
  console.log(`samples=${options.samplesDir}`);
  if(options.selfTest&&!results.every(result=>result.gate.passed))process.exitCode=1;
}finally{if(fixture)await fixture.close()}
