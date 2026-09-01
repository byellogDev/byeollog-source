import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import WebSocket from 'ws';

const sourceName=process.argv[2]||'브라우저';
const outputPath=resolve(process.argv[3]||'artifacts/obs-wallpaper-source.png');
const appData=process.env.APPDATA;
if(!appData)throw new Error('APPDATA is unavailable');
const configPath=resolve(appData,'obs-studio/plugin_config/obs-websocket/config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
const port=Number(config.server_port||4455);
if(!config.server_enabled||!Number.isSafeInteger(port))throw new Error('OBS WebSocket is unavailable');

function digest(value){return createHash('sha256').update(value).digest('base64')}
function requestId(){return randomUUID()}

const socket=new WebSocket(`ws://127.0.0.1:${port}`);
const result=await new Promise((resolvePromise,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('OBS screenshot request timed out')),10_000);
  socket.on('error',reject);
  socket.on('message',raw=>{
    const packet=JSON.parse(raw.toString('utf8'));
    if(packet.op===0){
      const hello=packet.d||{};
      const authentication=hello.authentication;
      const identify={rpcVersion:1,eventSubscriptions:0};
      if(authentication){
        const secret=digest(String(config.server_password||'')+authentication.salt);
        identify.authentication=digest(secret+authentication.challenge);
      }
      socket.send(JSON.stringify({op:1,d:identify}));
      return;
    }
    if(packet.op===2){
      socket.send(JSON.stringify({
        op:6,
        d:{
          requestType:'GetSourceScreenshot',
          requestId:requestId(),
          requestData:{sourceName,imageFormat:'png',imageWidth:1920,imageHeight:1080,imageCompressionQuality:-1}
        }
      }));
      return;
    }
    if(packet.op!==7)return;
    clearTimeout(timeout);
    const status=packet.d?.requestStatus;
    if(!status?.result){reject(new Error(`OBS screenshot failed (${status?.code||'unknown'})`));return}
    resolvePromise(packet.d.responseData?.imageData);
  });
}).finally(()=>socket.close());

if(typeof result!=='string'||!result.startsWith('data:image/png;base64,')){
  throw new Error('OBS returned an invalid screenshot payload');
}
await mkdir(dirname(outputPath),{recursive:true});
await writeFile(outputPath,Buffer.from(result.slice('data:image/png;base64,'.length),'base64'));
console.log(JSON.stringify({sourceName,outputPath}));
