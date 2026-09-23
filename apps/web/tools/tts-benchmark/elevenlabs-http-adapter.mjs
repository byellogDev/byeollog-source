function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(!value)throw new Error(`required environment variable is missing: ${name}`);
  return value;
}

export function createElevenLabsHttpAdapter(config,{environment=process.env,fetchImpl=fetch}={}){
  const apiKeyEnv=String(config.apiKeyEnv||'ELEVENLABS_API_KEY');
  const voiceId=String(config.voiceId||requiredEnv(config.voiceIdEnv||'ELEVENLABS_VOICE_ID',environment));
  const endpoint=new URL(`/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`,config.origin||'https://api.elevenlabs.io');
  endpoint.searchParams.set('output_format','pcm_24000');
  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      const response=await fetchImpl(endpoint,{
        method:'POST',signal,cache:'no-store',
        headers:{'xi-api-key':requiredEnv(apiKeyEnv,environment),'content-type':'application/json',accept:'audio/pcm'},
        body:JSON.stringify({
          text,
          model_id:config.modelId||'eleven_flash_v2_5',
          language_code:'ko',
          voice_settings:{stability:.5,similarity_boost:.75,style:0,use_speaker_boost:false,speed:Number(config.speed||1)}
        })
      });
      if(!response.ok)throw Object.assign(new Error(`ElevenLabs HTTP ${response.status}`),{code:`http_${response.status}`});
      if(!response.body)throw Object.assign(new Error('ElevenLabs response body is unavailable'),{code:'missing_response_body'});
      const reader=response.body.getReader(),chunks=[];
      let total=0,first=true;
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        if(!value?.byteLength)continue;
        if(first){first=false;onFirstByte();onFirstAudio()}
        const chunk=Buffer.from(value);chunks.push(chunk);total+=chunk.length;
        if(total>Number(config.maxBytes||16*1024*1024))throw Object.assign(new Error('ElevenLabs audio exceeded byte limit'),{code:'audio_too_large'});
      }
      if(first)throw Object.assign(new Error('ElevenLabs audio was empty'),{code:'empty_audio'});
      return {pcm:Buffer.concat(chunks,total),sampleRate:24_000,channels:1};
    }
  };
}
