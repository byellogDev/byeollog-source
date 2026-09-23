import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {closeSoopBrowserHost,openSoopSharedBrowserProbeSessions} from '../services/soop-chat-gateway/browser-session.mjs';

const execFileAsync=promisify(execFile);
const targetCount=Math.trunc(Number(process.argv[2]||100));
const settleMs=Math.max(2_000,Math.min(60_000,Math.trunc(Number(process.argv[3]||8_000))));

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms))}

async function windowsProcessTree(rootPid){
  const script="Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime | ConvertTo-Json -Compress";
  const {stdout}=await execFileAsync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{maxBuffer:16*1024*1024,windowsHide:true});
  const parsed=JSON.parse(stdout),rows=Array.isArray(parsed)?parsed:[parsed],selected=new Set([Number(rootPid)]);
  let changed=true;
  while(changed){changed=false;for(const row of rows){if(selected.has(Number(row.ParentProcessId))&&!selected.has(Number(row.ProcessId))){selected.add(Number(row.ProcessId));changed=true}}}
  const tree=rows.filter(row=>selected.has(Number(row.ProcessId)));
  return {
    processCount:tree.length,
    workingSetBytes:tree.reduce((sum,row)=>sum+Number(row.WorkingSetSize||0),0),
    cpu100ns:tree.reduce((sum,row)=>sum+Number(row.KernelModeTime||0)+Number(row.UserModeTime||0),0)
  };
}

async function processTree(rootPid){
  if(process.platform==='win32')return await windowsProcessTree(rootPid);
  throw new Error('This benchmark currently supports Windows process metrics only');
}

let probe;
try{
  const started=performance.now();
  probe=await openSoopSharedBrowserProbeSessions(targetCount);
  const creationMs=performance.now()-started;
  await sleep(settleMs);
  const first=await processTree(probe.browserPid),sampleMs=5_000;
  await sleep(sampleMs);
  const second=await processTree(probe.browserPid);
  const cpuCorePercent=Math.max(0,(second.cpu100ns-first.cpu100ns)/10_000_000/(sampleMs/1_000)*100);
  process.stdout.write(JSON.stringify({
    targetCount:probe.targetCount,
    shardCount:probe.shardCount,
    sessionsPerShard:probe.sessionsPerShard,
    rendererProcessLimit:probe.rendererProcessLimit,
    creationMs:Math.round(creationMs),
    processCount:second.processCount,
    workingSetMiB:Math.round(second.workingSetBytes/1024/1024*10)/10,
    idleCpuCorePercent:Math.round(cpuCorePercent*10)/10,
    note:'SDK pages are loaded, but no streamer tokens or live SOOP sockets are used.'
  },null,2)+'\n');
}finally{
  await probe?.close?.();
  await closeSoopBrowserHost();
}
