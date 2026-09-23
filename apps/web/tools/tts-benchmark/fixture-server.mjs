import http from 'node:http';

function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

function makePcm(text,{sampleRate,channels}){
  const durationMs=Math.max(260,Math.min(1_800,220+String(text).length*34));
  const frames=Math.round(sampleRate*durationMs/1000),pcm=Buffer.alloc(frames*channels*2);
  const frequency=220+(String(text).length%8)*28;
  for(let frame=0;frame<frames;frame++){
    const envelope=Math.min(1,frame/(sampleRate*.015),(frames-frame)/(sampleRate*.03));
    const sample=Math.round(Math.sin(frame/sampleRate*Math.PI*2*frequency)*8_500*envelope);
    for(let channel=0;channel<channels;channel++)pcm.writeInt16LE(sample,(frame*channels+channel)*2);
  }
  return pcm;
}

async function bodyJson(request){
  const chunks=[];let bytes=0;
  for await(const chunk of request){bytes+=chunk.length;if(bytes>32_768)throw new Error('request too large');chunks.push(chunk)}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createFixtureTtsServer({firstAudioDelayMs=35,chunkIntervalMs=4,sampleRate=24_000,channels=1}={}){
  return http.createServer(async(request,response)=>{
    try{
      const url=new URL(request.url,'http://127.0.0.1');
      if(request.method==='GET'&&url.pathname==='/healthz'){
        response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({healthy:true,version:'tts-benchmark-fixture-v1'}));return;
      }
      if(request.method!=='POST'||url.pathname!=='/v1/tts'){
        response.writeHead(404,{'content-type':'application/json'}).end('{"error":"not_found"}');return;
      }
      const body=await bodyJson(request),text=String(body.text||'').trim();
      if(!text){response.writeHead(400,{'content-type':'application/json'}).end('{"error":"text_required"}');return}
      if(text==='__fixture_error__'){response.writeHead(503,{'content-type':'application/json'}).end('{"error":"fixture_error"}');return}
      const pcm=makePcm(text,{sampleRate,channels});
      response.writeHead(200,{
        'content-type':'audio/L16','x-audio-sample-rate':String(sampleRate),'x-audio-channels':String(channels),
        'cache-control':'no-store','transfer-encoding':'chunked'
      });
      await wait(firstAudioDelayMs);
      const chunkBytes=Math.max(2,Math.floor(sampleRate*channels*2*.02));
      for(let offset=0;offset<pcm.length;offset+=chunkBytes){response.write(pcm.subarray(offset,offset+chunkBytes));await wait(chunkIntervalMs)}
      response.end();
    }catch(error){
      if(!response.headersSent)response.writeHead(500,{'content-type':'application/json'});
      response.end(JSON.stringify({error:String(error?.message||error).slice(0,120)}));
    }
  });
}

export async function listenFixture(options={}){
  const server=createFixtureTtsServer(options);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
  const address=server.address();
  return {server,origin:`http://127.0.0.1:${address.port}`,close:()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
