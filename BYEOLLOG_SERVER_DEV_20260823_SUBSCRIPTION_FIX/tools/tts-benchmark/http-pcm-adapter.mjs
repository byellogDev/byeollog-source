function requiredEnv(name,environment){
  const value=String(environment?.[name]||'').trim();
  if(!value)throw new Error(`required environment variable is missing: ${name}`);
  return value;
}

function headersFor(config,environment){
  const headers={'content-type':'application/json',accept:'audio/L16',...(config.headers||{})};
  for(const [headerName,spec] of Object.entries(config.headersFromEnv||{})){
    const envName=typeof spec==='string'?spec:spec.env;
    const prefix=typeof spec==='string'?'':String(spec.prefix||'');
    headers[headerName]=prefix+requiredEnv(envName,environment);
  }
  return headers;
}

export function createHttpPcmAdapter(config,{environment=process.env,fetchImpl=fetch}={}){
  const endpoint=new URL(config.endpoint);
  const sampleRate=Number(config.sampleRate||24_000),channels=Number(config.channels||1);
  return {
    async synthesize({text,caseId,signal,onFirstByte,onFirstAudio}){
      const body={...(config.body||{}),[config.textField||'text']:text};
      if(config.caseIdField)body[config.caseIdField]=caseId;
      const response=await fetchImpl(endpoint,{
        method:config.method||'POST',headers:headersFor(config,environment),body:JSON.stringify(body),signal,cache:'no-store'
      });
      if(!response.ok)throw Object.assign(new Error(`TTS HTTP ${response.status}`),{code:`http_${response.status}`});
      const responseType=String(response.headers.get('content-type')||'').toLowerCase();
      if(!responseType.includes('audio/l16')&&!responseType.includes('audio/pcm')&&!responseType.includes('application/octet-stream')){
        throw Object.assign(new Error(`unexpected PCM content type: ${responseType||'missing'}`),{code:'unexpected_content_type'});
      }
      if(!response.body)throw Object.assign(new Error('streaming response body is unavailable'),{code:'missing_response_body'});
      const reader=response.body.getReader(),chunks=[];
      let total=0,first=true;
      while(true){
        const {done,value}=await reader.read();
        if(done)break;
        if(!value?.byteLength)continue;
        if(first){first=false;onFirstByte();onFirstAudio()}
        const chunk=Buffer.from(value);
        chunks.push(chunk);total+=chunk.length;
        if(total>Number(config.maxBytes||16*1024*1024))throw Object.assign(new Error('audio response exceeded byte limit'),{code:'audio_too_large'});
      }
      if(first)throw Object.assign(new Error('audio response was empty'),{code:'empty_audio'});
      return {pcm:Buffer.concat(chunks,total),sampleRate,channels};
    }
  };
}
