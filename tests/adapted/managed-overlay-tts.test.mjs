import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {
  createManagedOverlayTtsRuntime,
  managedOverlayTtsConfig,
  managedTtsFrame,
  MANAGED_TTS_AUDIO_FRAME
} from '../../apps/admin-runtime/lib/managed-overlay-tts.js';

class FakeGoogleAuthClient{
  static options=[];
  constructor(options){this.options=options;FakeGoogleAuthClient.options.push(options)}
}

class FakeGoogleStream extends EventEmitter{
  constructor(callNumber){super();this.requests=[];this.callNumber=callNumber}
  write(value){this.requests.push(value);return true}
  end(){
    queueMicrotask(()=>{
      if(FakeGoogleClient.hangingCalls.has(this.callNumber))return;
      if(FakeGoogleClient.failures>0||FakeGoogleClient.failureCalls.has(this.callNumber)){
        if(FakeGoogleClient.failures>0)FakeGoogleClient.failures--;
        this.emit('error',Object.assign(new Error('primary unavailable'),{code:'primary_unavailable'}));return;
      }
      this.emit('data',{audioContent:Buffer.from([1,0,2,0,3,0,4,0])});
      this.emit('end');
    });
  }
  cancel(){this.cancelled=true}
  destroy(error){if(error)this.emit('error',error)}
}

class FakeGoogleClient{
  static failures=0;
  static streamCalls=0;
  static failureCalls=new Set();
  static hangingCalls=new Set();
  static clients=[];
  constructor(options){this.options=options;this.streams=[];FakeGoogleClient.clients.push(this)}
  streamingSynthesize(){const stream=new FakeGoogleStream(++FakeGoogleClient.streamCalls);this.streams.push(stream);return stream}
  async close(){this.closed=true}
}

class FakeWebSocket extends EventEmitter{
  static OPEN=1;
  static sends=[];
  static hangOpen=false;
  constructor(url,options){
    super();this.url=url;this.options=options;this.readyState=0;
    if(!FakeWebSocket.hangOpen)queueMicrotask(()=>{this.readyState=FakeWebSocket.OPEN;this.emit('open')});
  }
  send(input,callback){
    const message=JSON.parse(String(input));FakeWebSocket.sends.push({url:this.url,message});callback?.();
    if(message.transcript){
      queueMicrotask(()=>{
        const data=Buffer.from([5,0,6,0,7,0,8,0]).toString('base64');
        this.emit('message',Buffer.from(JSON.stringify({context_id:message.context_id,type:'chunk',data})));
        this.emit('message',Buffer.from(JSON.stringify({context_id:message.context_id,type:'done'})));
      });
    }
  }
  terminate(){this.readyState=3;this.emit('close')}
}

function environment(extra={}){
  return {
    MANAGED_OVERLAY_TTS_ENABLED:'1',
    GOOGLE_TTS_WIF_AUDIENCE:'//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/byeollog-vercel/providers/vercel-oidc',
    GOOGLE_TTS_SERVICE_ACCOUNT_EMAIL:'public-example@example-project.iam.gserviceaccount.com',
    GOOGLE_TTS_PROJECT_ID:'byeollog-tts',
    CARTESIA_API_KEY:'fallback-secret-key',
    CARTESIA_TTS_WEBSOCKET_URL:'wss://fallback.test',
    MANAGED_OVERLAY_TTS_TIMEOUT_MS:'5000',
    ...extra
  };
}

function runtime(extra={}){
  return createManagedOverlayTtsRuntime({
    environment:environment(extra),WebSocketImpl:FakeWebSocket,GoogleClient:FakeGoogleClient,
    GoogleAuthClient:FakeGoogleAuthClient,oidcTokenSupplier:async()=> 'vercel-oidc-token'
  });
}

test.beforeEach(()=>{
  FakeGoogleClient.failures=0;FakeGoogleClient.streamCalls=0;FakeGoogleClient.failureCalls=new Set();FakeGoogleClient.hangingCalls=new Set();FakeGoogleClient.clients=[];FakeGoogleAuthClient.options=[];FakeWebSocket.sends=[];FakeWebSocket.hangOpen=false;
});

test('configuration selects Google Leda then Cartesia Soojin without exposing credentials',()=>{
  const config=managedOverlayTtsConfig(environment());
  assert.equal(config.primary.id,'google');
  assert.equal(config.primary.voiceId,'ko-KR-Chirp3-HD-Leda');
  assert.equal(config.primary.authMode,'wif');
  assert.equal(config.fallback.id,'cartesia');
  assert.equal(config.fallback.voiceId,'cd6c48a9-774b-4397-98b4-9948c0a790f0');
  assert.equal(config.primaryFirstAudioTimeoutMs,4000);
  assert.equal(config.fallbackFirstAudioTimeoutMs,3000);
  assert.equal(config.primaryRetries,1);
  assert.equal('apiKey' in config.primary,false);
});

test('primary Google PCM16 audio streams at 24 kHz through Vercel OIDC federation',async()=>{
  const chunks=[],managed=runtime({CARTESIA_API_KEY:''});
  const result=await managed.synthesize({text:'윙크 테스트 음성',onAudioChunk:chunk=>chunks.push(Buffer.from(chunk))});
  assert.equal(result.provider,'google');
  assert.equal(result.cached,false);
  assert.deepEqual(Buffer.concat(chunks),Buffer.from([1,0,2,0,3,0,4,0]));
  assert.equal(managed.config.sampleRate,24000);
  const requests=FakeGoogleClient.clients[0].streams[0].requests;
  assert.deepEqual(requests[0].streamingConfig.voice,{name:'ko-KR-Chirp3-HD-Leda',languageCode:'ko-KR'});
  assert.equal(requests[0].streamingConfig.streamingAudioConfig.audioEncoding,'PCM');
  assert.equal(requests[0].streamingConfig.streamingAudioConfig.sampleRateHertz,24000);
  assert.deepEqual(requests[1],{input:{text:'윙크 테스트 음성'}});
  const auth=FakeGoogleAuthClient.options[0];
  assert.equal(auth.audience,environment().GOOGLE_TTS_WIF_AUDIENCE);
  assert.match(auth.service_account_impersonation_url,/byeollog-tts-runtime@byeollog-tts\.iam\.gserviceaccount\.com:generateAccessToken$/);
  assert.equal(await auth.subject_token_supplier.getSubjectToken(),'vercel-oidc-token');
});

test('transient failure before Google audio retries a fresh Google session',async()=>{
  FakeGoogleClient.failures=1;
  const attempts=[],managed=runtime(),chunks=[];
  const result=await managed.synthesize({text:'연속 룰렛 복구',onProviderAttempt:value=>attempts.push(value),onAudioChunk:chunk=>chunks.push(Buffer.from(chunk))});
  assert.equal(result.provider,'google');
  assert.equal(FakeGoogleClient.clients.length,2);
  assert.equal(FakeWebSocket.sends.length,0);
  assert.deepEqual(attempts.map(item=>[item.provider,item.attempt,item.outcome]),[
    ['google',1,'failed'],['google',2,'succeeded']
  ]);
});

test('two failures before Google audio fall back to Cartesia and replay uses cache',async()=>{
  FakeGoogleClient.failures=2;
  const managed=runtime(),first=[];
  const result=await managed.synthesize({text:'예비 음성 테스트',onAudioChunk:chunk=>first.push(Buffer.from(chunk))});
  assert.equal(result.provider,'cartesia');
  assert.deepEqual(Buffer.concat(first),Buffer.from([5,0,6,0,7,0,8,0]));
  const sendsAfterFirst=FakeWebSocket.sends.length,second=[];
  const cached=await managed.synthesize({text:'예비 음성 테스트',onAudioChunk:chunk=>second.push(Buffer.from(chunk))});
  assert.equal(cached.cached,true);
  assert.equal(cached.provider,'cartesia');
  assert.equal(FakeWebSocket.sends.length,sendsAfterFirst);
  assert.deepEqual(Buffer.concat(second),Buffer.concat(first));
});

test('a silent Google stream is bounded and moves directly to the fallback',async()=>{
  FakeGoogleClient.hangingCalls.add(1);
  const managed=runtime({MANAGED_OVERLAY_TTS_PRIMARY_FIRST_AUDIO_TIMEOUT_MS:'100'}),attempts=[],startedAt=performance.now();
  const result=await managed.synthesize({text:'무응답 제한 테스트',onProviderAttempt:value=>attempts.push(value),onAudioChunk:()=>{}});
  assert.equal(result.provider,'cartesia');
  assert.ok(performance.now()-startedAt<1000);
  assert.equal(FakeGoogleClient.clients.length,1);
  assert.deepEqual(attempts.map(item=>[item.provider,item.attempt,item.outcome,item.errorCode||null]),[
    ['google',1,'failed','provider_first_audio_timeout'],
    ['cartesia',1,'succeeded',null]
  ]);
});

test('a stalled fallback connection cannot hold a roulette command open',async()=>{
  FakeWebSocket.hangOpen=true;
  const managed=runtime({
    GOOGLE_TTS_WIF_AUDIENCE:'',GOOGLE_TTS_SERVICE_ACCOUNT_EMAIL:'',
    MANAGED_OVERLAY_TTS_FALLBACK_FIRST_AUDIO_TIMEOUT_MS:'100'
  });
  const startedAt=performance.now();
  await assert.rejects(
    ()=>managed.synthesize({text:'예비 공급자 정지',onAudioChunk:()=>{}}),
    error=>error.code==='provider_first_audio_timeout'&&error.provider==='cartesia'
  );
  assert.ok(performance.now()-startedAt<1000);
});

test('an 11-spin series recovers a transient tenth Google stream without blocking on fallback',async()=>{
  FakeGoogleClient.failureCalls.add(10);
  const managed=runtime(),attempts=[],providers=[];
  for(let spin=1;spin<=11;spin++){
    const result=await managed.synthesize({
      text:`연차 결과 ${spin}`,
      onProviderAttempt:value=>attempts.push({...value,spin}),
      onAudioChunk:()=>{}
    });
    providers.push(result.provider);
  }
  assert.deepEqual(providers,Array(11).fill('google'));
  assert.equal(FakeGoogleClient.streamCalls,12);
  assert.equal(FakeGoogleClient.clients.length,2);
  assert.equal(FakeWebSocket.sends.length,0);
  assert.deepEqual(attempts.filter(item=>item.spin===10).map(item=>[item.provider,item.attempt,item.outcome]),[
    ['google',1,'failed'],['google',2,'succeeded']
  ]);
});

test('managed TTS fails closed when disabled or unconfigured',()=>{
  assert.throws(()=>createManagedOverlayTtsRuntime({environment:{}}),error=>error.code==='managed_tts_disabled');
  assert.throws(()=>createManagedOverlayTtsRuntime({environment:{MANAGED_OVERLAY_TTS_ENABLED:'1'}}),error=>error.code==='managed_tts_unconfigured');
});

test('invalid workload identity configuration fails before any provider request',async()=>{
  const managed=createManagedOverlayTtsRuntime({
    environment:environment({GOOGLE_TTS_WIF_AUDIENCE:'https://attacker.invalid',CARTESIA_API_KEY:''}),WebSocketImpl:FakeWebSocket,GoogleClient:FakeGoogleClient,
    GoogleAuthClient:FakeGoogleAuthClient,oidcTokenSupplier:async()=>''
  });
  await assert.rejects(()=>managed.synthesize({text:'잘못된 인증',onAudioChunk:()=>{}}),error=>error.code==='google_wif_invalid');
});

test('binary frame carries type and big-endian payload length',()=>{
  const frame=managedTtsFrame(MANAGED_TTS_AUDIO_FRAME,Buffer.from([1,2,3]));
  assert.equal(frame.readUInt8(0),MANAGED_TTS_AUDIO_FRAME);
  assert.equal(frame.readUInt32BE(1),3);
  assert.deepEqual(frame.subarray(5),Buffer.from([1,2,3]));
});
