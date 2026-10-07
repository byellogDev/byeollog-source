import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { loadContext, loadRules, joinMessage, validateContext } from './protocol.mjs';
import { lookupPlan, assessLookup, digest } from './browserless-core.mjs';

export class TrialOutbox {
  constructor(directory, maxBytes=128*1024*1024) { this.directory=directory;this.maxBytes=maxBytes;fs.mkdirSync(directory,{recursive:true,mode:0o700}); }
  put(record) {
    const text=JSON.stringify(record),key=digest(record),file=path.join(this.directory,key+'.json');
    if(fs.existsSync(file))return;
    if(fs.readdirSync(this.directory).reduce((n,f)=>n+fs.statSync(path.join(this.directory,f)).size,0)+Buffer.byteLength(text)>this.maxBytes)throw Error('trial_local_capacity');
    const fd=fs.openSync(file+'.tmp','wx',0o600);
    try{fs.writeFileSync(fd,text);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    fs.renameSync(file+'.tmp',file);
  }
  async flush(rpc) {
    let disabled=false;
    for(const name of fs.readdirSync(this.directory).filter(f=>f.endsWith('.json')).slice(0,25)) {
      const file=path.join(this.directory,name),q=JSON.parse(fs.readFileSync(file,'utf8'));
      const result=await rpc(q);
      if(['disabled','capacity_stop'].includes(result.status)){disabled=true;continue;}
      if(!['recorded','already_recorded','ignored'].includes(result.status))throw Error('trial_delivery_not_accepted');
      // Keep evidence independently; only the acknowledged delivery envelope is removed.
      fs.unlinkSync(file);
    }
    return {disabled};
  }
}

export function createTrialRpc(config) {
  if(!/^https:\/\/[a-z]+\.supabase\.co$/.test(config.supabaseUrl))throw Error('trial_api_origin');
  return async q=>{
    const r=await fetch(config.supabaseUrl+'/rest/v1/rpc/byeollog_weflab_trial_rpc_v1',{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{apikey:config.publishableKey,'content-type':'application/json'},
      body:JSON.stringify({p_workspace_id:config.workspaceId,p_request:{...q,serverSecret:config.serverSecret}})});
    if(!r.ok)throw Error('trial_rpc_'+r.status);
    return r.json();
  };
}

export class TrialIntake {
  constructor(pin,record){this.pin=pin;this.record=record;this.sockets=new Set();this.joined=new Set();this.stopped=false;this.failed=false;}
  get ready(){return !this.failed&&this.joined.size===2;}
  async start(){this.context=await loadContext(this.pin);this.rules=await loadRules(this.context);for(const c of ['main','afreeca'])this.connect(c);}
  stop(){this.stopped=true;for(const s of this.sockets)s.terminate();this.joined.clear();}
  connect(channel){
    if(this.stopped)return;
    const base=channel==='main'?this.context.config.url.socket:this.context.config.url.socket_afreeca;
    const url=new URL('/socket.io/',base);url.protocol='wss:';
    for(const [k,v]of Object.entries({EIO:'4',transport:'websocket',idx:this.context.idx,type:'page',page:'alert'}))url.searchParams.set(k,v);
    const ws=new WebSocket(url,{origin:'https://weflab.com',handshakeTimeout:15000,maxPayload:1024*1024});this.sockets.add(ws);
    let last=Date.now(),limit=45000;
    const watchdog=setInterval(()=>{if(Date.now()-last>limit)ws.terminate();},5000);
    ws.on('message',data=>{
      const raw=data.toString();last=Date.now();
      try{
        if(raw.startsWith('0')){const h=JSON.parse(raw.slice(1));limit=Math.min(120000,Math.max(15000,Number(h.pingInterval)+Number(h.pingTimeout)+5000));ws.send('40');return;}
        if(raw==='2'){ws.send('3');return;}
        if(raw.startsWith('40')){ws.send('42'+JSON.stringify(['msg',joinMessage(this.context,channel)]));this.joined.add(channel);return;}
        if(raw==='41'||raw.startsWith('44')){ws.terminate();return;}
        if(!raw.startsWith('42'))return;
        const frame=JSON.parse(raw.slice(2)),message=frame[1];if(frame[0]!=='msg'||!message)return;
        if(['load','refresh','refresh_all'].includes(message.type)){
          this.failed=true;this.stop();return; // reconnect with fresh rule snapshot, never use stale rules
        }
        if(!['alert','test_donation'].includes(message.type))return;
        validateContext(this.context,this.pin);
        this.record({action:'ingest',context:this.context,rules:this.rules,message});
      }catch{this.failed=true;this.stop();}
    });
    ws.on('error',()=>{});
    ws.on('close',()=>{clearInterval(watchdog);this.sockets.delete(ws);this.joined.delete(channel);if(!this.stopped)setTimeout(()=>this.connect(channel),5000).unref();});
  }
}

export async function executeTrialJob({rpc,key,token,record,fetchResult=fetch}) {
  const reserved=await rpc({action:'reserve',key,token});
  if(reserved.status!=='reserved')return reserved;
  const p=reserved.plan;
  if(p.key!==key||digest(p.body)!==p.requestHash||p.body.type!=='roulette_result'||p.body.platform!=='afreeca')throw Error('trial_bad_plan');
  record({kind:'request_started',key,attempt:reserved.attempt,plan:p});
  let response;
  try{
    const r=await fetchResult('https://weflab.com/api/',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),body:new URLSearchParams(p.body)});
    const raw=await r.text();let json;try{json=JSON.parse(raw);}catch{}
    response={httpStatus:r.status,raw,assessment:r.ok?assessLookup(json,p.count):{status:'needs_review',reason:'provider_http'}};
  }catch{response={assessment:{status:'needs_review',reason:'uncertain_request_do_not_repeat'}};}
  const completion={action:'complete',key,attempt:reserved.attempt,response};
  record({kind:'response',...completion});
  return completion; // Durable delivery may retry completion, never the provider request.
}

export async function runTrialServer(config,directory,signal) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const lock=path.join(directory,'running.lock'),fd=fs.openSync(lock,'wx',0o600);
  const rpc=createTrialRpc(config),outbox=new TrialOutbox(path.join(directory,'outbox'));
  const evidence=path.join(directory,'evidence.jsonl');
  let bytes=fs.existsSync(evidence)?fs.statSync(evidence).size:0;
  const record=value=>{
    const line=JSON.stringify({at:new Date().toISOString(),...value})+'\n';
    if(bytes+Buffer.byteLength(line)>512*1024*1024)throw Error('trial_evidence_capacity');
    const f=fs.openSync(evidence,'a',0o600);try{fs.writeFileSync(f,line);fs.fsyncSync(f);}finally{fs.closeSync(f);}bytes+=Buffer.byteLength(line);
  };
  let intake=null,status='starting',lastError=null;
  try{
    while(!signal.aborted){
      try{
        const delivery=await outbox.flush(rpc);
        if(delivery.disabled){intake?.stop();intake=null;}
        const h=await rpc({action:'heartbeat',ready:intake?.ready===true});status=h.status;
        if(h.status==='disabled'){intake?.stop();intake=null;}
        else {
          if(intake?.failed){intake.stop();intake=null;}
          if(['prepare','owner'].includes(h.status)&&!intake){intake=new TrialIntake(h.config,q=>{record({kind:'intake',...q});outbox.put(q);});await intake.start();}
          if(['draining','standby'].includes(h.status)){intake?.stop();intake=null;if(h.status==='draining')await rpc({action:'release',token:h.token});}
          const pending=await rpc({action:'pending_events'});
          for(const e of pending.events||[]){let plan=null,reason=null;
            try{plan=lookupPlan(e.context,h.config,e.message,e.rules);}catch(err){reason=/^[a-z_]+$/.test(err.message)?err.message:'unsupported';}
            await rpc({action:'plan',eventKey:e.event_key,plan,reason});
          }
          if(h.status==='owner'&&intake?.ready){
            const due=await rpc({action:'due',token:h.token});
            // One provider request per tick keeps the lease valid even with a slow API.
            for(const key of (due.keys||[]).slice(0,1)){
              const result=await executeTrialJob({rpc,key,token:h.token,record});
              if(result.action==='complete'){outbox.put(result);await outbox.flush(rpc);}
            }
          }
        }
        lastError=null;
      }catch(e){lastError=String(e.message).slice(0,100);record({kind:'failure',reason:lastError});if(/capacity|ENOSPC|EACCES/.test(lastError))throw e;}
      fs.writeFileSync(path.join(directory,'status.json'),JSON.stringify({at:new Date().toISOString(),status,ready:intake?.ready===true,lastError,bytes,rss:process.memoryUsage().rss}));
      await new Promise(resolve=>{const t=setTimeout(done,10000);function done(){clearTimeout(t);signal.removeEventListener('abort',done);resolve();}signal.addEventListener('abort',done,{once:true});});
    }
  }finally{intake?.stop();fs.closeSync(fd);fs.unlinkSync(lock);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8')),stop=new AbortController();
  for(const s of ['SIGTERM','SIGINT'])process.once(s,()=>stop.abort());
  await runTrialServer(config,path.resolve(process.argv[3]),stop.signal);
}
