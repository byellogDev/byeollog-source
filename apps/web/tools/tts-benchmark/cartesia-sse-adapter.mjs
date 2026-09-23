import {randomUUID} from 'node:crypto';

function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(!value)throw new Error(`required environment variable is missing: ${name}`);
  return value;
}

function decodeEvents(buffer,onEvent){
  let boundary;
  while((boundary=buffer.indexOf('\n\n'))>=0){
    const frame=buffer.slice(0,boundary).replaceAll('\r','');buffer=buffer.slice(boundary+2);
    const data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    if(data)onEvent(JSON.parse(data));
  }
  return buffer;
}

export function createCartesiaSseAdapter(config,{environment=process.env,fetchImpl=fetch}={}){
  const apiKeyEnv=String(config.apiKeyEnv||'CARTESIA_API_KEY');
  const voice=String(config.voiceId||requiredEnv(config.voiceIdEnv||'CARTESIA_VOICE_ID',environment));
  const endpoint=new URL(config.endpoint||'https://api.cartesia.ai/tts/sse');
  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      const response=await fetchImpl(endpoint,{
        method:'POST',signal,cache:'no-store',
        headers:{authorization:`Bearer ${requiredEnv(apiKeyEnv,environment)}`,'cartesia-version':config.apiVersion||'2026-08-14','content-type':'application/json',accept:'text/event-stream'},
        body:JSON.stringify({
          model_id:config.modelId||'sonic-3.6',transcript:text,voice,language:'ko',normalization:'auto',
          output_format:{container:'raw',encoding:'pcm_s16le',sample_rate:24_000},
          add_timestamps:false,add_phoneme_timestamps:false,generation_config:{volume:1,speed:Number(config.speed||1)},context_id:randomUUID()
        })
      });
      if(!response.ok)throw Object.assign(new Error(`Cartesia HTTP ${response.status}`),{code:`http_${response.status}`});
      if(!response.body)throw Object.assign(new Error('Cartesia response body is unavailable'),{code:'missing_response_body'});
      const reader=response.body.getReader(),decoder=new TextDecoder(),chunks=[];
      let total=0,buffer='',firstByte=true,doneEvent=false,apiError=null;
      const onEvent=event=>{
        if(event?.type==='error'){apiError=Object.assign(new Error(String(event.message||event.error_code||'Cartesia stream error')),{code:String(event.error_code||'cartesia_stream_error')});return}
        if(event?.type==='done'){doneEvent=true;return}
        if(event?.type!=='chunk'||!event.data)return;
        const pcm=Buffer.from(event.data,'base64');
        if(!pcm.length)return;
        if(chunks.length===0)onFirstAudio();
        chunks.push(pcm);total+=pcm.length;
        if(total>Number(config.maxBytes||16*1024*1024))apiError=Object.assign(new Error('Cartesia audio exceeded byte limit'),{code:'audio_too_large'});
      };
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        if(!value?.byteLength)continue;
        if(firstByte){firstByte=false;onFirstByte()}
        buffer=(buffer+decoder.decode(value,{stream:true})).replaceAll('\r\n','\n');
        buffer=decodeEvents(buffer,onEvent);
        if(apiError)throw apiError;
      }
      buffer=(buffer+decoder.decode()).replaceAll('\r\n','\n');
      decodeEvents(buffer+'\n\n',onEvent);
      if(apiError)throw apiError;
      if(!doneEvent)throw Object.assign(new Error('Cartesia stream ended without done event'),{code:'missing_done_event'});
      if(!chunks.length)throw Object.assign(new Error('Cartesia audio was empty'),{code:'empty_audio'});
      return {pcm:Buffer.concat(chunks,total),sampleRate:24_000,channels:1};
    }
  };
}
