import {createHash} from 'node:crypto';
import {wavPcm16le} from './core.mjs';

function voiceKey(text){
  return createHash('sha256').update(`raffle-winner-voice-v1|${text}`,'utf8').digest('hex');
}

function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(value.length<43)throw new Error(`required secret environment variable is missing: ${name}`);
  return value;
}

export function createByeollogCosyWavAdapter(config,{environment=process.env,fetchImpl=fetch}={}){
  const endpoint=new URL(config.endpoint),secretEnv=String(config.secretEnv||'BYEOLLOG_TTS_SHARED_SECRET');
  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      const key=voiceKey(text),secret=requiredEnv(secretEnv,environment);
      const response=await fetchImpl(endpoint,{
        method:'POST',
        headers:{authorization:`Bearer ${secret}`,'content-type':'application/json',accept:'audio/wav'},
        body:JSON.stringify({actorName:text,voiceKey:key}),signal,cache:'no-store'
      });
      if(!response.ok)throw Object.assign(new Error(`CosyVoice HTTP ${response.status}`),{code:`http_${response.status}`});
      const responseType=String(response.headers.get('content-type')||'').toLowerCase();
      if(!responseType.includes('audio/wav')&&!responseType.includes('audio/x-wav')){
        throw Object.assign(new Error(`unexpected WAV content type: ${responseType||'missing'}`),{code:'unexpected_content_type'});
      }
      if(!response.body)throw Object.assign(new Error('WAV response body is unavailable'),{code:'missing_response_body'});
      const reader=response.body.getReader(),chunks=[];
      let total=0,first=true;
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        if(!value?.byteLength)continue;
        if(first){first=false;onFirstByte();onFirstAudio()}
        const chunk=Buffer.from(value);chunks.push(chunk);total+=chunk.length;
        if(total>Number(config.maxBytes||2*1024*1024))throw Object.assign(new Error('WAV response exceeded byte limit'),{code:'audio_too_large'});
      }
      if(first)throw Object.assign(new Error('WAV response was empty'),{code:'empty_audio'});
      const wav=Buffer.concat(chunks,total),digest=createHash('sha256').update(wav).digest('hex');
      if(response.headers.get('x-byeollog-voice-key')!==key)throw Object.assign(new Error('voice key response mismatch'),{code:'voice_key_mismatch'});
      if(response.headers.get('x-byeollog-audio-sha256')!==digest)throw Object.assign(new Error('audio digest response mismatch'),{code:'audio_digest_mismatch'});
      return wavPcm16le(wav);
    }
  };
}
