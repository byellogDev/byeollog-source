// Disposable local fixture. No streamer credentials, live sockets or production API.
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,realpath} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {EncryptedGatewayOutbox} from '../services/soop-chat-gateway/outbox.mjs';
import {closeSoopBrowserHost,openSoopSharedBrowserProbeSessions} from '../services/soop-chat-gateway/browser-session.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const exec=promisify(execFile),root=resolve('../.tmp'),out=resolve('../output/operations-20260909');
await mkdir(root,{recursive:true});await mkdir(out,{recursive:true});
const directory=await mkdtemp(join(root,'idle-soak-'));
const secret='isolated-soak-synthetic-secret-never-production-123456789';
const make=()=>new EncryptedGatewayOutbox({directory,secret,baseRetryMs:1,maxRetryMs:1});
const body=n=>({workspaceId:'fixture-'+(n%20),relay:{connection:{id:'synthetic-session',sequence:Math.floor(n/20)},event:{fixtureId:n,type:n%2?'donation':'roulette_result'}}});
const started=Date.now(),result={startedAt:new Date().toISOString(),durationTargetSeconds:720,samples:[],browserCycles:[],saturation:null,passed:false};
let probes=[],box=make(),counter=10000,cycles=0,received=0;
const persist=()=>writeFile(join(out,'idle-soak.json'),JSON.stringify(result,null,2));
async function processTree(pid){
 const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress'],{windowsHide:true,maxBuffer:8*1024*1024});
 const rows=JSON.parse(stdout),ids=new Set([pid]);let changed=true;
 while(changed){changed=false;for(const r of rows)if(ids.has(r.ParentProcessId)&&!ids.has(r.ProcessId)){ids.add(r.ProcessId);changed=true}}
 const selected=rows.filter(r=>ids.has(r.ProcessId));return {processCount:selected.length,workingSetMiB:Math.round(selected.reduce((s,r)=>s+Number(r.WorkingSetSize),0)/1048576)};
}
try{
 await box.init();let times=[];let fillStart=performance.now();
 for(let n=0;n<10000;n++){const t=performance.now();await box.enqueue(body(n));times.push(performance.now()-t);if(n%2000===1999)console.log(JSON.stringify({stage:'fill',count:n+1}));}
 assert.equal(await box.count(),10000);
 await assert.rejects(box.enqueue(body(10000)),{code:'outbox_full'});
 await box.enqueue(body(0));assert.equal(await box.count(),10000);
 const fillMs=performance.now()-fillStart;
 await box.flush(async()=>{throw Object.assign(Error('synthetic unavailable'),{status:503})},{limit:250,concurrency:2});assert.equal(await box.count(),10000);
 box=make();await box.init();const seen=new Set(),last=Array(20).fill(-1);let drainStart=performance.now();
 while(await box.count())await box.flush(async b=>{const id=b.relay.event.fixtureId,w=id%20;assert.ok(b.relay.connection.sequence>last[w]);last[w]=b.relay.connection.sequence;assert.ok(!seen.has(id));seen.add(id)},{limit:250,concurrency:2});
 assert.equal(seen.size,10000);times.sort((a,b)=>a-b);
 result.saturation={limit:10000,overflowRejected:true,duplicateAcceptedAtLimit:true,retainedAfter503:10000,restoredAfterRestart:10000,missing:0,sequenceCorrect:true,fillSeconds:fillMs/1000,enqueueP95Ms:times[Math.floor(times.length*.95)],drainSeconds:(performance.now()-drainStart)/1000};await persist();console.log(JSON.stringify({stage:'saturation',...result.saturation}));
 const soakStart=Date.now();
 while(Date.now()-soakStart<720000){
  const batchStart=counter;for(let n=0;n<200;n++)await box.enqueue(body(counter++));
  if(cycles%3===1){await box.flush(async()=>{throw Object.assign(Error('synthetic unavailable'),{status:503})},{concurrency:2});box=make();await box.init();}
  const batch=new Set();while(await box.count())await box.flush(async b=>{assert.ok(!batch.has(b.relay.event.fixtureId));batch.add(b.relay.event.fixtureId);received++},{limit:250,concurrency:2});
  assert.equal(batch.size,200);for(let n=batchStart;n<counter;n++)assert.ok(batch.has(n));
  const t=performance.now();const opened=await Promise.allSettled(Array.from({length:5},()=>openSoopSharedBrowserProbeSessions(1)));
  probes=opened.filter(x=>x.status==='fulfilled').map(x=>x.value);assert.equal(probes.length,5,'Five simultaneous SDK page creations failed');
  await pause(1500);const active=await processTree(probes[0].browserPid);
  await Promise.all(probes.map(p=>p.close()));probes=[];await pause(1000);
  const idle=await processTree(process.pid);global.gc?.();const mem=process.memoryUsage();
  result.browserCycles.push({cycle:cycles+1,sessions:5,creationAndCloseSeconds:(performance.now()-t)/1000,active,idle});
  result.samples.push({elapsedSeconds:(Date.now()-soakStart)/1000,heapMiB:mem.heapUsed/1048576,rssMiB:mem.rss/1048576,pending:await box.count(),metadataEntries:box.metadataCache.size});
  cycles++;result.soakWallSeconds=(Date.now()-soakStart)/1000;result.syntheticEventsReceived=received;await persist();console.log(JSON.stringify({stage:'soak',cycle:cycles,seconds:Math.round(result.soakWallSeconds),idleProcesses:idle.processCount,heapMiB:Math.round(mem.heapUsed/1048576)}));
  await pause(Math.min(20000,Math.max(0,720000-(Date.now()-soakStart))));
 }
 result.soakWallSeconds=(Date.now()-soakStart)/1000;result.passed=true;
 result.limitations='Local Windows host. SDK instances use no credentials or live SOOP sockets. Browser page recycling is not a live broadcast reconnect test. Twelve-minute wall-clock test cannot establish eight-hour stability or NCP capacity.';
}catch(e){result.failure={name:e.name,code:e.code||null,message:String(e.message).slice(0,200)};process.exitCode=1;}
finally{
 await Promise.allSettled(probes.map(p=>p.close()));await closeSoopBrowserHost();
 const p=await realpath(directory);assert.equal(dirname(p),await realpath(root));await rm(p,{recursive:true,force:true});result.fixtureRemoved=true;result.finishedAt=new Date().toISOString();result.totalWallSeconds=(Date.now()-started)/1000;await persist();console.log(JSON.stringify({stage:'done',passed:result.passed,failure:result.failure,seconds:result.totalWallSeconds}));
}
