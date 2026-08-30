import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import {wavPcm16le} from './core.mjs';

function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(!value)throw new Error(`required environment variable is missing: ${name}`);
  return value;
}
function asError(message,code='inworld_websocket_error'){
  return Object.assign(new Error(String(message||code)),{code});
}

export function createInworldWebSocketAdapter(config,{environment=process.env,WebSocketImpl=WebSocket}={}){
  const endpoint=String(config.endpoint||'wss://api.inworld.ai/tts/v1/voice:streamBidirectional');
  const voiceId=String(config.voiceId||requiredEnv(config.voiceIdEnv||'INWORLD_VOICE_ID',environment));
  const apiKey=requiredEnv(config.apiKeyEnv||'INWORLD_API_KEY',environment);
  const contextId=`byeollog-${randomUUID()}`;
  const sampleRate=Number(config.sampleRate||24_000);
  let socket=null,opening=null,contextReady=false,active=null,closed=false;

  function rejectActive(error){
    if(!active)return;
    const pending=active;active=null;
    pending.cleanup();pending.reject(error);
  }

  function handleMessage(input){
    let message;
    try{message=JSON.parse(Buffer.from(input).toString('utf8'))}
    catch{return}
    if(message?.error){rejectActive(asError(message.error.message||JSON.stringify(message.error),String(message.error.code||'inworld_stream_error')));return}
    const result=message?.result;
    if(!result)return;
    if(result.contextCreated!==undefined){contextReady=true;return}
    if(!active)return;
    if(!active.firstByteReported){active.firstByteReported=true;active.onFirstByte()}
    if(result.audioChunk?.audioContent){
      try{
        const encoded=Buffer.from(result.audioChunk.audioContent,'base64');
        let pcm,chunkSampleRate=sampleRate,channels=1;
        if(encoded.length>=12&&encoded.toString('ascii',0,4)==='RIFF'){
          const wave=wavPcm16le(encoded);pcm=wave.pcm;chunkSampleRate=wave.sampleRate;channels=wave.channels;
        }else pcm=encoded;
        if(active.sampleRate===null){active.sampleRate=chunkSampleRate;active.channels=channels}
        if(chunkSampleRate!==active.sampleRate||channels!==active.channels)throw asError('Inworld changed PCM format during one stream','inconsistent_audio_format');
        if(active.chunks.length===0)active.onFirstAudio();
        active.chunks.push(pcm);active.total+=pcm.length;
        if(active.total>Number(config.maxBytes||16*1024*1024))throw asError('Inworld audio exceeded byte limit','audio_too_large');
      }catch(error){rejectActive(error);return}
    }
    if(result.flushCompleted!==undefined){
      const pending=active;active=null;pending.cleanup();
      if(!pending.chunks.length){pending.reject(asError('Inworld audio was empty','empty_audio'));return}
      pending.resolve({pcm:Buffer.concat(pending.chunks,pending.total),sampleRate:pending.sampleRate,channels:pending.channels});
    }
  }

  async function ensureReady(){
    if(closed)throw asError('Inworld WebSocket adapter is closed','adapter_closed');
    if(socket?.readyState===WebSocketImpl.OPEN&&contextReady)return;
    if(opening)return opening;
    opening=new Promise((resolve,reject)=>{
      let settled=false;
      const candidate=new WebSocketImpl(endpoint,{headers:{authorization:`Basic ${apiKey}`},maxPayload:Number(config.maxPayload||20*1024*1024)});
      socket=candidate;
      const timeout=setTimeout(()=>finish(asError('Inworld WebSocket context timed out','context_timeout')),10_000);
      const finish=error=>{
        if(settled)return;settled=true;clearTimeout(timeout);
        if(error)reject(error);else resolve();
      };
      candidate.on('error',error=>{rejectActive(error);finish(error)});
      candidate.on('close',()=>{
        contextReady=false;socket=null;rejectActive(asError('Inworld WebSocket closed','websocket_closed'));
        finish(asError('Inworld WebSocket closed before context creation','websocket_closed'));
      });
      candidate.on('message',data=>{
        handleMessage(data);
        if(contextReady)finish();
      });
      candidate.on('open',()=>candidate.send(JSON.stringify({
        context_id:contextId,
        create:{
          voice_id:voiceId,model_id:config.modelId||'inworld-tts-2-flash',
          audio_config:{audio_encoding:'LINEAR16',sample_rate_hertz:sampleRate},
          language:config.language||'ko-KR',apply_text_normalization:config.applyTextNormalization||'OFF',
          auto_mode:true,buffer_char_threshold:1,max_buffer_delay_ms:1
        }
      })));
    }).finally(()=>{opening=null});
    return opening;
  }

  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      if(active)throw asError('Inworld WebSocket adapter only supports sequential benchmark requests','concurrency_not_supported');
      await ensureReady();
      return new Promise((resolve,reject)=>{
        const abort=()=>{
          rejectActive(signal.reason||asError('Inworld request aborted','AbortError'));
          try{socket?.terminate?.()}catch{}
        };
        const cleanup=()=>signal?.removeEventListener?.('abort',abort);
        active={resolve,reject,cleanup,onFirstByte,onFirstAudio,firstByteReported:false,chunks:[],total:0,sampleRate:null,channels:null};
        signal?.addEventListener?.('abort',abort,{once:true});
        if(signal?.aborted){abort();return}
        socket.send(JSON.stringify({context_id:contextId,send_text:{text,flush_context:{}}}),error=>{
          if(error)rejectActive(error);
        });
      });
    },
    async close(){
      closed=true;
      if(!socket)return;
      const current=socket;socket=null;contextReady=false;
      try{if(current.readyState===WebSocketImpl.OPEN)current.send(JSON.stringify({context_id:contextId,close_context:{}}))}catch{}
      await new Promise(resolve=>{
        const timer=setTimeout(resolve,500);
        current.once?.('close',()=>{clearTimeout(timer);resolve()});
        try{current.close()}catch{clearTimeout(timer);resolve()}
      });
    }
  };
}
