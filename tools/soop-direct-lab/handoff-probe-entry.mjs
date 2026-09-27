// Deliberately separate from buildBundle()/soak-entry. No implicit live launch.
// JSONL on stdin: {kind:'start',mode:'handoff-probe',config:{...}},
// {kind:'heartbeat'}, then {kind:'replacement',config:{...}} only when requested.
// All OAuth material stays in this pipe and memory; stdout is metadata only.
import readline from 'node:readline';
import {WebSocket} from 'ws';
import {probeTokenHandoff} from './handoff-probe.mjs';
if(process.argv.length!==2){process.stderr.write('stdin_configuration_required\n');process.exit(2)}
const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
const abort=new AbortController();let started=false,closed=false,lastContact=Date.now(),replacement=null,failed=false;
const out=value=>process.stdout.write(JSON.stringify(value)+'\n');
const stop=()=>{failed=true;abort.abort();input.close()};
const pick=c=>Object.fromEntries(['broadcasterId','accessToken','clientId','clientSecret','providerTokenExpiresAt'].map(k=>[k,c?.[k]]));
const watchdog=setInterval(()=>{if(Date.now()-lastContact>30000)stop()},1000);
input.on('close',()=>{closed=true;abort.abort();clearInterval(watchdog)});
input.on('line',line=>{
 if(closed)return;
 try{
  if(Buffer.byteLength(line)>32768)throw Error();
  const message=JSON.parse(line);lastContact=Date.now();
  if(message.kind==='heartbeat')return;
  if(message.kind==='replacement'&&replacement){const receive=replacement;replacement=null;receive(pick(message.config));return}
  if(message.kind!=='start'||message.mode!=='handoff-probe'||started)throw Error();
  started=true;
  void probeTokenHandoff(pick(message.config),{WebSocketImpl:WebSocket,signal:abort.signal,onReport:out,
   getReplacement:({signal})=>new Promise((resolve,reject)=>{
    const cancelled=()=>{replacement=null;reject(Error('cancelled'))};
    signal.addEventListener('abort',cancelled,{once:true});
    replacement=c=>{signal.removeEventListener('abort',cancelled);resolve(c)};
    out({kind:'replacement_required'});
   })}).then(result=>{process.exitCode=result.status==='promoted'?0:2}).catch(()=>{failed=true;out({kind:'probe_rejected'})}).finally(()=>{
    if(failed)process.exitCode=2;clearInterval(watchdog);input.close();
   });
 }catch{out({kind:'probe_input_rejected'});process.exitCode=2;stop()}
});
process.on('SIGINT',stop);process.on('SIGTERM',stop);
