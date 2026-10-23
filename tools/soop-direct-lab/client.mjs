import {fault,decodePackets,encodePacket,loginPacket,joinPacket,contentEvent,MAX_PACKET_BYTES,packetDiagnostic} from './protocol.mjs';
import {normalizeSoopRoomOwner} from '../../services/soop-gateway/lib/soop-room-identity.js';
const CHATINFO='https://openapi.sooplive.com/broad/access/chatinfo';
export async function loadRoom(config,{fetchImpl=fetch,signal}={}){
  if(!/^[a-z0-9_.-]{2,80}$/.test(config.broadcasterId||'')||typeof config.accessToken!=='string'||!config.accessToken.length||config.accessToken.length>8192||/[\x00-\x20\x7f]/.test(config.accessToken))throw fault('invalid_auth_config');
  const response=await fetchImpl(CHATINFO,{method:'POST',redirect:'error',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=utf-8;'},body:new URLSearchParams({access_token:config.accessToken}).toString(),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)});
  if(!response.ok)throw fault(response.status===401||response.status===403?'auth_rejected':response.status===429?'auth_rate_limited':'chatinfo_http_failed');
  const reader=response.body.getReader();let chunks=[],size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>65536)throw fault('chatinfo_too_large');chunks.push(value)}}finally{await reader.cancel().catch(()=>{})}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw fault('invalid_chatinfo')}
  if(!(Number(result.result)>0))throw fault(Number(result.result)===-1302?'broadcast_offline':'chatinfo_provider_rejected');
  if(!Array.isArray(result.data)||result.data.length!==1||result.data[0].id!==config.broadcasterId)throw fault('chatinfo_owner_mismatch');
  const r=result.data[0],ip=String(r.chat_ip||'').split('.');
  if(ip.length!==4||ip.some(x=>!/^\d{1,3}$/.test(x)||Number(x)>255))throw fault('invalid_chat_address');
  const port=Number(r.chat_port)+1,chatNumber=Number(r.chat_no);
  if(!Number.isSafeInteger(port)||port<1||port>65535||!Number.isSafeInteger(chatNumber)||chatNumber<1||typeof r.key!=='string'||!r.key.length||r.key.length>8192||/[\x00-\x20\x7f]/.test(r.key))throw fault('invalid_chatinfo');
  const host='chat-'+ip.map(x=>Number(x).toString(16).padStart(2,'0')).join('')+'.sooplive.com';
  return {broadcasterId:config.broadcasterId,chatNumber,ticket:r.key,url:`wss://${host}:${port}/Websocket/${config.broadcasterId}`};
}

// One connection per invocation. Reconnect decisions belong to the external
// supervisor; no SDK globals, credential files, DB clients or automatic retries.
export async function runDirect(config,{WebSocketImpl,fetchImpl=fetch,signal,onEvent=()=>{},onFrame=()=>{},onReport=()=>{},timing={}}={}){
  const limits={joinMs:10000,pingMs:60000,idleMs:180000,writeMs:10000,telemetryMs:15000,...timing};
  const duration=Number(config.durationMs||120000);
  if(!Number.isFinite(duration)||duration<100||duration>172800000)throw fault('invalid_duration');
  for(const v of Object.values(limits))if(!Number.isFinite(v)||v<10||v>180000)throw fault('invalid_timing');
  const result={ready:false,reason:null,counts:{},transport:{socketErrors:0,closeCode:null,writesCompleted:0},unknownCodes:{}};
  const started=Date.now();let readyAt=null;
  let socket,stage='auth',finished=false,resolveDone,lastWire=started,sequence=0;
  Object.assign(result.transport,{receivedFrames:0,lastPacketCode:null,closeReasonBytes:0});
  const timers=new Set(),done=new Promise(r=>resolveDone=r);
  const finish=code=>{if(finished)return;finished=true;result.reason=code;result.stage=stage;Object.assign(result.transport,{elapsedMs:Date.now()-started,connectedMs:readyAt===null?null:Date.now()-readyAt,lastWireAgeMs:Date.now()-lastWire});resolveDone()};
  const every=(fn,ms)=>{const h=setInterval(fn,ms);timers.add(h);return h};
  const deadline=(fn,ms)=>{const h=setTimeout(fn,ms);timers.add(h);return h};
  const abort=()=>finish('supervisor_stopped');signal?.addEventListener('abort',abort,{once:true});
  const safe=fn=>(...args)=>{if(finished)return;try{fn(...args)}catch(e){finish(e?.code||'callback_failed')}};
  const send=packet=>{
    if(finished)return;
    if(socket?.readyState!==1){finish('socket_not_open');return}
    if(socket.bufferedAmount>MAX_PACKET_BYTES*4){finish('write_backpressure');return}
    const timeout=deadline(()=>finish('write_timeout'),limits.writeMs);
    try{socket.send(packet,error=>{
      clearTimeout(timeout);timers.delete(timeout);
      if(finished)return;
      if(error){finish('write_failed');return}
      result.transport.writesCompleted++;
    })}catch{clearTimeout(timeout);timers.delete(timeout);finish('write_failed')}
  };
  try{
    if(signal?.aborted){finish('supervisor_stopped');return result}
    deadline(()=>finish('duration_reached'),duration);
    const room=await loadRoom(config,{fetchImpl,signal});
    if(finished)return result;
    const join=joinPacket(room,config.clientId,config.clientSecret);
    stage='connecting';
    socket=new WebSocketImpl(room.url,'chat',{maxPayload:MAX_PACKET_BYTES,perMessageDeflate:false,followRedirects:false,handshakeTimeout:limits.joinMs});
    const readyTimeout=deadline(()=>finish('ready_timeout'),limits.joinMs);
    socket.on('error',()=>{result.transport.socketErrors++;finish('socket_error')});
    socket.on('close',(code,reason)=>{if(finished)return;result.transport.closeCode=code;result.transport.closeReasonBytes=reason?.length||0;finish('socket_closed')});
    socket.on('open',safe(()=>{stage='login';lastWire=Date.now();send(loginPacket(config.accessToken))}));
    socket.on('message',safe(data=>{
      lastWire=Date.now();result.transport.receivedFrames++;
      let packets;try{packets=decodePackets(data)}catch(e){onReport({kind:'candidate_decode_error',code:e.code, ...e.diagnostic});throw e}
      for(const packet of packets){
        if(finished)break;
        const {code,ret,fields}=packet;result.transport.lastPacketCode=code;
        if(code===88){
          if(!result.ready||ret!==0)throw fault('invalid_broadcast_close');
          onReport({kind:'broadcast_signal',...packetDiagnostic(packet.bytes)});finish('broadcast_closed');break;
        }
        if(code===3){finish('room_evicted');break}
        if(code===1){
          if(stage!=='login')throw fault('unexpected_login_ack');
          if(ret!==0)throw fault('login_rejected');
          stage='join';send(join);continue;
        }
        if(code===2){
          if(stage!=='join')throw fault('unexpected_join_ack');
          if(ret!==0)throw fault('join_rejected');
          if(normalizeSoopRoomOwner(fields[1])!==room.broadcasterId||Number(fields[0])!==room.chatNumber)throw fault('join_owner_mismatch');
          stage='receiving';result.ready=true;readyAt=Date.now();clearTimeout(readyTimeout);
          onReport({kind:'ready',chatNumber:room.chatNumber});continue;
        }
        if(!result.ready)throw fault('content_before_ready');
        let event;try{event=contentEvent(packet,room);onFrame(packet)}catch(e){onReport({kind:'candidate_decode_error',code:e.code,...packetDiagnostic(packet.bytes)});throw e}
        if(event){sequence++;result.counts[event.action]=(result.counts[event.action]||0)+1;onEvent({...event,room:{bjId:room.broadcasterId,chatNumber:room.chatNumber},sequence,receivedAt:new Date().toISOString()})}
        else if(!(code in result.unknownCodes)&&Object.keys(result.unknownCodes).length>=128)throw fault('unknown_code_capacity');
        else result.unknownCodes[code]=(result.unknownCodes[code]||0)+1;
      }
    }));
    // Match the SDK's application keepalive. Neither this write's completion
    // nor a quiet room proves peer health. The supervisor compares both feeds.
    // Do not require a WebSocket pong response that this provider may not send.
    every(safe(()=>{if(result.ready)send(encodePacket(0))}),limits.pingMs);

    every(safe(()=>onReport({kind:'telemetry',ready:result.ready,events:sequence,counts:{...result.counts},rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,cpu:process.cpuUsage(),sockets:socket?.readyState===1?1:0,timers:timers.size,stage,lastWireAgeMs:Date.now()-lastWire,receiveState:!result.ready?'not_ready':Date.now()-lastWire>limits.idleMs?'idle_unconfirmed':'receiving',writesCompleted:result.transport.writesCompleted})),limits.telemetryMs);
    await done;
  }catch(error){finish(error?.code||'connection_failed')}
  finally{
    finished=true;for(const h of timers){clearTimeout(h);clearInterval(h)}signal?.removeEventListener('abort',abort);
    if(socket&&socket.readyState!==3){
      await new Promise(resolve=>{const kill=setTimeout(()=>{socket.terminate();resolve()},500);socket.once('close',()=>{clearTimeout(kill);resolve()});if(socket.readyState===1)socket.close();else socket.terminate()});
    }
  }
  return result;
}
