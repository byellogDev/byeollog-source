import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzePcm16le,evaluateLatencyGate,pcm16leToWav,runProviderBenchmark,summarize,wavPcm16le} from '../../apps/web/tools/tts-benchmark/core.mjs';
import {createHttpPcmAdapter} from '../../apps/web/tools/tts-benchmark/http-pcm-adapter.mjs';
import {listenFixture} from '../../apps/web/tools/tts-benchmark/fixture-server.mjs';
import {createCartesiaSseAdapter} from '../../apps/web/tools/tts-benchmark/cartesia-sse-adapter.mjs';
import {createCartesiaWebSocketAdapter} from '../../apps/web/tools/tts-benchmark/cartesia-websocket-adapter.mjs';
import {createElevenLabsHttpAdapter} from '../../apps/web/tools/tts-benchmark/elevenlabs-http-adapter.mjs';
import {createInworldHttpStreamAdapter} from '../../apps/web/tools/tts-benchmark/inworld-http-stream-adapter.mjs';
import {createInworldWebSocketAdapter} from '../../apps/web/tools/tts-benchmark/inworld-websocket-adapter.mjs';
import {createGoogleChirp3StreamingAdapter} from '../../apps/web/tools/tts-benchmark/google-chirp3-streaming-adapter.mjs';
import {EventEmitter} from 'node:events';

function chunkedResponse(chunks,init){
  return new Response(new ReadableStream({start(controller){for(const chunk of chunks)controller.enqueue(Buffer.from(chunk));controller.close()}}),init);
}

test('streaming benchmark measures first playable PCM, concurrency and audio integrity',async()=>{
  const fixture=await listenFixture({firstAudioDelayMs:12,chunkIntervalMs:1});
  try{
    const provider={id:'fixture_pcm',kind:'http-pcm-v1',endpoint:fixture.origin+'/v1/tts',sampleRate:24_000,channels:1};
    const samples=[];
    const result=await runProviderBenchmark({
      provider,adapter:createHttpPcmAdapter(provider),corpus:[
        {id:'short',category:'chat',ttsText:'딸깍'},
        {id:'result',category:'roulette',ttsText:'테스트 용돈, 당첨!'}
      ],iterations:2,warmups:1,concurrency:2,timeoutMs:2_000,
      onSample:async sample=>samples.push(sample)
    });
    assert.equal(result.requestCount,4);
    assert.equal(result.successes,4);
    assert.equal(result.failures,0);
    assert.equal(result.successRatePercent,100);
    assert.equal(result.metrics.requestToFirstAudioMs.count,4);
    assert.ok(result.metrics.requestToFirstAudioMs.p95<450);
    assert.ok(result.metrics.audioDurationMs.min>=260);
    assert.equal(samples.length,2);
    assert.equal(evaluateLatencyGate(result).passed,true);
  }finally{await fixture.close()}
});

test('PCM analyzer rejects silence and WAV encoder preserves the stream contract',()=>{
  const pcm=Buffer.alloc(4800);
  for(let offset=0;offset<pcm.length;offset+=2)pcm.writeInt16LE(offset%400===0?8_000:1_200,offset);
  const analysis=analyzePcm16le(pcm,{sampleRate:24_000,channels:1});
  assert.equal(analysis.durationMs,100);
  assert.ok(analysis.rmsRatio>0);
  const wav=pcm16leToWav(pcm,{sampleRate:24_000,channels:1});
  assert.equal(wav.subarray(0,4).toString('ascii'),'RIFF');
  assert.equal(wav.subarray(8,12).toString('ascii'),'WAVE');
  assert.equal(wav.length,pcm.length+44);
  const decoded=wavPcm16le(wav);
  assert.deepEqual(decoded.pcm,pcm);
  assert.equal(decoded.sampleRate,24_000);
  assert.equal(decoded.channels,1);
});

test('WAV parser rejects containers that are not PCM16LE',()=>{
  assert.throws(()=>wavPcm16le(Buffer.from('not a wave')),/invalid/);
  const wav=pcm16leToWav(Buffer.from([1,0,2,0]),{sampleRate:24_000,channels:1});
  wav.writeUInt16LE(3,20);
  assert.throws(()=>wavPcm16le(wav),/PCM16LE/);
});

test('ElevenLabs adapter requests Korean Flash PCM and exposes the first audio chunk',async()=>{
  const pcm=Buffer.from([1,0,2,0,3,0,4,0]);let request=null,firstByte=0,firstAudio=0;
  const adapter=createElevenLabsHttpAdapter({voiceIdEnv:'VOICE',apiKeyEnv:'KEY'},{
    environment:{VOICE:'voice-123',KEY:'secret-key'},
    fetchImpl:async(url,options)=>{request={url:String(url),options};return chunkedResponse([pcm.subarray(0,4),pcm.subarray(4)],{status:200,headers:{'content-type':'audio/pcm'}})}
  });
  const result=await adapter.synthesize({text:'딸깍',signal:AbortSignal.timeout(1000),onFirstByte:()=>firstByte++,onFirstAudio:()=>firstAudio++});
  assert.deepEqual(result.pcm,pcm);
  assert.equal(result.sampleRate,24_000);
  assert.match(request.url,/output_format=pcm_24000/);
  const body=JSON.parse(request.options.body);
  assert.equal(body.model_id,'eleven_flash_v2_5');
  assert.equal(body.language_code,'ko');
  assert.equal(firstByte,1);
  assert.equal(firstAudio,1);
});

test('Cartesia adapter decodes split SSE PCM chunks and requires a done event',async()=>{
  const first=Buffer.from([1,0,2,0]),second=Buffer.from([3,0,4,0]);let body=null,firstByte=0,firstAudio=0;
  const frames=[
    `data: ${JSON.stringify({type:'chunk',data:first.toString('base64'),done:false})}\r\n\r\n`,
    `data: ${JSON.stringify({type:'chunk',data:second.toString('base64'),done:false})}\n\n`,
    `data: ${JSON.stringify({type:'done',done:true})}\n\n`
  ];
  const adapter=createCartesiaSseAdapter({voiceIdEnv:'VOICE',apiKeyEnv:'KEY'},{
    environment:{VOICE:'voice-456',KEY:'secret-key'},
    fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return chunkedResponse([frames[0].slice(0,-1),frames[0].slice(-1)+frames[1],frames[2]],{status:200,headers:{'content-type':'text/event-stream'}})}
  });
  const result=await adapter.synthesize({text:'딸깍',signal:AbortSignal.timeout(1000),onFirstByte:()=>firstByte++,onFirstAudio:()=>firstAudio++});
  assert.deepEqual(result.pcm,Buffer.concat([first,second]));
  assert.equal(body.model_id,'sonic-3.6');
  assert.equal(body.language,'ko');
  assert.equal(body.output_format.encoding,'pcm_s16le');
  assert.equal(firstByte,1);
  assert.equal(firstAudio,1);
});

test('Cartesia WebSocket adapter reuses one connection with a new context per request',async()=>{
  const pcm=Buffer.from([1,0,2,0,3,0,4,0]);
  class FakeWebSocket extends EventEmitter{
    static OPEN=1;
    static instances=[];
    constructor(_url,options){super();this.options=options;this.readyState=FakeWebSocket.OPEN;this.sent=[];FakeWebSocket.instances.push(this);queueMicrotask(()=>this.emit('open'))}
    send(raw,callback){
      const message=JSON.parse(raw);this.sent.push(message);callback?.();
      if(message.transcript)queueMicrotask(()=>{
        this.emit('message',Buffer.from(JSON.stringify({type:'chunk',context_id:message.context_id,data:pcm.toString('base64'),done:false})));
        this.emit('message',Buffer.from(JSON.stringify({type:'done',context_id:message.context_id,done:true})));
      });
    }
    close(){this.readyState=3;queueMicrotask(()=>this.emit('close'))}
  }
  const adapter=createCartesiaWebSocketAdapter({voiceIdEnv:'VOICE',apiKeyEnv:'KEY'},{environment:{VOICE:'Soojin',KEY:'secret-key'},WebSocketImpl:FakeWebSocket});
  const first=await adapter.synthesize({text:'딸깍',signal:AbortSignal.timeout(1000),onFirstByte:()=>{},onFirstAudio:()=>{}});
  const second=await adapter.synthesize({text:'안녕하세요',signal:AbortSignal.timeout(1000),onFirstByte:()=>{},onFirstAudio:()=>{}});
  assert.deepEqual(first.pcm,pcm);assert.deepEqual(second.pcm,pcm);
  assert.equal(FakeWebSocket.instances.length,1);
  assert.equal(FakeWebSocket.instances[0].options.headers['X-API-Key'],'secret-key');
  const requests=FakeWebSocket.instances[0].sent.filter(message=>message.transcript);
  assert.equal(requests.length,2);
  assert.notEqual(requests[0].context_id,requests[1].context_id);
  assert.equal(requests[0].model_id,'sonic-3.6');
  assert.equal(requests[0].language,'ko');
  await adapter.close();
});

test('Inworld adapter decodes concatenated and split JSON WAV chunks',async()=>{
  const firstPcm=Buffer.from([1,0,2,0,3,0,4,0]),secondPcm=Buffer.from([5,0,6,0,7,0,8,0]);
  const first=JSON.stringify({result:{audioContent:pcm16leToWav(firstPcm,{sampleRate:24_000,channels:1}).toString('base64')}});
  const second=JSON.stringify({result:{audioContent:pcm16leToWav(secondPcm,{sampleRate:24_000,channels:1}).toString('base64')}});
  let request=null,firstByte=0,firstAudio=0;
  const adapter=createInworldHttpStreamAdapter({voiceIdEnv:'VOICE',apiKeyEnv:'KEY'}, {
    environment:{VOICE:'KoreanVoice',KEY:'base64-secret'},
    fetchImpl:async(_url,options)=>{request=options;return chunkedResponse([first.slice(0,25),first.slice(25)+'\n'+second],{status:200,headers:{'content-type':'application/json'}})}
  });
  const result=await adapter.synthesize({text:'딸깍',signal:AbortSignal.timeout(1000),onFirstByte:()=>firstByte++,onFirstAudio:()=>firstAudio++});
  assert.deepEqual(result.pcm,Buffer.concat([firstPcm,secondPcm]));
  assert.equal(result.sampleRate,24_000);
  assert.equal(result.channels,1);
  assert.equal(request.headers.authorization,'Basic base64-secret');
  const body=JSON.parse(request.body);
  assert.equal(body.modelId,'inworld-tts-2-flash');
  assert.equal(body.language,'ko-KR');
  assert.equal(body.applyTextNormalization,'OFF');
  assert.equal(firstByte,1);
  assert.equal(firstAudio,1);
});

test('Inworld WebSocket adapter reuses one ready context across requests',async()=>{
  const pcm=Buffer.from([1,0,2,0,3,0,4,0]);
  const audioContent=pcm16leToWav(pcm,{sampleRate:24_000,channels:1}).toString('base64');
  class FakeWebSocket extends EventEmitter{
    static OPEN=1;
    static instances=[];
    constructor(_url,options){super();this.options=options;this.readyState=FakeWebSocket.OPEN;this.sent=[];FakeWebSocket.instances.push(this);queueMicrotask(()=>this.emit('open'))}
    send(raw,callback){
      const message=JSON.parse(raw);this.sent.push(message);callback?.();
      if(message.create)queueMicrotask(()=>this.emit('message',Buffer.from(JSON.stringify({result:{contextCreated:{}}}))));
      if(message.send_text)queueMicrotask(()=>{
        this.emit('message',Buffer.from(JSON.stringify({result:{audioChunk:{audioContent}}})));
        this.emit('message',Buffer.from(JSON.stringify({result:{flushCompleted:{}}})));
      });
    }
    close(){this.readyState=3;queueMicrotask(()=>this.emit('close'))}
    terminate(){this.close()}
  }
  const adapter=createInworldWebSocketAdapter({voiceIdEnv:'VOICE',apiKeyEnv:'KEY'},{environment:{VOICE:'Minji',KEY:'base64-secret'},WebSocketImpl:FakeWebSocket});
  const first=await adapter.synthesize({text:'딸깍',signal:AbortSignal.timeout(1000),onFirstByte:()=>{},onFirstAudio:()=>{}});
  const second=await adapter.synthesize({text:'안녕하세요',signal:AbortSignal.timeout(1000),onFirstByte:()=>{},onFirstAudio:()=>{}});
  assert.deepEqual(first.pcm,pcm);assert.deepEqual(second.pcm,pcm);
  assert.equal(FakeWebSocket.instances.length,1);
  assert.equal(FakeWebSocket.instances[0].options.headers.authorization,'Basic base64-secret');
  assert.equal(FakeWebSocket.instances[0].sent.filter(message=>message.create).length,1);
  assert.equal(FakeWebSocket.instances[0].sent.filter(message=>message.send_text).length,2);
  await adapter.close();
});

test('Google Chirp 3 adapter sends config first and joins headerless streaming PCM',async()=>{
  const first=Buffer.from([1,0,2,0]),second=Buffer.from([3,0,4,0]);
  class FakeStream extends EventEmitter{
    constructor(){super();this.requests=[]}
    write(request){this.requests.push(request);return true}
    end(){queueMicrotask(()=>{this.emit('data',{audioContent:first});this.emit('data',{audioContent:second.toString('base64')});this.emit('end')})}
    cancel(){this.cancelled=true}
  }
  class FakeClient{
    static instances=[];
    constructor(options){this.options=options;this.stream=new FakeStream();FakeClient.instances.push(this)}
    streamingSynthesize(){return this.stream}
    async close(){this.closed=true}
  }
  let firstByte=0,firstAudio=0;
  const adapter=createGoogleChirp3StreamingAdapter({
    voiceName:'ko-KR-Chirp3-HD-Kore',languageCode:'ko-KR',sampleRate:24_000,speakingRate:1
  },{Client:FakeClient});
  const result=await adapter.synthesize({text:'딸깍',signal:AbortSignal.timeout(1_000),onFirstByte:()=>firstByte++,onFirstAudio:()=>firstAudio++});
  assert.deepEqual(result.pcm,Buffer.concat([first,second]));
  assert.equal(result.sampleRate,24_000);
  assert.equal(result.channels,1);
  const requests=FakeClient.instances[0].stream.requests;
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0],{
    streamingConfig:{
      voice:{name:'ko-KR-Chirp3-HD-Kore',languageCode:'ko-KR'},
      streamingAudioConfig:{audioEncoding:'PCM',sampleRateHertz:24_000,speakingRate:1}
    }
  });
  assert.deepEqual(requests[1],{input:{text:'딸깍'}});
  assert.equal(firstByte,1);
  assert.equal(firstAudio,1);
  await adapter.close();
  assert.equal(FakeClient.instances[0].closed,true);
});

test('latency summaries use deterministic nearest-rank percentiles',()=>{
  assert.deepEqual(summarize([1,2,3,4,100]),{count:5,min:1,p50:3,p95:100,p99:100,max:100,mean:22});
});
