import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runNativeRouletteTwinCampaign} from './native-roulette-digital-twin-core.mjs';
import {runStabilityEventReplay} from './stability-event-replay-core.mjs';
import {runProductionSmoke} from './Run-ProductionSmoke.mjs';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const repositoryRoot=resolve(root,'..');
const has=name=>process.argv.includes(name);
const arg=(name,fallback=null)=>{const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]??fallback:fallback;};
const reportDirectory=resolve(arg('--report-dir',resolve(repositoryRoot,'output','stability-gate')));

function markdown(report){
  const rows=Object.entries(report.checks).map(([name,value])=>`| ${name} | ${value?'PASS':'FAIL'} |`).join('\n');
  return `# Byeollog stability gate\n\n- Result: **${report.passed?'PASS':'FAIL'}**\n- Mode: ${report.mode}\n- Generated: ${report.generatedAt}\n- Production mutations: none\n\n| Check | Result |\n|---|---|\n${rows}\n\n## Replay\n\n- Scenarios: ${report.replay.summary.scenarios}\n- Dispatches: ${report.replay.summary.dispatchCount}\n- Duplicates suppressed: ${report.replay.summary.duplicateCount}\n- Identity conflicts rejected: ${report.replay.summary.identityConflictCount}\n\n## Digital twin\n\n- Runs: ${report.digitalTwin.runs}\n- Failures: ${report.digitalTwin.failures.length}\n\n## Production smoke\n\n${report.productionSmoke?`- Requests: ${report.productionSmoke.summary.requests}\n- Failed: ${report.productionSmoke.summary.failed}\n- p95: ${report.productionSmoke.summary.p95Ms} ms\n`:'- Not requested. Run with `--production` after deployment.\n'}\n`;
}

const [fixture,migration,overlay]=await Promise.all([
  readFile(resolve(root,'stability','fixtures','soop-event-replay-v1.json'),'utf8').then(JSON.parse),
  readFile(resolve(root,'supabase','migrations','20260903113000_multi_active_native_roulettes.sql'),'utf8'),
  readFile(resolve(root,'lib','common-overlay-v8.js'),'utf8')
]);
const replay=await runStabilityEventReplay(fixture);
const digitalTwin=runNativeRouletteTwinCampaign({runsPerScenario:125,seed:20260903});
const activateStart=migration.indexOf('create or replace function public.activate_native_roulette_draft_v3');
const activateEnd=migration.indexOf('revoke all on function public.activate_native_roulette_draft_v3');
const activationBody=migration.slice(activateStart,activateEnd);
const checks={
  eventReplay:replay.passed,
  digitalTwin:digitalTwin.passed&&digitalTwin.runs===1000,
  retryStormGuard:activateStart>=0&&activateEnd>activateStart&&!/40001/i.test(activationBody)&&/return public\.activate_native_roulette_draft_v3/i.test(migration),
  rouletteResultOrdering:/animateRouletteNames\(payload,3000\)/.test(overlay)&&/await animateRouletteNames/.test(overlay),
  productionFunctionsUsed:replay.mode==='offline-production-function-replay',
  noProductionMutation:replay.safety.databaseWrites===false&&digitalTwin.safety.databaseWrites===false
};
let productionSmoke=null;
if(has('--production')){
  productionSmoke=await runProductionSmoke({baseUrl:arg('--base-url','https://byeollog.com'),rounds:arg('--rounds','2')});
  checks.productionSmoke=productionSmoke.passed;
}
const report={
  schemaVersion:1,mode:productionSmoke?'release-plus-production-smoke':'offline-release-gate',generatedAt:new Date().toISOString(),
  safety:{databaseWrites:false,productionDispatch:false,productionMutations:false},
  passed:Object.values(checks).every(Boolean),checks,replay,digitalTwin,productionSmoke
};
await mkdir(reportDirectory,{recursive:true});
const stamp=report.generatedAt.replace(/[:.]/g,'-');
const jsonPath=resolve(reportDirectory,`stability-${stamp}.json`),markdownPath=resolve(reportDirectory,`stability-${stamp}.md`);
await Promise.all([
  writeFile(jsonPath,JSON.stringify(report,null,2)+'\n','utf8'),
  writeFile(markdownPath,markdown(report),'utf8'),
  writeFile(resolve(reportDirectory,'latest.json'),JSON.stringify(report,null,2)+'\n','utf8'),
  writeFile(resolve(reportDirectory,'latest.md'),markdown(report),'utf8')
]);
process.stdout.write(`${JSON.stringify({passed:report.passed,mode:report.mode,checks:report.checks,report:jsonPath})}\n`);
process.exitCode=report.passed?0:1;
