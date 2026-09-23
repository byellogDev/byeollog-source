import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(!value)throw new Error(`required environment variable is missing: ${name}`);
  return value;
}

function asError(message,code='cartesia_websocket_error'){
  return Object.assign(new Error(String(message||code)),{code});
}

export function createCartesiaWebSocketAdapter(config,{environment=process.env,WebSocketImpl=WebSocket}={}){
  const apiKey=requiredEnv(config.apiKeyEnv||'CARTESIA_API_KEY',environment);
  const voice=String(config.voiceId||requiredEnv(config.voiceIdEnv||'CARTESIA_VOICE_ID',environment));
  const endpoint=String(config.endpoint||'wss://api.cartesia.ai/tts/websocket?cartesia_version=2026-08-14');
  const sampleRate=Number(config.sampleRate||24_000);
  let socket=null,opening=null,active=null,closed=false;

  function rejectActive(error){
    if(!active)return;
    const pending=active;active=null;
    pending.cleanup();pending.reject(error);
  }

  function handleMessage(input){
    let message;
    try{message=JSON.parse(Buffer.from(input).toString('utf8'))}
    catch{return}
    if(!active)return;
    if(message.context_id&&message.context_id!==active.contextId)return;
    if(!active.firstByteReported){active.firstByteReported=true;active.onFirstByte()}
    if(message.type==='error'){
      rejectActive(asError(message.message||message.title||JSON.stringify(message),String(message.error_code||'cartesia_stream_error')));
      return;
    }
    if(message.type==='chunk'&&message.data){
      const pcm=Buffer.from(message.data,'base64');
      if(pcm.length){
        if(active.chunks.length===0)active.onFirstAudio();
        active.chunks.push(pcm);active.total+=pcm.length;
        if(active.total>Number(config.maxBytes||16*1024*1024)){
          rejectActive(asError('Cartesia audio exceeded byte limit','audio_too_large'));
          return;
        }
      }
    }
    if(message.type==='done'||message.done===true){
      const pending=active;active=null;pending.cleanup();
      if(!pending.chunks.length){pending.reject(asError('Cartesia audio was empty','empty_audio'));return}
      pending.resolve({pcm:Buffer.concat(pending.chunks,pending.total),sampleRate,channels:1});
    }
  }

  async function ensureReady(){
    if(closed)throw asError('Cartesia WebSocket adapter is closed','adapter_closed');
    if(socket?.readyState===WebSocketImpl.OPEN)return;
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let settled=false;
      const candidate=new WebSocketImpl(endpoint,{headers:{'X-API-Key':apiKey},maxPayload:Number(config.maxPayload||20*1024*1024)});
      socket=candidate;
      const timeout=setTimeout(()=>finish(asError('Cartesia WebSocket connection timed out','connection_timeout')),10_000);
      const finish=error=>{
        if(settled)return;settled=true;clearTimeout(timeout);
        if(error)reject(error);else resolve();
      };
      candidate.on('open',()=>finish());
      candidate.on('message',handleMessage);
      candidate.on('error',error=>{rejectActive(error);finish(error)});
      candidate.on('close',()=>{
        socket=null;
        rejectActive(asError('Cartesia WebSocket closed','websocket_closed'));
        finish(asError('Cartesia WebSocket closed before opening','websocket_closed'));
      });
    }).finally(()=>{opening=null});
    return opening;
  }

  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      if(active)throw asError('Cartesia WebSocket adapter only supports sequential benchmark requests','concurrency_not_supported');
      await ensureReady();
      return new Promise((resolve,reject)=>{
        const contextId=randomUUID();
        const abort=()=>{
          try{socket?.send?.(JSON.stringify({context_id:contextId,cancel:true}))}catch{}
          rejectActive(signal.reason||asError('Cartesia request aborted','AbortError'));
        };
        const cleanup=()=>signal?.removeEventListener?.('abort',abort);
        active={contextId,resolve,reject,cleanup,onFirstByte,onFirstAudio,firstByteReported:false,chunks:[],total:0};
        signal?.addEventListener?.('abort',abort,{once:true});
        if(signal?.aborted){abort();return}
        socket.send(JSON.stringify({
          model_id:config.modelId||'sonic-3.6',transcript:text,voice,language:'ko',context_id:contextId,
          output_format:{container:'raw',encoding:'pcm_s16le',sample_rate:sampleRate},
          add_timestamps:false,add_phoneme_timestamps:false,continue:false,
          generation_config:{volume:1,speed:Number(config.speed||1)}
        }),error=>{if(error)rejectActive(error)});
      });
    },
    async close(){
      closed=true;
      if(!socket)return;
      const current=socket;socket=null;
      await new Promise(resolve=>{
        const timer=setTimeout(resolve,500);
        current.once?.('close',()=>{clearTimeout(timer);resolve()});
        try{current.close()}catch{clearTimeout(timer);resolve()}
      });
    }
  };
}
