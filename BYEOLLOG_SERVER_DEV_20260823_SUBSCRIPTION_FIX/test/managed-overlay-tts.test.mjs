import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {
  createManagedOverlayTtsRuntime,
  managedOverlayTtsConfig,
  managedTtsFrame,
  MANAGED_TTS_AUDIO_FRAME
} from '../lib/managed-overlay-tts.js';

class FakeGoogleAuthClient{
  static options=[];
  constructor(options){this.options=options;FakeGoogleAuthClient.options.push(options)}
}

class FakeGoogleStream extends EventEmitter{
  constructor(){super();this.requests=[]}
  write(value){this.requests.push(value);return true}
  end(){
    queueMicrotask(()=>{
      if(FakeGoogleClient.failures>0){FakeGoogleClient.failures--;this.emit('error',Object.assign(new Error('primary unavailable'),{code:'primary_unavailable'}));return}
      this.emit('data',{audioContent:Buffer.from([1,0,2,0,3,0,4,0])});
      this.emit('end');
    });
  }
  cancel(){this.cancelled=true}
  destroy(error){if(error)this.emit('error',error)}
}

class FakeGoogleClient{
  static failures=0;
  static clients=[];
  constructor(options){this.options=options;this.streams=[];FakeGoogleClient.clients.push(this)}
  streamingSynthesize(){const stream=new FakeGoogleStream();this.streams.push(stream);return stream}
  async close(){this.closed=true}
}

class FakeWebSocket extends EventEmitter{
  static OPEN=1;
  static sends=[];
  constructor(url,options){
    super();this.url=url;this.options=options;this.readyState=0;
    queueMicrotask(()=>{this.readyState=FakeWebSocket.OPEN;this.emit('open')});
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
  FakeGoogleClient.failures=0;FakeGoogleClient.clients=[];FakeGoogleAuthClient.options=[];FakeWebSocket.sends=[];
});

test('configuration selects Google Leda then Cartesia Soojin without exposing credentials',()=>{
  const config=managedOverlayTtsConfig(environment());
  assert.equal(config.primary.id,'google');
  assert.equal(config.primary.voiceId,'ko-KR-Chirp3-HD-Leda');
  assert.equal(config.primary.authMode,'wif');
  assert.equal(config.fallback.id,'cartesia');
  assert.equal(config.fallback.voiceId,'cd6c48a9-774b-4397-98b4-9948c0a790f0');
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

test('failure before Google audio falls back to Cartesia and replay uses cache',async()=>{
  FakeGoogleClient.failures=1;
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
