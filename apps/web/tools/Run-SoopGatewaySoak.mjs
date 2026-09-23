import {appendFile,mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {homedir} from 'node:os';

const args=new Map(process.argv.slice(2).reduce((pairs,value,index,all)=>value.startsWith('--')?pairs.concat([[value,all[index+1]]]):pairs,[]));
const requestedHours=Number(args.get('--hours'));
const durationMs=Math.max(60_000,Number(process.env.SOOP_GATEWAY_SOAK_DURATION_MS)||(Number.isFinite(requestedHours)&&requestedHours>0?requestedHours*60*60*1_000:24*60*60*1_000));
const intervalMs=Math.max(1_000,Number(process.env.SOOP_GATEWAY_SOAK_INTERVAL_MS)||15_000);
const statePath=process.env.SOOP_GATEWAY_SUPERVISOR_STATE||join(process.env.LOCALAPPDATA||join(homedir(),'AppData','Local'),'Byeollog','soop-gateway','supervisor-state.json');
const outputDirectory=args.get('--output')||process.env.SOOP_GATEWAY_SOAK_OUTPUT||join(dirname(dirname(statePath)),'soak');
const checkpointPath=join(outputDirectory,'current.json'),samplePath=join(outputDirectory,'samples.jsonl'),reportPath=join(outputDirectory,'report.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function json(path){try{return JSON.parse(await readFile(path,'utf8'))}catch{return null}}
function alive(pid){if(!Number(pid))return false;try{process.kill(Number(pid),0);return true}catch{return false}}
await mkdir(outputDirectory,{recursive:true});
let checkpoint=await json(checkpointPath);
if(!checkpoint||checkpoint.completed||Date.parse(checkpoint.deadlineAt)<=Date.now())checkpoint={schemaVersion:1,startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+durationMs).toISOString(),completed:false};
await writeFile(checkpointPath,JSON.stringify(checkpoint,null,2),'utf8');
while(Date.now()<Date.parse(checkpoint.deadlineAt)){
  const state=await json(statePath),observedAt=new Date().toISOString(),heartbeatAgeMs=state?.heartbeatAt?Date.now()-Date.parse(state.heartbeatAt):null;
  const healthy=Boolean(state&&state.status==='running'&&alive(state.supervisorPid)&&alive(state.childPid)&&Number.isFinite(heartbeatAgeMs)&&heartbeatAgeMs<=45_000);
  await appendFile(samplePath,`${JSON.stringify({observedAt,healthy,heartbeatAgeMs,supervisorInstanceId:state?.supervisorInstanceId||null,supervisorPid:Number(state?.supervisorPid)||null,childPid:Number(state?.childPid)||null,restartCount:Number(state?.restartCount)||0,status:state?.status||'missing'})}\n`,'utf8');
  await sleep(Math.min(intervalMs,Math.max(1,Date.parse(checkpoint.deadlineAt)-Date.now())));
}
const lines=(await readFile(samplePath,'utf8').catch(()=>'' )).trim().split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
let longestUnhealthyMs=0,currentUnhealthyStarted=null;
for(const sample of lines){if(!sample.healthy&&currentUnhealthyStarted===null)currentUnhealthyStarted=Date.parse(sample.observedAt);if(sample.healthy&&currentUnhealthyStarted!==null){longestUnhealthyMs=Math.max(longestUnhealthyMs,Date.parse(sample.observedAt)-currentUnhealthyStarted);currentUnhealthyStarted=null}}
if(currentUnhealthyStarted!==null)longestUnhealthyMs=Math.max(longestUnhealthyMs,Date.now()-currentUnhealthyStarted);
const healthyCount=lines.filter(sample=>sample.healthy).length;
const report={schemaVersion:1,startedAt:checkpoint.startedAt,completedAt:new Date().toISOString(),sampleCount:lines.length,healthyCount,healthyRatio:lines.length?healthyCount/lines.length:0,longestUnhealthyMs,restartCountStart:lines[0]?.restartCount||0,restartCountEnd:lines.at(-1)?.restartCount||0,supervisorInstances:[...new Set(lines.map(sample=>sample.supervisorInstanceId).filter(Boolean))],pass:lines.length>0&&healthyCount/lines.length>=0.999&&longestUnhealthyMs<=45_000};
checkpoint.completed=true;checkpoint.reportPath=reportPath;await writeFile(reportPath,JSON.stringify(report,null,2),'utf8');await writeFile(checkpointPath,JSON.stringify(checkpoint,null,2),'utf8');
process.stdout.write(`${JSON.stringify(report)}\n`);process.exitCode=report.pass?0:1;
