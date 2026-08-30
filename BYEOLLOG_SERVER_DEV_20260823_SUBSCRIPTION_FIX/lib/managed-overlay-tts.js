import crypto from 'node:crypto';
import WebSocket from 'ws';
import textToSpeech from '@google-cloud/text-to-speech';
import {IdentityPoolClient} from 'google-auth-library';
import {getVercelOidcToken} from '@vercel/functions/oidc';

const {TextToSpeechClient}=textToSpeech;

const SAMPLE_RATE=24_000;
const CHANNELS=1;
const MAX_AUDIO_BYTES=16*1024*1024;
const DEFAULT_CARTESIA_SOOJIN_ID='cd6c48a9-774b-4397-98b4-9948c0a790f0';
const DEFAULT_GOOGLE_VOICE='ko-KR-Chirp3-HD-Leda';

function asError(message,code='managed_tts_error',extra={}){
  return Object.assign(new Error(String(message||code)),{code,...extra});
}

function secret(environment,name){return String(environment?.[name]||'').trim()}
function integer(value,fallback,min,max){
  const parsed=Number(value);
  return Number.isSafeInteger(parsed)&&parsed>=min&&parsed<=max?parsed:fallback;
}

export function managedOverlayTtsConfig(environment=process.env){
  const enabled=String(environment.MANAGED_OVERLAY_TTS_ENABLED||'').trim()==='1';
  const googleAudience=secret(environment,'GOOGLE_TTS_WIF_AUDIENCE');
  const googleServiceAccount=secret(environment,'GOOGLE_TTS_SERVICE_ACCOUNT_EMAIL');
  const googleAdc=secret(environment,'GOOGLE_TTS_USE_ADC')==='1';
  const fallbackKey=secret(environment,'CARTESIA_API_KEY');
  return {
    enabled,
    primary:(googleAdc||(googleAudience&&googleServiceAccount))?{
      id:'google',authMode:googleAdc?'adc':'wif',audience:googleAudience,
      serviceAccountEmail:googleServiceAccount,projectId:secret(environment,'GOOGLE_TTS_PROJECT_ID'),
      voiceId:secret(environment,'GOOGLE_TTS_VOICE_NAME')||DEFAULT_GOOGLE_VOICE,
      endpoint:secret(environment,'GOOGLE_TTS_API_ENDPOINT')||'texttospeech.googleapis.com'
    }:null,
    fallback:fallbackKey.length>=8?{
      id:'cartesia',apiKey:fallbackKey,voiceId:secret(environment,'CARTESIA_VOICE_ID')||DEFAULT_CARTESIA_SOOJIN_ID,
      endpoint:secret(environment,'CARTESIA_TTS_WEBSOCKET_URL')||'wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14',
      modelId:secret(environment,'CARTESIA_TTS_MODEL_ID')||'sonic-3.6'
    }:null,
    maxSessions:integer(environment.MANAGED_OVERLAY_TTS_MAX_SESSIONS,4,1,12),
    timeoutMs:integer(environment.MANAGED_OVERLAY_TTS_TIMEOUT_MS,30_000,5_000,60_000),
    cacheTtlMs:integer(environment.MANAGED_OVERLAY_TTS_CACHE_TTL_MS,10*60_000,0,60*60_000),
    cacheEntries:integer(environment.MANAGED_OVERLAY_TTS_CACHE_ENTRIES,128,0,1000)
  };
}

function googleAuth(config,{AuthClient=IdentityPoolClient,oidcTokenSupplier=getVercelOidcToken}={}){
  if(config.authMode==='adc')return null;
  if(!/^\/\/iam\.googleapis\.com\/projects\/\d+\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/.test(config.audience)){
    throw asError('Google workload identity audience is invalid','google_wif_invalid');
  }
  if(!/^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(config.serviceAccountEmail)){
    throw asError('Google service account is invalid','google_wif_invalid');
  }
  return new AuthClient({
    audience:config.audience,
    subject_token_type:'urn:ietf:params:oauth:token-type:jwt',
    token_url:'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url:`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${config.serviceAccountEmail}:generateAccessToken`,
    service_account_impersonation:{token_lifetime_seconds:3600},
    scopes:['https://www.googleapis.com/auth/cloud-platform'],
    subject_token_supplier:{getSubjectToken:async()=>oidcTokenSupplier({expirationBufferMs:5*60*1000})}
  });
}

function audioBuffer(value){
  if(Buffer.isBuffer(value))return value;
  if(value instanceof Uint8Array)return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(typeof value==='string')return Buffer.from(value,'base64');
  return Buffer.alloc(0);
}

class GoogleSession{
  constructor(config,Client,authOptions){
    this.config=config;this.busy=false;
    const authClient=googleAuth(config,authOptions);
    this.client=new Client({apiEndpoint:config.endpoint,...(authClient?{authClient}:{}),...(config.projectId?{projectId:config.projectId}:{})});
    this.active=null;
  }
  async synthesize(text,{signal,onAudioChunk}){
    return await new Promise((resolve,reject)=>{
      const startedAt=performance.now(),chunks=[];let total=0,firstAudioAt=null,settled=false;
      const stream=this.client.streamingSynthesize();this.active=stream;
      const cleanup=()=>{signal?.removeEventListener?.('abort',abort);this.active=null};
      const fail=error=>{if(settled)return;settled=true;cleanup();reject(Object.assign(error instanceof Error?error:new Error(String(error||'Google stream failed')),{provider:'google'}))};
      const abort=()=>{const reason=signal?.reason||asError('Google request aborted','request_aborted',{provider:'google'});try{stream.cancel?.()}catch{}try{stream.destroy?.(reason)}catch{}fail(reason)};
      signal?.addEventListener?.('abort',abort,{once:true});if(signal?.aborted){abort();return}
      stream.on('data',response=>{
        try{
          const pcm=audioBuffer(response?.audioContent);if(!pcm.length)return;
          if(firstAudioAt===null)firstAudioAt=performance.now();total+=pcm.length;
          if(total>MAX_AUDIO_BYTES)throw asError('Google audio exceeded the limit','audio_too_large',{provider:'google'});
          chunks.push(pcm);onAudioChunk(pcm);
        }catch(error){fail(error)}
      });
      stream.once('error',fail);
      stream.once('end',()=>{
        if(settled)return;
        if(!chunks.length){fail(asError('Google audio was empty','empty_audio',{provider:'google'}));return}
        settled=true;cleanup();resolve({provider:'google',pcm:Buffer.concat(chunks,total),firstAudioMs:Math.round(firstAudioAt-startedAt),totalMs:Math.round(performance.now()-startedAt)});
      });
      try{
        stream.write({streamingConfig:{voice:{name:this.config.voiceId,languageCode:'ko-KR'},streamingAudioConfig:{audioEncoding:'PCM',sampleRateHertz:SAMPLE_RATE,speakingRate:1}}});
        stream.write({input:{text}});stream.end();
      }catch(error){fail(error)}
    });
  }
  close(){try{this.active?.cancel?.()}catch{}void this.client.close?.().catch?.(()=>{});this.active=null}
}

class CartesiaSession{
  constructor(config,WebSocketImpl){this.config=config;this.WebSocketImpl=WebSocketImpl;this.socket=null;this.opening=null;this.active=null;this.busy=false}
  fail(error){if(!this.active)return;const active=this.active;this.active=null;active.cleanup();active.reject(error)}
  onMessage(input){
    let message;try{message=JSON.parse(Buffer.from(input).toString('utf8'))}catch{return}
    const active=this.active;if(!active||message.context_id&&message.context_id!==active.contextId)return;
    if(message.type==='error'){this.fail(asError(message.message||message.title||'Cartesia stream failed',String(message.error_code||'cartesia_stream_error'),{provider:'cartesia'}));return}
    if(message.type==='chunk'&&message.data){
      const pcm=Buffer.from(message.data,'base64');
      if(pcm.length){
        if(active.firstAudioAt===null)active.firstAudioAt=performance.now();
        active.total+=pcm.length;
        if(active.total>MAX_AUDIO_BYTES){this.fail(asError('Cartesia audio exceeded the limit','audio_too_large',{provider:'cartesia'}));return}
        active.chunks.push(pcm);active.onAudioChunk(pcm);
      }
    }
    if((message.type==='done'||message.done===true)&&this.active){
      const done=this.active;this.active=null;done.cleanup();
      if(!done.chunks.length){done.reject(asError('Cartesia audio was empty','empty_audio',{provider:'cartesia'}));return}
      done.resolve({provider:'cartesia',pcm:Buffer.concat(done.chunks,done.total),firstAudioMs:Math.round(done.firstAudioAt-done.startedAt),totalMs:Math.round(performance.now()-done.startedAt)});
    }
  }
  async ready(){
    if(this.socket?.readyState===this.WebSocketImpl.OPEN)return;
    if(this.opening)return this.opening;
    this.opening=new Promise((resolve,reject)=>{
      let settled=false;const socket=new this.WebSocketImpl(this.config.endpoint,{headers:{'X-API-Key':this.config.apiKey},maxPayload:20*1024*1024});this.socket=socket;
      const timer=setTimeout(()=>finish(asError('Cartesia connection timed out','connection_timeout',{provider:'cartesia'})),10_000);
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve()};
      socket.on('open',()=>finish());socket.on('message',data=>this.onMessage(data));
      socket.on('error',error=>{this.fail(Object.assign(error,{provider:'cartesia'}));finish(error)});
      socket.on('close',()=>{this.socket=null;this.fail(asError('Cartesia connection closed','websocket_closed',{provider:'cartesia'}));finish(asError('Cartesia connection closed','websocket_closed',{provider:'cartesia'}))});
    }).finally(()=>{this.opening=null});
    return this.opening;
  }
  async synthesize(text,{signal,onAudioChunk}){
    await this.ready();
    return new Promise((resolve,reject)=>{
      const contextId=crypto.randomUUID(),startedAt=performance.now();
      const abort=()=>{try{this.socket?.send?.(JSON.stringify({context_id:contextId,cancel:true}))}catch{}this.fail(signal?.reason||asError('Cartesia request aborted','request_aborted',{provider:'cartesia'}))};
      const cleanup=()=>signal?.removeEventListener?.('abort',abort);
      this.active={contextId,resolve,reject,cleanup,startedAt,firstAudioAt:null,chunks:[],total:0,onAudioChunk};
      signal?.addEventListener?.('abort',abort,{once:true});if(signal?.aborted){abort();return}
      this.socket.send(JSON.stringify({model_id:this.config.modelId,transcript:text,voice:this.config.voiceId,language:'ko',context_id:contextId,output_format:{container:'raw',encoding:'pcm_s16le',sample_rate:SAMPLE_RATE},add_timestamps:false,add_phoneme_timestamps:false,continue:false,generation_config:{volume:1,speed:1}}),error=>{if(error)this.fail(Object.assign(error,{provider:'cartesia'}))});
    });
  }
  close(){try{this.socket?.terminate?.()}catch{}this.socket=null}
}

class SessionPool{
  constructor(create,maxSessions){this.create=create;this.maxSessions=maxSessions;this.sessions=[];this.waiters=[]}
  async acquire(signal){
    const available=this.sessions.find(session=>!session.busy);
    if(available){available.busy=true;return available}
    if(this.sessions.length<this.maxSessions){const session=this.create();session.busy=true;this.sessions.push(session);return session}
    return new Promise((resolve,reject)=>{
      const waiter={resolve,reject,signal};
      const abort=()=>{this.waiters=this.waiters.filter(item=>item!==waiter);reject(signal.reason||asError('TTS queue aborted','request_aborted'))};
      waiter.abort=abort;signal?.addEventListener?.('abort',abort,{once:true});this.waiters.push(waiter);
    });
  }
  release(session,{discard=false}={}){
    if(discard){session.close();this.sessions=this.sessions.filter(item=>item!==session)}else session.busy=false;
    while(this.waiters.length){
      const waiter=this.waiters.shift();waiter.signal?.removeEventListener?.('abort',waiter.abort);
      if(waiter.signal?.aborted)continue;
      const next=this.sessions.find(item=>!item.busy)||(this.sessions.length<this.maxSessions?this.create():null);
      if(!next){this.waiters.unshift(waiter);return}
      if(!this.sessions.includes(next))this.sessions.push(next);next.busy=true;waiter.resolve(next);return;
    }
  }
  close(){
    for(const session of this.sessions)session.close();
    this.sessions=[];
    for(const waiter of this.waiters){waiter.signal?.removeEventListener?.('abort',waiter.abort);waiter.reject(asError('TTS pool closed','request_aborted'))}
    this.waiters=[];
  }
}

export function createManagedOverlayTtsRuntime({environment=process.env,WebSocketImpl=WebSocket,GoogleClient=TextToSpeechClient,GoogleAuthClient=IdentityPoolClient,oidcTokenSupplier=getVercelOidcToken}={}){
  const config=managedOverlayTtsConfig(environment);
  if(!config.enabled)throw asError('Managed overlay TTS is disabled','managed_tts_disabled');
  if(!config.primary&&!config.fallback)throw asError('Managed overlay TTS providers are unavailable','managed_tts_unconfigured');
  const primaryPool=config.primary?new SessionPool(()=>new GoogleSession(config.primary,GoogleClient,{AuthClient:GoogleAuthClient,oidcTokenSupplier}),config.maxSessions):null;
  const fallbackPool=config.fallback?new SessionPool(()=>new CartesiaSession(config.fallback,WebSocketImpl),config.maxSessions):null;
  const cache=new Map();

  async function fromProvider(pool,provider,text,signal,onAudioChunk){
    const session=await pool.acquire(signal);let emitted=0,discard=false;
    try{
      return await session.synthesize(text,{signal,onAudioChunk:chunk=>{emitted+=chunk.length;onAudioChunk(chunk,provider)}});
    }catch(error){discard=true;throw Object.assign(error,{provider,emittedBytes:emitted})}
    finally{pool.release(session,{discard:discard||signal?.aborted||false})}
  }
  function cacheKey(text){return crypto.createHash('sha256').update(text,'utf8').digest('hex')}
  function prune(){
    const now=Date.now();for(const [key,value] of cache)if(value.expiresAt<=now)cache.delete(key);
    while(cache.size>config.cacheEntries)cache.delete(cache.keys().next().value);
  }
  return {
    config:{enabled:true,primary:config.primary?.id||null,fallback:config.fallback?.id||null,sampleRate:SAMPLE_RATE,channels:CHANNELS},
    async synthesize({text,signal,onAudioChunk}){
      const normalized=String(text||'').trim();if(!normalized||normalized.length>240)throw asError('TTS text is invalid','invalid_tts_text');
      const requestController=new AbortController();
      const forwardAbort=()=>requestController.abort(signal?.reason||asError('Managed TTS request aborted','request_aborted'));
      signal?.addEventListener?.('abort',forwardAbort,{once:true});
      if(signal?.aborted)forwardAbort();
      const timeout=setTimeout(()=>requestController.abort(asError('Managed TTS request timed out','synthesis_timeout')),config.timeoutMs);
      const key=cacheKey(normalized);prune();const cached=cache.get(key);
      try{
        if(cached){for(let offset=0;offset<cached.pcm.length;offset+=9600)onAudioChunk(cached.pcm.subarray(offset,Math.min(offset+9600,cached.pcm.length)),cached.provider);return {...cached,firstAudioMs:0,totalMs:0,cached:true}}
        const providers=[];if(primaryPool)providers.push({pool:primaryPool,id:'google'});if(fallbackPool)providers.push({pool:fallbackPool,id:'cartesia'});
        let lastError=null;
        for(const candidate of providers){
          try{
            const result=await fromProvider(candidate.pool,candidate.id,normalized,requestController.signal,onAudioChunk);
            if(config.cacheEntries>0&&config.cacheTtlMs>0){cache.set(key,{provider:result.provider,pcm:result.pcm,expiresAt:Date.now()+config.cacheTtlMs});prune()}
            return {...result,cached:false};
          }catch(error){
            lastError=error;
            if(requestController.signal.aborted)throw requestController.signal.reason||error;
            if(Number(error?.emittedBytes||0)>0)throw asError('Managed TTS stream stopped after playback began','partial_stream_failed',{provider:candidate.id,emittedBytes:error.emittedBytes,cause:error});
          }
        }
        throw lastError||asError('Managed TTS providers failed','all_providers_failed');
      }finally{
        clearTimeout(timeout);
        signal?.removeEventListener?.('abort',forwardAbort);
      }
    },
    close(){primaryPool?.close();fallbackPool?.close();cache.clear()}
  };
}

let singleton=null;
export function managedOverlayTtsRuntime(){
  if(!singleton)singleton=createManagedOverlayTtsRuntime();
  return singleton;
}

export function resetManagedOverlayTtsRuntimeForTest(){singleton=null}

export function managedTtsFrame(type,payload=Buffer.alloc(0)){
  const body=Buffer.from(payload),header=Buffer.alloc(5);header.writeUInt8(type,0);header.writeUInt32BE(body.length,1);return Buffer.concat([header,body]);
}

export const MANAGED_TTS_AUDIO_FRAME=1;
export const MANAGED_TTS_END_FRAME=2;
export const MANAGED_TTS_ERROR_FRAME=3;
export const MANAGED_TTS_SAMPLE_RATE=SAMPLE_RATE;
