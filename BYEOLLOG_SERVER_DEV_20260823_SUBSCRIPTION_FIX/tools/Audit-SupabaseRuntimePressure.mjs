import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {dirname,join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const execFileAsync=promisify(execFile);
const SQL=`select
  coalesce((select sum(stat.calls)::bigint from extensions.pg_stat_statements stat
    where pg_catalog.ltrim(stat.query) ilike 'with pgrst_source%'
      and (pg_catalog.strpos(stat.query,('activate_native_'::text||'roulette_service_v2'))>0
        or pg_catalog.strpos(stat.query,('activate_native_'::text||'roulette_service_v3'))>0
        or pg_catalog.strpos(stat.query,('activate_native_'::text||'roulette_draft_v3'))>0)),0)::bigint as activation_calls_total,
  (select count(*)::integer from pg_catalog.pg_stat_activity activity
    where activity.state='active' and activity.backend_type='client backend' and activity.pid<>pg_backend_pid()
      and clock_timestamp()-activity.query_start>interval '10 seconds') as long_running_active,
  (select count(*)::integer from pg_catalog.pg_stat_activity activity
    where activity.backend_type='client backend' and activity.wait_event_type='Lock') as lock_waiters;`;

function parseCliJson(output){
  const start=output.indexOf('{'),end=output.lastIndexOf('}');
  if(start<0||end<start)throw new Error('Supabase CLI did not return a JSON result.');
  const parsed=JSON.parse(output.slice(start,end+1));
  const row=parsed?.rows?.[0];
  if(!row)throw new Error('Supabase pressure query returned no row.');
  return {
    activationCallsTotal:Number(row.activation_calls_total)||0,
    longRunningActive:Number(row.long_running_active)||0,
    lockWaiters:Number(row.lock_waiters)||0
  };
}

async function sample(){
  const npxCandidates=[
    String(process.env.npm_execpath||'').replace(/npm-cli\.js$/i,'npx-cli.js'),
    resolve(dirname(process.execPath),'node_modules','npm','bin','npx-cli.js')
  ].filter(candidate=>candidate&&existsSync(candidate));
  const executable=npxCandidates.length?process.execPath:'npx';
  const directory=await mkdtemp(join(tmpdir(),'byeollog-pressure-')),queryPath=join(directory,'pressure.sql');
  try{
    await writeFile(queryPath,SQL,'utf8');
    const cliArgs=['--yes','supabase@2.116.0','db','query','--linked','--file',queryPath];
    const args=npxCandidates.length?[npxCandidates[0],...cliArgs]:cliArgs;
    const {stdout}=await execFileAsync(executable,args,{maxBuffer:2_000_000,windowsHide:true});
    return parseCliJson(stdout);
  }finally{
    await rm(directory,{recursive:true,force:true});
  }
}

export async function auditSupabaseRuntimePressure({intervalSeconds=15,sampleImpl=sample,sleepImpl=setTimeout}={}){
  const interval=Math.max(1,Math.min(60,Math.trunc(Number(intervalSeconds)||15)));
  const first=await sampleImpl();
  await new Promise(resolveDelay=>sleepImpl(resolveDelay,interval*1000));
  const second=await sampleImpl();
  const activationDelta=Math.max(0,second.activationCallsTotal-first.activationCallsTotal);
  const activationCallsPerSecond=Math.round((activationDelta/interval)*1000)/1000;
  const critical=activationDelta>100||second.longRunningActive>5||second.lockWaiters>10;
  const warning=!critical&&(activationDelta>10||second.longRunningActive>0||second.lockWaiters>0);
  return {
    schemaVersion:1,mode:'read-only-linked-supabase-pressure-audit',generatedAt:new Date().toISOString(),
    safety:{readOnlySql:true,databaseWrites:false,secretsPrinted:false},
    intervalSeconds:interval,first,second,activationDelta,activationCallsPerSecond,
    status:critical?'critical':warning?'warning':'healthy',passed:!critical
  };
}

const invoked=process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href;
if(invoked){
  const index=process.argv.indexOf('--interval-seconds');
  const report=await auditSupabaseRuntimePressure({intervalSeconds:index>=0?process.argv[index+1]:15});
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode=report.passed?0:1;
}
