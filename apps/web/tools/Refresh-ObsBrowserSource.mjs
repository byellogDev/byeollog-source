import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import WebSocket from 'ws';

const sourceName=process.argv[2]||'브라우저';
const appData=process.env.APPDATA;
if(!appData)throw new Error('APPDATA is unavailable');
const configPath=resolve(appData,'obs-studio/plugin_config/obs-websocket/config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
const port=Number(config.server_port||4455);
if(!config.server_enabled||!Number.isSafeInteger(port))throw new Error('OBS WebSocket is unavailable');

function digest(value){return createHash('sha256').update(value).digest('base64')}
const requestId=randomUUID();
const socket=new WebSocket(`ws://127.0.0.1:${port}`);
const response=await new Promise((resolvePromise,reject)=>{
  const timeout=setTimeout(()=>reject(new Error('OBS refresh request timed out')),10_000);
  socket.on('error',reject);
  socket.on('message',raw=>{
    const packet=JSON.parse(raw.toString('utf8'));
    if(packet.op===0){
      const authentication=packet.d?.authentication;
      const identify={rpcVersion:1,eventSubscriptions:0};
      if(authentication){
        const secret=digest(String(config.server_password||'')+authentication.salt);
        identify.authentication=digest(secret+authentication.challenge);
      }
      socket.send(JSON.stringify({op:1,d:identify}));
      return;
    }
    if(packet.op===2){
      socket.send(JSON.stringify({op:6,d:{requestType:'PressInputPropertiesButton',requestId,requestData:{inputName:sourceName,propertyName:'refreshnocache'}}}));
      return;
    }
    if(packet.op!==7||packet.d?.requestId!==requestId)return;
    clearTimeout(timeout);
    const status=packet.d?.requestStatus;
    if(!status?.result){reject(new Error(`OBS refresh failed (${status?.code||'unknown'})`));return}
    resolvePromise({sourceName,status:'refreshed'});
  });
}).finally(()=>socket.close());

console.log(JSON.stringify(response));
