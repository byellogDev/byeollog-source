import {wavPcm16le} from './core.mjs';

function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(!value)throw new Error(`required environment variable is missing: ${name}`);
  return value;
}
function decodeJsonObjects(buffer,onObject){
  let start=-1,depth=0,inString=false,escaped=false,lastConsumed=0;
  for(let index=0;index<buffer.length;index++){
    const character=buffer[index];
    if(start<0){
      if(character==='{'){start=index;depth=1}
      else if(!/\s/.test(character))throw Object.assign(new Error('Inworld stream contained invalid framing'),{code:'invalid_stream_framing'});
      continue;
    }
    if(inString){
      if(escaped)escaped=false;
      else if(character==='\\')escaped=true;
      else if(character==='"')inString=false;
      continue;
    }
    if(character==='"'){inString=true;continue}
    if(character==='{')depth++;
    else if(character==='}'){
      depth--;
      if(depth===0){
        onObject(JSON.parse(buffer.slice(start,index+1)));
        lastConsumed=index+1;start=-1;
      }
    }
  }
  return buffer.slice(lastConsumed);
}

export function createInworldHttpStreamAdapter(config,{environment=process.env,fetchImpl=fetch}={}){
  const apiKeyEnv=String(config.apiKeyEnv||'INWORLD_API_KEY');
  const voice=String(config.voiceId||requiredEnv(config.voiceIdEnv||'INWORLD_VOICE_ID',environment));
  const endpoint=new URL(config.endpoint||'https://api.inworld.ai/tts/v1/voice:stream');
  const sampleRate=Number(config.sampleRate||24_000);
  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      const response=await fetchImpl(endpoint,{
        method:'POST',signal,cache:'no-store',
        headers:{authorization:`Basic ${requiredEnv(apiKeyEnv,environment)}`,'content-type':'application/json',accept:'application/json'},
        body:JSON.stringify({
          text,voiceId:voice,modelId:config.modelId||'inworld-tts-2-flash',
          audioConfig:{audioEncoding:'LINEAR16',sampleRateHertz:sampleRate},
          language:config.language||'ko-KR',applyTextNormalization:config.applyTextNormalization||'OFF'
        })
      });
      if(!response.ok)throw Object.assign(new Error(`Inworld HTTP ${response.status}`),{code:`http_${response.status}`});
      if(!response.body)throw Object.assign(new Error('Inworld response body is unavailable'),{code:'missing_response_body'});
      const reader=response.body.getReader(),decoder=new TextDecoder(),chunks=[];
      let total=0,buffer='',firstByte=true,apiError=null,actualSampleRate=null,actualChannels=null;
      const onObject=event=>{
        if(event?.error){
          const message=event.error.message||event.error.details||'Inworld stream error';
          apiError=Object.assign(new Error(String(message)),{code:String(event.error.code||'inworld_stream_error')});return;
        }
        const encoded=event?.result?.audioContent;
        if(!encoded)return;
        const wave=wavPcm16le(Buffer.from(encoded,'base64'));
        if(actualSampleRate===null){actualSampleRate=wave.sampleRate;actualChannels=wave.channels}
        if(wave.sampleRate!==actualSampleRate||wave.channels!==actualChannels){
          apiError=Object.assign(new Error('Inworld changed PCM format during one stream'),{code:'inconsistent_audio_format'});return;
        }
        if(chunks.length===0)onFirstAudio();
        chunks.push(wave.pcm);total+=wave.pcm.length;
        if(total>Number(config.maxBytes||16*1024*1024))apiError=Object.assign(new Error('Inworld audio exceeded byte limit'),{code:'audio_too_large'});
      };
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        if(!value?.byteLength)continue;
        if(firstByte){firstByte=false;onFirstByte()}
        buffer+=decoder.decode(value,{stream:true});
        buffer=decodeJsonObjects(buffer,onObject);
        if(apiError)throw apiError;
      }
      buffer+=decoder.decode();
      buffer=decodeJsonObjects(buffer,onObject);
      if(apiError)throw apiError;
      if(buffer.trim())throw Object.assign(new Error('Inworld stream ended with incomplete JSON'),{code:'incomplete_stream'});
      if(!chunks.length)throw Object.assign(new Error('Inworld audio was empty'),{code:'empty_audio'});
      return {pcm:Buffer.concat(chunks,total),sampleRate:actualSampleRate,channels:actualChannels};
    }
  };
}
