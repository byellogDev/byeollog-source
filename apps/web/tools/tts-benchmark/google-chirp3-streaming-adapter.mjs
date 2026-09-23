import textToSpeech from '@google-cloud/text-to-speech';

const {TextToSpeechClient}=textToSpeech;

function audioBuffer(value){
  if(Buffer.isBuffer(value))return value;
  if(value instanceof Uint8Array)return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  if(typeof value==='string')return Buffer.from(value,'base64');
  return Buffer.alloc(0);
}

export function createGoogleChirp3StreamingAdapter(config,{Client=TextToSpeechClient}={}){
  const voiceName=String(config.voiceName||'').trim();
  const languageCode=String(config.languageCode||'ko-KR').trim();
  const sampleRate=Number(config.sampleRate||24_000);
  const speakingRate=Number(config.speakingRate??1);
  if(!/^ko-KR-Chirp3-HD-[A-Za-z]+$/.test(voiceName))throw new Error('Google Chirp 3 HD voiceName이 올바르지 않습니다.');
  if(languageCode!=='ko-KR')throw new Error('Google 비교 측정은 ko-KR만 허용합니다.');
  if(!Number.isSafeInteger(sampleRate)||sampleRate<8_000||sampleRate>48_000)throw new Error('Google sampleRate가 올바르지 않습니다.');
  if(!Number.isFinite(speakingRate)||speakingRate<0.25||speakingRate>2)throw new Error('Google speakingRate가 올바르지 않습니다.');

  const clientOptions={};
  if(config.apiEndpoint)clientOptions.apiEndpoint=String(config.apiEndpoint);
  const client=new Client(clientOptions);

  return {
    async synthesize({text,signal,onFirstByte,onFirstAudio}){
      if(signal?.aborted)throw signal.reason||new Error('Google TTS 요청이 취소되었습니다.');
      return await new Promise((resolve,reject)=>{
        const chunks=[];
        let settled=false;
        let firstByteSeen=false;
        let firstAudioSeen=false;
        const stream=client.streamingSynthesize();

        const cleanup=()=>signal?.removeEventListener('abort',abort);
        const fail=error=>{
          if(settled)return;
          settled=true;
          cleanup();
          reject(error instanceof Error?error:new Error(String(error||'Google TTS streaming error')));
        };
        const abort=()=>{
          const reason=signal?.reason||new Error('Google TTS 요청이 취소되었습니다.');
          if(typeof stream.cancel==='function')stream.cancel();
          else if(typeof stream.destroy==='function')stream.destroy(reason);
          fail(reason);
        };

        signal?.addEventListener('abort',abort,{once:true});
        stream.on('data',response=>{
          if(!firstByteSeen){firstByteSeen=true;onFirstByte?.()}
          const chunk=audioBuffer(response?.audioContent);
          if(!chunk.length)return;
          if(!firstAudioSeen){firstAudioSeen=true;onFirstAudio?.()}
          chunks.push(chunk);
        });
        stream.once('error',fail);
        stream.once('end',()=>{
          if(settled)return;
          if(!chunks.length){fail(new Error('Google TTS가 재생 가능한 PCM을 반환하지 않았습니다.'));return}
          settled=true;
          cleanup();
          resolve({pcm:Buffer.concat(chunks),sampleRate,channels:1});
        });

        stream.write({
          streamingConfig:{
            voice:{name:voiceName,languageCode},
            streamingAudioConfig:{audioEncoding:'PCM',sampleRateHertz:sampleRate,speakingRate}
          }
        });
        stream.write({input:{text:String(text)}});
        stream.end();
      });
    },
    async close(){await client.close?.()}
  };
}
