import {auditURL as _auditURL} from '../resolve-source.mjs';
const auditURL=(value,base)=>_auditURL(value,base,"admin-runtime");
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  NATIVE_ROULETTE_TWIN_SCENARIOS,
  NATIVE_ROULETTE_TWIN_SPIN_DURATION_MS,
  runNativeRouletteTwinCampaign,
  runNativeRouletteTwinScenario
} from '../../test-support/frontend/tools/native-roulette-digital-twin-core.mjs';
import {NativeRouletteTwinRuntime,startNativeRouletteTwinServer} from '../../test-support/frontend/tools/Run-NativeRouletteDigitalTwin.mjs';
import {renderNativeRouletteTwinController,renderNativeRouletteTwinOverlay} from '../../test-support/frontend/tools/native-roulette-digital-twin-ui.mjs';

test('all digital twin scenarios preserve their broadcast invariants',()=>{
  assert.equal(NATIVE_ROULETTE_TWIN_SCENARIOS.length,8);
  for(const scenario of NATIVE_ROULETTE_TWIN_SCENARIOS){
    const report=runNativeRouletteTwinScenario({scenarioId:scenario.id,seed:20260828});
    assert.equal(report.mode,'local-digital-twin');
    assert.equal(report.verification.passed,true,scenario.id);
    assert.deepEqual(Object.values(report.verification.checks),new Array(8).fill(true));
    assert.deepEqual(report.safety,{bindAddress:'127.0.0.1',networkRequests:false,databaseWrites:false,productionDispatch:false});
  }
});

test('every presented roulette uses exactly three seconds and cached result TTS follows reveal',()=>{
  for(const scenario of NATIVE_ROULETTE_TWIN_SCENARIOS){
    const {timeline}=runNativeRouletteTwinScenario({scenarioId:scenario.id,seed:17});
    for(const start of timeline.filter(item=>item.kind==='roulette.start')){
      const result=timeline.find(item=>item.kind==='roulette.result'&&item.data.spinIndex===start.data.spinIndex);
      assert.ok(result);
      assert.equal(result.atMs-start.atMs,NATIVE_ROULETTE_TWIN_SPIN_DURATION_MS);
      const tts=timeline.find(item=>['tts.result','tts.fallback'].includes(item.kind)&&(item.data.spinIndex??0)===start.data.spinIndex);
      assert.ok(tts);
      assert.ok(tts.atMs>=result.atMs);
    }
  }
});

test('reversed SDK delivery is explicitly buffered then correlated by occurrence metadata',()=>{
  const report=runNativeRouletteTwinScenario({scenarioId:'reversed-delivery',seed:8});
  const kinds=report.timeline.map(item=>item.kind);
  assert.ok(kinds.indexOf('soop.chat')<kinds.indexOf('soop.donation'));
  assert.ok(kinds.indexOf('correlation.buffered')<kinds.indexOf('correlation.matched'));
  const matched=report.timeline.find(item=>item.kind==='correlation.matched');
  assert.equal(matched.data.reordered,true);
  const chatTts=report.timeline.find(item=>item.kind==='tts.chat');
  assert.equal(/^\[\d+초전\]/.test(chatTts.title),false);
});

test('direct upbo omits roulette, TTS, and action presentation paths',()=>{
  const report=runNativeRouletteTwinScenario({scenarioId:'direct-upbo'});
  const kinds=new Set(report.timeline.map(item=>item.kind));
  assert.ok(kinds.has('roulette.direct_upbo'));
  for(const forbidden of ['roulette.start','roulette.result','tts.result','action.dispatch','agent.ack'])assert.equal(kinds.has(forbidden),false);
});

test('fault scenarios recover without a second visible execution',()=>{
  for(const id of ['agent-disconnect','obs-restart','tts-failure']){
    const report=runNativeRouletteTwinScenario({scenarioId:id,seed:99});
    assert.equal(report.verification.passed,true);
    assert.equal(report.timeline.filter(item=>item.kind==='roulette.result').length,1);
    assert.ok(report.timeline.some(item=>['agent.online','obs.online','tts.fallback'].includes(item.kind)));
  }
  const agent=runNativeRouletteTwinScenario({scenarioId:'agent-disconnect'});
  assert.equal(agent.timeline.filter(item=>item.kind==='agent.ack').length,1);
  assert.equal(agent.timeline.find(item=>item.kind==='agent.ack').data.retryCount,1);
  const obs=runNativeRouletteTwinScenario({scenarioId:'obs-restart'});
  assert.equal(obs.timeline.find(item=>item.kind==='overlay.recovered').data.replayed,false);
});

test('campaign stress run is deterministic and production isolated',()=>{
  const first=runNativeRouletteTwinCampaign({runsPerScenario:125,seed:77});
  const second=runNativeRouletteTwinCampaign({runsPerScenario:125,seed:77});
  assert.deepEqual(first,second);
  assert.equal(first.passed,true);
  assert.equal(first.runs,1_000);
  assert.equal(first.failures.length,0);
  assert.equal(first.assetContract.count,7);
  assert.equal(first.assetContract.allPublished,true);
  assert.deepEqual(first.safety,{networkRequests:false,databaseWrites:false,productionDispatch:false});
});

test('controller and transparent overlay are self-contained local documents',()=>{
  const controller=renderNativeRouletteTwinController({port:17261});
  const overlay=renderNativeRouletteTwinOverlay();
  assert.match(controller,/별록 방송 디지털 트윈/);
  assert.match(controller,/OBS 투명 오버레이 미리보기/);
  assert.match(controller,/로컬 서버 종료/);
  assert.match(controller,/127\.0\.0\.1:17261\/overlay\?audio=1/);
  assert.match(overlay,/background:transparent/);
  assert.match(overlay,/new EventSource\('\/api\/events'\)/);
  assert.match(overlay,/animation:spinPulse 3s/);
  assert.match(overlay,/roulette-animation/);
  assert.match(overlay,/function restoreSnapshot/);
  assert.match(overlay,/style\.animationDelay/);
  for(const html of [controller,overlay]){
    assert.doesNotMatch(html,/https?:\/\/(?!127\.0\.0\.1)/);
    assert.doesNotMatch(html,/byeollog\.com|supabase|vercel/i);
  }
});

test('runtime emits ordered snapshots and completes the selected scenario once',async()=>{
  const runtime=new NativeRouletteTwinRuntime({seed:1});
  runtime.run({scenarioId:'direct-upbo',speed:10});
  await new Promise(resolve=>setTimeout(resolve,180));
  const state=runtime.snapshot();
  assert.equal(state.running,false);
  assert.equal(state.completed,true);
  assert.equal(state.passed,true);
  assert.equal(state.events.filter(item=>item.kind==='scenario.complete').length,1);
  assert.equal(state.events.filter(item=>item.kind==='roulette.direct_upbo').length,1);
  runtime.reset();
});

test('HTTP surface binds to loopback, serves immutable assets, and rejects foreign origins',async t=>{
  const port=18_761;
  const app=await startNativeRouletteTwinServer({port,seed:2});
  t.after(()=>new Promise(resolve=>app.server.close(resolve)));
  const base=`http://127.0.0.1:${port}`;
  const health=await fetch(`${base}/api/health`);
  assert.equal(health.status,200);
  assert.deepEqual(await health.json(),{ok:true,mode:'local-digital-twin',productionDispatch:false});
  const controller=await fetch(`${base}/`);
  assert.equal(controller.status,200);
  assert.match(controller.headers.get('content-security-policy'),/default-src 'self'/);
  assert.match(await controller.text(),/방송 시나리오/);
  const preview=await fetch(`${base}/assets/roulette-preview/roulette_navy_gold_v1.webp`);
  assert.equal(preview.status,200);
  assert.equal(preview.headers.get('content-type'),'image/webp');
  const bytes=Buffer.from(await preview.arrayBuffer());
  assert.equal(bytes.length,61_282);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),'2c4f45de0b1d4928bf08aaa8cd62f1869e57d25bcaa25a09ca8f0556e9a3ae71');
  const animation=await fetch(`${base}/assets/roulette-animation/roulette_navy_gold_v1.webp`);
  assert.equal(animation.status,200);
  assert.equal(animation.headers.get('content-type'),'image/webp');
  const animationBytes=Buffer.from(await animation.arrayBuffer());
  const mode=animation.headers.get('x-byeollog-asset-mode');
  assert.ok(['full-animation','reviewed-preview-fallback'].includes(mode));
  if(mode==='full-animation'){
    assert.equal(animationBytes.length,5_686_510);
    assert.equal(crypto.createHash('sha256').update(animationBytes).digest('hex'),'5a0bf920ed23fd26fa08672b9d114e03dda503dd05aac8deaedea135da9c2b13');
  }else{
    assert.equal(animationBytes.length,61_282);
    assert.equal(crypto.createHash('sha256').update(animationBytes).digest('hex'),'2c4f45de0b1d4928bf08aaa8cd62f1869e57d25bcaa25a09ca8f0556e9a3ae71');
  }
  const rejected=await fetch(`${base}/api/reset`,{method:'POST',headers:{origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'});
  assert.equal(rejected.status,403);
  const invalid=await fetch(`${base}/api/run`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenarioId:'unknown',speed:1})});
  assert.equal(invalid.status,400);
});

test('server source has no production clients and CLI artifacts stay outside source deployment',async()=>{
  const [source,launcher,ignore,packageJson]=await Promise.all([
    readFile(auditURL('../tools/Run-NativeRouletteDigitalTwin.mjs',import.meta.url),'utf8'),
    readFile(auditURL('../tools/Start-NativeRouletteDigitalTwin.ps1',import.meta.url),'utf8'),
    readFile(auditURL('../.vercelignore',import.meta.url),'utf8'),
    readFile(auditURL('../package.json',import.meta.url),'utf8')
  ]);
  assert.match(source,/const HOST='127\.0\.0\.1'/);
  assert.match(source,/resolve\(repoDir,'\.\.','output','native-roulette-digital-twin'\)/);
  assert.match(source,/reviewed-preview-fallback/);
  assert.doesNotMatch(source,/@supabase|supabaseClient|byeollog\.com|fetch\(/i);
  assert.match(source,/\/api\/shutdown/);
  assert.match(launcher,/WindowStyle Hidden/);
  assert.match(launcher,/\[switch\]\$NoBrowser/);
  assert.match(launcher,/127\.0\.0\.1/);
  assert.match(launcher,/local-digital-twin/);
  assert.doesNotMatch(launcher,/byeollog\.com|supabase|vercel/i);
  for(const path of [
    'tools/native-roulette-digital-twin-core.mjs','tools/native-roulette-digital-twin-ui.mjs',
    'tools/Run-NativeRouletteDigitalTwin.mjs','tools/Start-NativeRouletteDigitalTwin.ps1',
    'docs/NATIVE_ROULETTE_DIGITAL_TWIN_20260828_KO.md'
  ])assert.match(ignore,new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'m'));
  const pkg=JSON.parse(packageJson);
  assert.equal(pkg.scripts['twin:roulette'],'node tools/Run-NativeRouletteDigitalTwin.mjs');
  assert.match(pkg.scripts['test:roulette-twin'],/--headless --runs 1000/);
});
