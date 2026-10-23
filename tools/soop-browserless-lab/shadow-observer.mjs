// Candidate only. Supply credentials over stdin to an isolated, bounded process.
// Does not import gateway ingress, outbox, DB, token refresh or production state.
import vm from 'node:vm';
import {createHash,createHmac} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export const SDK_SHA='4d6974d882013e4cae2797010668855d3c2aeb0d2a8f711b08f65578c118a016';
export function assertObserverPacket(data){
  const b=Buffer.from(data);
  if(b.length<14||b.length>65536||b[0]!==27||b[1]!==9||![0,2,16].includes(Number(b.subarray(2,6).toString())))throw Error('outbound_packet_blocked');
}
export function assertObserverSocket(value,owner){
  const u=new URL(value);
  if(u.protocol!=='wss:'||!/^chat-[a-f0-9]{8}\.sooplive\.com$/i.test(u.hostname)||u.pathname!==`/Websocket/${owner}`||u.username||u.password||u.search||u.hash)throw Error('socket_destination_blocked');
}
export function observerDuration(requested,ceiling=120000){
  if(!Number.isFinite(ceiling)||ceiling<1000||ceiling>172800000)throw Error('invalid_duration_ceiling');
  return Math.min(ceiling,Math.max(1000,Number(requested)||60000));
}
export async function observe(config,{fetchImpl=fetch,WebSocketImpl=WebSocket,onReport=()=>{},maxDurationMs=120000,signal}={}){
  if(createHash('sha256').update(config.sdkSource||'').digest('hex')!==SDK_SHA)throw Error('sdk_hash_mismatch');
  if(!/^[a-z0-9_.-]{2,80}$/.test(config.broadcasterId||'')||String(config.salt||'').length<32)throw Error('invalid_observer_config');
  const duration=observerDuration(config.durationMs,maxDurationMs);
  const sockets=new Set(),intervals=new Set(),timeouts=new Set();
  const report={ready:false,events:0,counts:{},samples:[],reason:null,externalSocketAttempts:0,wireFrames:0,transport:{httpStatus:null,socketOpened:false,sentCodes:[],receivedHeaders:[],socketErrors:0,closeCode:null}};
  let sdk,finished=false,resolveDone;
  const done=new Promise(r=>resolveDone=r);
  function finish(reason){if(finished)return;finished=true;report.reason=reason;resolveDone()}
  const abort=()=>finish('supervisor_stopped');
  signal?.addEventListener('abort',abort,{once:true});
  const guard=fn=>(...args)=>{if(finished)return;try{return fn(...args)}catch{finish('sdk_callback_failed')}};
  const timer=(repeat)=>(fn,ms,...args)=>{const set=repeat?intervals:timeouts;const h=(repeat?setInterval:setTimeout)(guard(()=>{if(!repeat)set.delete(h);fn(...args)}),ms);set.add(h);return h};
  const clear=h=>{clearInterval(h);clearTimeout(h);intervals.delete(h);timeouts.delete(h)};
  const module={exports:{}};
  const context=vm.createContext({module,exports:module.exports,URL,URLSearchParams,TextEncoder,TextDecoder,
    console:{log(){},info(){},warn(){},error(){},debug(){}},setInterval:timer(true),clearInterval:clear,setTimeout:timer(false),clearTimeout:clear,
    fetch:async(target,opts)=>{
      if(finished)throw Error('observer_finished');
      if(target!=='https://openapi.sooplive.com/broad/access/chatinfo'||opts?.method!=='POST'||new URLSearchParams(opts.body).get('access_token')!==config.accessToken){finish('http_destination_blocked');throw Error('http_destination_blocked')}
      const r=await fetchImpl(target,{...opts,redirect:'error',signal:AbortSignal.timeout(10000)});
      report.transport.httpStatus=r.status;
      if(!r.ok){finish(`chatinfo_http_${r.status}`);throw Error('chatinfo_http_failed')}
      const payload=await r.json();
      if(payload.result>0&&(!Array.isArray(payload.data)||payload.data.length!==1||payload.data[0].id!==config.broadcasterId)){finish('chatinfo_owner_mismatch');throw Error('chatinfo_owner_mismatch')}
      return {status:r.status,statusText:r.statusText,json:async()=>payload};
    },
    WebSocket:class extends WebSocketImpl{
      constructor(url,protocol){
        if(finished||sockets.size)throw Error('observer_single_connection_only');
        assertObserverSocket(url,config.broadcasterId);
        if(protocol!=='chat')throw Error('socket_protocol_blocked');
        super(url,protocol);report.externalSocketAttempts++;sockets.add(this);
        this.addEventListener('open',()=>{report.transport.socketOpened=true});
        this.addEventListener('error',()=>{report.transport.socketErrors++});
        this.addEventListener('close',event=>{report.transport.closeCode=event.code});
        this.addEventListener('close',()=>sockets.delete(this));
        this.addEventListener('message',event=>{
          try{
            const bytes=Buffer.from(event.data),code=Number(bytes.subarray(2,6).toString());
            if(report.transport.receivedHeaders.length<20)report.transport.receivedHeaders.push({code,retCode:bytes.subarray(12,14).toString(),bytes:bytes.length});
            if([5,18,33,86,108,117].includes(code)){
              report.wireFrames++;
              onReport({kind:'frame',code,at:Date.now(),digest:createHmac('sha256',config.salt).update(bytes).digest('hex')});
            }
          }catch{finish('wire_observation_failed')}
        });
      }
      send(data){try{assertObserverPacket(data)}catch(e){finish('outbound_packet_blocked');throw e}if(report.transport.sentCodes.length<20)report.transport.sentCodes.push(Number(Buffer.from(data).subarray(2,6).toString()));return super.send(data)}
    }
  });
  const deadline=setTimeout(()=>finish('duration_reached'),duration);
  const readyDeadline=setTimeout(()=>{if(!report.ready)finish('ready_timeout')},10000);
  const telemetry=setInterval(()=>{
    if(finished)return;
    try{if(report.ready&&sdk.getRoomInfo().bjId!==config.broadcasterId){finish('room_owner_mismatch');return}
      onReport({kind:'telemetry',at:Date.now(),ready:report.ready,events:report.events,counts:{...report.counts},rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,cpu:process.cpuUsage(),sockets:sockets.size,timers:intervals.size+timeouts.size});
    }catch{finish('telemetry_failed')}
  },15000);
  try{
    if(signal?.aborted){finish('supervisor_stopped');return report}
    new vm.Script(config.sdkSource).runInContext(context,{timeout:1500});
    sdk=new module.exports(config.clientId,config.clientSecret);
    sdk.handleReady(guard(()=>{
      const room=sdk.getRoomInfo();if(room.bjId!==config.broadcasterId||!Number(room.chatNumber)){finish('room_owner_mismatch');return}
      report.ready=true;clearTimeout(readyDeadline);onReport({kind:'ready'});
    }));
    sdk.handleError(()=>finish('sdk_error'));
    sdk.handleChatClosed(()=>finish('socket_closed'));
    sdk.handleMessageReceived(guard((action,message)=>{
      const room=sdk.getRoomInfo();if(room.bjId!==config.broadcasterId){finish('room_owner_mismatch');return}
      const type=/^[A-Z_]{1,50}$/.test(action)?action:'UNKNOWN';
      report.events++;report.counts[type]=(report.counts[type]||0)+1;
      // No user identifier, message, donation amount or credentials are logged.
      // This bounded digest alone is NOT a comparison against the operating path.
      if(report.samples.length<200){
        const value=JSON.stringify({action:type,userId:message?.userId||'',count:message?.count??null,message:message?.message||''});
        report.samples.push({action:type,at:Date.now(),digest:createHmac('sha256',config.salt).update(value).digest('hex')});
      }
    }));
    sdk.setAuth(config.accessToken);
    void Promise.resolve().then(()=>sdk.connect()).catch(()=>finish('connect_failed'));
    await done;
  }finally{
    finished=true;clearTimeout(deadline);clearTimeout(readyDeadline);clearInterval(telemetry);signal?.removeEventListener('abort',abort);
    try{sdk?.disconnect()}catch{}
    for(const socket of sockets){socket.onclose=null;socket.onerror=null;socket.onmessage=null;try{socket.close()}catch{}}
    for(const h of [...intervals,...timeouts])clear(h);
  }
  return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  let input='';
  try{
    for await(const part of process.stdin){input+=part;if(input.length>200000)throw Error('input_too_large')}
    const result=await observe(JSON.parse(input),{onReport:event=>console.log(JSON.stringify(event))});
    console.log(JSON.stringify({kind:'result',...result}));process.exit(0);
  }catch{console.log(JSON.stringify({kind:'result',ready:false,reason:'observer_failed'}));process.exit(1)}
}
