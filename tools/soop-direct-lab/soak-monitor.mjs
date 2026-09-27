import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import {once} from 'node:events';
import {signSoopGatewayRequest} from '/app/lib/soop-chat-gateway.js';
import {cdpClient} from '/app/services/soop-chat-gateway/cdp-client.mjs';
// protocol.mjs and cdp-frames.mjs are prepended by the research bundle builder.
const input=readline.createInterface({input:process.stdin});
let contact=Date.now();input.on('line',()=>contact=Date.now());
const [first]=await once(input,'line');const config=JSON.parse(first);
const {workspaceId,salt}=config,tag=crypto.createHash('sha256').update(workspaceId).digest('hex').slice(0,12);
const out=x=>console.log(JSON.stringify(x));let selected=null,ended=false;
const state=()=>{const s=JSON.parse(fs.readFileSync('/var/lib/byeollog/worker-state.json','utf8'));return {channel:s.channels.find(c=>c.workspace===tag),heartbeatAt:s.heartbeatAt,pending:s.queue.pending,deadLetters:s.queue.deadLetters}};
const halt=reason=>{if(!ended){ended=true;out({kind:'abort',reason});process.exitCode=1}};
input.on('close',()=>halt('supervisor_disconnected'));
const hardStop=setTimeout(()=>{halt('monitor_deadline');process.exit(1)},Math.min(172800000,Number(config.durationMs)||60000)+60000);
try{
  const before=state();if(before.channel?.state!=='connected'||Date.now()-Date.parse(before.heartbeatAt)>30000)throw Error('original_not_ready');
  // Never attach a second connection during an unstable original startup.
  for(let i=0;i<3;i++){await new Promise(r=>setTimeout(r,10000));const s=state();if(ended||Date.now()-contact>30000)throw Error('supervisor_disconnected');if(s.channel?.state!=='connected'||Date.now()-Date.parse(s.heartbeatAt)>30000)throw Error('original_not_ready')}
  const body={kind:'observe',workspaceId,instanceId:'isolated-coexist-observer'},timestamp=String(Date.now()),nonce=crypto.randomBytes(16).toString('hex');
  const signature=signSoopGatewayRequest({secret:process.env.SOOP_GATEWAY_INGRESS_SECRET,timestamp,nonce,body});
  const url=process.env.BYEOLLOG_SOOP_GATEWAY_URL||'https://byeollog.com/api/auth/soop/gateway';
  if(new URL(url).origin!=='https://byeollog.com')throw Error('unexpected_gateway');
  const response=await fetch(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','X-Byeollog-Soop-Gateway-Timestamp':timestamp,'X-Byeollog-Soop-Gateway-Nonce':nonce,'X-Byeollog-Soop-Gateway-Signature':signature},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
  const lease=await response.json();
  if(response.status===409&&lease.code==='soop_observation_token_wait')throw Error('observation_token_wait');
  if(!response.ok||lease.kind!=='observe'||lease.refreshed||lease.leaseToken||lease.workspaceId!==workspaceId)throw Error('observation_credentials_unavailable');
  let port;
  for(const pid of fs.readdirSync('/proc').filter(x=>/^\d+$/.test(x))){try{const s=fs.readFileSync(`/proc/${pid}/cmdline`,'utf8');const m=s.includes('chromium')&&s.match(/--remote-debugging-port=(\d+)/);if(m){port=Number(m[1]);break}}catch{}}
  if(!port)throw Error('debug_port_missing');
  const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const expression=`(()=>{if(typeof chats==='undefined'||chats.size!==1)return false;return [...chats.values()].every(s=>{try{return s.isReady()&&s.getRoomInfo().bjId===${JSON.stringify(lease.providerAccountId)}}catch{return false}})})()`;
  for(const target of targets.filter(t=>t.type==='page')){
    let attached=false;const scope=createSocketScope(lease.providerAccountId);const client=cdpClient(target.webSocketDebuggerUrl,event=>{
      if(!attached||ended)return;
      if(event.method==='Inspector.detached'){halt('original_observer_disconnected');return}
      if(!['Network.webSocketCreated','Network.webSocketFrameReceived','Network.webSocketClosed','Network.webSocketFrameError','Network.webSocketFrameSent'].includes(event.method))return;
      try{if(!scope.accept(event))return}catch(e){halt(e.message);return}
      if(event.method==='Network.webSocketClosed'){halt('original_socket_closed');return}
      if(event.method==='Network.webSocketFrameError'){halt('original_socket_error');return}
      if(event.method==='Network.webSocketFrameReceived'){
        const decoded=readCdpPackets(event.params?.response);
        if(decoded.error){out({kind:'original_decode_error',...decoded.error});halt('original_packet_decode_failed');return}
        for(const p of decoded.packets){
          if(p.code===88&&p.ret===0){out({kind:'broadcast_signal',...packetDiagnostic(p.bytes)});halt('original_broadcast_closed');break}
          if(CONTENT_CODES.includes(p.code))out({kind:'frame',code:p.code,at:Date.now(),digest:crypto.createHmac('sha256',salt).update(p.bytes).digest('hex')});
        }
      }
    },()=>{if(attached&&!ended)halt('original_observer_disconnected')});
    const result=await client.send('Runtime.evaluate',{expression,returnByValue:true});
    if(result.result?.value===true){
      selected=client;attached=true;await client.send('Network.enable');
      scope.authorize(await inspectSocketInventory(client,lease.providerAccountId));
      if(ended)throw Error('original_not_ready');
      out({kind:'socket_scope',verified:true});break;
    }
    client.close();
  }
  if(!selected)throw Error('original_target_not_found');
  const expiry=Date.parse(lease.providerTokenExpiresAt||'');
  const durationMs=Math.min(Number(config.durationMs),expiry-Date.now()-60000);
  if(!Number.isFinite(durationMs))throw Error('provider_expiry_invalid');
  if(durationMs<60000)throw Error('observation_token_wait');
  // Sensitive fields are consumed only by the remote controller pipe, never logged.
  out({kind:'private_config',config:{clientId:lease.clientId,clientSecret:lease.clientSecret,accessToken:lease.accessToken,broadcasterId:lease.providerAccountId,salt,durationMs}});
  out({kind:'monitor_ready',before:{state:before.channel.state,pending:before.pending,deadLetters:before.deadLetters}});
  const end=Date.now()+durationMs+15000;let tick=0;
  while(!ended&&Date.now()<end){
    await new Promise(r=>setTimeout(r,2000));const s=state();
    if(s.channel?.state!=='connected')halt('original_state_changed');
    if(Date.now()-Date.parse(s.heartbeatAt)>35000)halt('original_state_stale');
    if(Date.now()-contact>30000)halt('supervisor_disconnected');
    if(s.pending>before.pending+50||s.deadLetters>before.deadLetters)halt('original_queue_increased');
    if(++tick%15===0){const identity=await selected.send('Runtime.evaluate',{expression,returnByValue:true});if(identity.result?.value!==true)halt('original_room_changed');out({kind:'original_health',at:Date.now(),state:s.channel?.state,pending:s.pending,deadLetters:s.deadLetters,roomMatches:identity.result?.value===true})}
  }
  const after=state();out({kind:'monitor_done',after:{state:after.channel?.state,pending:after.pending,deadLetters:after.deadLetters},aborted:ended});
}catch(e){halt(/^[a-z_]+$/.test(e.message)?e.message:'monitor_failed')}
finally{ended=true;selected?.close();clearTimeout(hardStop);input.close();process.exit(process.exitCode||0)}
