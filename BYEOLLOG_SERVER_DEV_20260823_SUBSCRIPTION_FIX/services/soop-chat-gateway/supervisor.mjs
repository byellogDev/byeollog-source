import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {homedir,uptime} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const serviceDirectory=dirname(fileURLToPath(import.meta.url));
const repository=resolve(serviceDirectory,'..','..');
const defaultEntry=join(serviceDirectory,'index.mjs');
const stateDirectory=resolve(process.env.SOOP_GATEWAY_STATE_DIR||join(homedir(),'.byeollog','soop-gateway'));
const statePath=join(stateDirectory,'supervisor-state.json');
const workerStatePath=join(stateDirectory,'worker-state.json');
const healthHost=String(process.env.SOOP_GATEWAY_HEALTH_HOST||'127.0.0.1');
const healthPort=Math.max(0,Math.min(65_535,Math.trunc(Number(process.env.SOOP_GATEWAY_HEALTH_PORT)||0)));
const baseDelay=Math.max(50,Math.min(30_000,Math.trunc(Number(process.env.SOOP_GATEWAY_RESTART_BASE_MS)||3_000)));
const maxDelay=Math.max(baseDelay,Math.min(60_000,Math.trunc(Number(process.env.SOOP_GATEWAY_RESTART_MAX_MS)||30_000)));
const selfTest=process.env.SOOP_GATEWAY_SUPERVISOR_SELF_TEST==='true';
const supervisorInstanceId=randomUUID();
const approximateBootAt=new Date(Date.now()-uptime()*1_000).toISOString();
const childEntry=selfTest&&process.env.SOOP_GATEWAY_SELF_TEST_ENTRY
  ?resolve(process.env.SOOP_GATEWAY_SELF_TEST_ENTRY)
  :defaultEntry;
const childRelativePath=relative(repository,childEntry);
if(childRelativePath.startsWith('..')||isAbsolute(childRelativePath))throw new Error('Gateway child entry must stay inside the repository.');

let child=null,childStartedAtMs=0,stopping=false,restartCount=0,lastExit=null,startedAt=new Date().toISOString(),heartbeatAt=startedAt,workerHeartbeatAt=null;
function log(level,event,data={}){process.stdout.write(`${JSON.stringify({at:new Date().toISOString(),level,event,supervisorPid:process.pid,...data})}\n`)}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function publicState(status='running'){
  return {schemaVersion:1,status,supervisorInstanceId,supervisorPid:process.pid,parentPid:process.ppid,childPid:child?.pid||null,startedAt,heartbeatAt,workerHeartbeatAt,approximateBootAt,nodeVersion:process.version,platform:process.platform,restartCount,lastExit};
}
async function persist(status='running'){
  heartbeatAt=new Date().toISOString();
  await mkdir(stateDirectory,{recursive:true});
  const temporary=statePath+'.tmp';
  await writeFile(temporary,JSON.stringify(publicState(status)),{encoding:'utf8',mode:0o600});
  await rename(temporary,statePath);
}
async function previousState(){try{return JSON.parse(await readFile(statePath,'utf8'))}catch{return null}}
async function workerHealthy({allowStartupGrace=true}={}){
  if(!child?.pid)return false;
  if(allowStartupGrace&&Date.now()-childStartedAtMs<30_000)return true;
  try{
    const state=JSON.parse(await readFile(workerStatePath,'utf8'));
    workerHeartbeatAt=state.heartbeatAt||null;
    const age=Date.now()-Date.parse(state.heartbeatAt||'');
    return state.status==='running'&&Number(state.pid)===Number(child.pid)&&Number.isFinite(age)&&age<=45_000;
  }catch{return false}
}

async function runChild(){
  const childStartedAt=Date.now();
  childStartedAtMs=childStartedAt;workerHeartbeatAt=null;
  child=spawn(process.execPath,[childEntry],{cwd:repository,env:{...process.env,SOOP_GATEWAY_STATE_DIR:stateDirectory},stdio:'inherit',windowsHide:true});
  await persist();
  log('info','gateway_child_started',{childPid:child.pid,restartCount});
  const result=await new Promise(resolve=>{
    let settled=false;
    const finish=value=>{if(settled)return;settled=true;resolve(value)};
    child.once('error',error=>finish({code:null,signal:null,errorCode:String(error?.code||'spawn_failed')}));
    child.once('exit',(code,signal)=>finish({code,signal,errorCode:null}));
  });
  const runtimeMs=Date.now()-childStartedAt;
  lastExit={at:new Date().toISOString(),runtimeMs,code:result.code,signal:result.signal,errorCode:result.errorCode};
  log(stopping?'info':'warn','gateway_child_exited',{runtimeMs,...result});
  child=null;
  await persist(stopping?'stopping':'running');
  return runtimeMs;
}

const healthServer=healthPort?createServer(async(req,res)=>{
  if(req.url!=='/healthz'){res.writeHead(404);return res.end()}
  const healthy=!stopping&&await workerHealthy();
  res.writeHead(healthy?200:503,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify({ok:healthy,...publicState(stopping?'stopping':'running')}));
}):null;

async function shutdown(signal){
  if(stopping)return;stopping=true;log('info','gateway_supervisor_stopping',{signal});
  try{child?.kill('SIGTERM')}catch{}
}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void shutdown(signal));

async function main(){
  await mkdir(stateDirectory,{recursive:true});
  const previous=await previousState();
  if(previous?.status==='running'||previous?.status==='stopping'){
    log('warn','unclean_previous_supervisor_exit',{previousSupervisorInstanceId:previous.supervisorInstanceId||null,previousSupervisorPid:Number(previous.supervisorPid)||null,previousChildPid:Number(previous.childPid)||null,previousHeartbeatAt:previous.heartbeatAt||null,previousApproximateBootAt:previous.approximateBootAt||null,currentApproximateBootAt:approximateBootAt});
  }
  await persist();
  if(healthServer)await new Promise((resolveListen,reject)=>healthServer.once('error',reject).listen(healthPort,healthHost,resolveListen));
  log('info','gateway_supervisor_started',{stateDirectory,healthEnabled:Boolean(healthServer),healthPort:healthServer?.address()?.port||null,selfTest});
  const stateTimer=setInterval(()=>void persist().catch(error=>log('error','supervisor_state_write_failed',{code:String(error?.code||'state_write_failed')})),15_000);
  const workerMonitor=setInterval(()=>void (async()=>{
    if(stopping||!child?.pid||await workerHealthy())return;
    log('error','gateway_child_heartbeat_stale',{childPid:child.pid,workerHeartbeatAt});
    try{child.kill('SIGTERM')}catch{}
  })().catch(error=>log('error','gateway_child_health_check_failed',{code:String(error?.code||'worker_health_failed')})),15_000);
  let delay=baseDelay;
  try{
    while(!stopping){
      const runtimeMs=await runChild();
      if(stopping)break;
      restartCount+=1;
      delay=runtimeMs>=300_000?baseDelay:Math.min(maxDelay,Math.max(baseDelay,delay*2));
      log('warn','gateway_child_restart_scheduled',{restartCount,delayMs:delay});
      await sleep(delay);
    }
  }finally{
    clearInterval(stateTimer);
    clearInterval(workerMonitor);
    await persist('stopped').catch(()=>{});
    await new Promise(resolveClose=>healthServer?healthServer.close(resolveClose):resolveClose());
    log('info','gateway_supervisor_stopped',{restartCount});
  }
}

main().catch(error=>{log('fatal','gateway_supervisor_failed',{code:String(error?.code||'supervisor_failed')});process.exitCode=1});
