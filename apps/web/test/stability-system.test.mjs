import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {runStabilityEventReplay} from '../tools/stability-event-replay-core.mjs';
import {runProductionSmoke} from '../tools/Run-ProductionSmoke.mjs';
import {auditSupabaseRuntimePressure} from '../tools/Audit-SupabaseRuntimePressure.mjs';

const root=new URL('../',import.meta.url);

test('stability replay exercises production normalizers and exactly-once boundaries',async()=>{
  const fixture=JSON.parse(await readFile(new URL('stability/fixtures/soop-event-replay-v1.json',root),'utf8'));
  const report=await runStabilityEventReplay(fixture);
  assert.equal(fixture.events.length,6);
  assert.equal(report.passed,true);
  assert.deepEqual(report.safety,{networkRequests:false,databaseWrites:false,productionDispatch:false});
  assert.equal(report.summary.dispatchCount,2);
  assert.equal(report.summary.duplicateCount,1);
  assert.equal(report.summary.identityConflictCount,1);
  assert.equal(report.summary.subscriptionCount,1);
  assert.ok(report.timeline.filter(item=>item.stage==='roulette_dispatched').every(item=>item.traceId&&item.result===item.ttsText));
});

test('production smoke is read-only and fails closed on a server error',async()=>{
  const okFetch=async url=>{
    const path=new URL(url).pathname;
    if(path==='/dashboard/signatures')return new Response('',{status:302,headers:{location:'/login?expired=1'}});
    if(path==='/dashboard/wallpaper')return new Response('',{status:307,headers:{location:'/dashboard/signatures'}});
    if(path==='/api/auth/soop/roulette-overlay/poll')return new Response('',{status:404});
    if(path==='/agent-updates/stable/win-x64.json')return Response.json({version:'0.7.0.141',sequence:7141,signature:'signed'});
    if(path==='/agent/download')return new Response('',{status:302,headers:{location:'https://example.invalid/installer.exe'}});
    return new Response('ok',{status:200});
  };
  const healthy=await runProductionSmoke({baseUrl:'http://127.0.0.1:3000',rounds:1,fetchImpl:okFetch});
  assert.equal(healthy.passed,true);
  assert.deepEqual(healthy.safety.methods,['GET']);
  assert.equal(healthy.safety.productionMutations,false);
  const broken=await runProductionSmoke({baseUrl:'http://127.0.0.1:3000',rounds:1,fetchImpl:async()=>new Response('',{status:500})});
  assert.equal(broken.passed,false);
  assert.equal(broken.summary.failed,7);
});

test('Supabase pressure audit detects a retry storm without writing to the database',async()=>{
  const values=[
    {activationCallsTotal:18,longRunningActive:0,lockWaiters:0},
    {activationCallsTotal:18,longRunningActive:0,lockWaiters:0}
  ];
  const healthy=await auditSupabaseRuntimePressure({intervalSeconds:1,sampleImpl:async()=>values.shift(),sleepImpl:callback=>callback()});
  assert.equal(healthy.status,'healthy');
  assert.equal(healthy.activationDelta,0);
  assert.equal(healthy.safety.databaseWrites,false);
  const storm=[
    {activationCallsTotal:20,longRunningActive:0,lockWaiters:0},
    {activationCallsTotal:500,longRunningActive:0,lockWaiters:0}
  ];
  const critical=await auditSupabaseRuntimePressure({intervalSeconds:1,sampleImpl:async()=>storm.shift(),sleepImpl:callback=>callback()});
  assert.equal(critical.status,'critical');
  assert.equal(critical.passed,false);
});

test('CI runs the stability gate on the active release branch and smokes production after all suites',async()=>{
  const [workflow,pkg,gate,smoke,deploy]=await Promise.all([
    readFile(new URL('../.github/workflows/ci.yml',root),'utf8'),
    readFile(new URL('package.json',root),'utf8'),
    readFile(new URL('tools/Run-StabilityGate.mjs',root),'utf8'),
    readFile(new URL('tools/Run-ProductionSmoke.mjs',root),'utf8'),
    readFile(new URL('tools/Deploy-Production.mjs',root),'utf8')
  ]);
  assert.match(workflow,/codex\/public-release-v071/);
  assert.match(workflow,/npm run stability:gate/);
  assert.match(workflow,/needs: \[server, agent, auxiliary\]/);
  assert.match(workflow,/npm run stability:smoke/);
  const scripts=JSON.parse(pkg).scripts;
  assert.equal(scripts['stability:replay'],'node tools/Run-StabilityEventReplay.mjs');
  assert.match(scripts['stability:gate'],/Run-StabilityGate/);
  assert.equal(scripts['deploy:production'],'node tools/Deploy-Production.mjs');
  assert.match(deploy,/npm_execpath/);
  assert.match(deploy,/\['deploy','--prod','--skip-domain','--yes','--json'\]/);
  assert.match(deploy,/\['promote',url,'--yes'\]/);
  assert.match(deploy,/isDeepStrictEqual\(remotePublicMetadata,localPublicMetadata\)/);
  assert.match(deploy,/\/release-manifest\.json/);
  assert.doesNotMatch(deploy,/\['vercel','deploy','--prebuilt'/);
  assert.match(deploy,/shell:false/);
  assert.doesNotMatch(gate,/vercel\s+deploy|supabase\s+db\s+push|method:\s*['"](?:POST|PATCH|DELETE)/i);
  assert.doesNotMatch(smoke,/method:\s*['"](?:POST|PATCH|DELETE)/i);
});
