import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  SyntheticSoopCorrelationLab,
  latencySummary,
  runNativeRouletteReadinessLab
} from '../tools/native-roulette-readiness-lab.mjs';
import {renderNativeRouletteReadinessDashboard} from '../tools/native-roulette-readiness-dashboard.mjs';

function donation(overrides={}){
  return {kind:'donation',payload:{
    eventId:'donation-1',actor:{id:'viewer',name:'시청자'},amount:30,message:null,
    occurredAt:'2026-08-28T00:00:00.000Z',...overrides
  }};
}
function chat(overrides={}){
  return {kind:'chat',payload:{
    eventId:'chat-1',actor:{id:'viewer',name:'시청자'},message:'딸깍',
    occurredAt:'2026-08-28T00:00:09.800Z',...overrides
  }};
}

test('readiness lab remains deterministic, offline, and production-isolated',()=>{
  const options={reliabilityEvents:400,probabilitySpins:20_000,correlationCases:120,
    latencySamples:1_000,ttsIterations:1_000,seed:20260828};
  const first=runNativeRouletteReadinessLab(options);
  const second=runNativeRouletteReadinessLab(options);
  assert.equal(first.mode,'offline-readiness-lab');
  assert.equal(first.operatingSystemImpact,'no-network-no-database-no-deployment');
  const canonical=value=>{
    const copy=structuredClone(value);copy.generatedAt='';copy.elapsedMs=0;copy.reliability.elapsedMs=0;return copy;
  };
  assert.deepEqual(canonical(first),canonical(second));
  assert.equal(first.status,'CONDITIONAL_PASS');
  assert.equal(first.readinessScore,90);
});

test('out-of-order first chat is recovered and spoken text excludes elapsed display prefix',()=>{
  const lab=new SyntheticSoopCorrelationLab();
  const base=Date.parse('2026-08-28T00:00:00.000Z');
  lab.ingest(chat(),base+10);
  lab.ingest(donation(),base+500);
  const report=lab.finish(base+20_000);
  assert.equal(report.stats.reorderedRecovered,1);
  assert.equal(report.stats.followupsCaptured,1);
  assert.equal(report.dispatches[0].displayText,'[10초전] 시청자 : 딸깍');
  assert.equal(report.dispatches[0].ttsText,'딸깍');
  assert.equal(report.dispatches[0].spokenTimestamp,false);
  assert.ok(report.dispatches[0].scheduledAtMs>=report.dispatches[0].resultReadyAtMs);
});

test('donation message is queued after all roulette results and never arms a second chat',()=>{
  const lab=new SyntheticSoopCorrelationLab();
  const base=Date.parse('2026-08-28T00:00:00.000Z');
  lab.ingest(donation({amount:90,message:'후원과 함께 보낸 말'}),base);
  lab.ingest(chat({occurredAt:'2026-08-28T00:00:01.000Z'}),base+1_000);
  const report=lab.finish(base+20_000);
  assert.equal(report.stats.donationMessages,1);
  assert.equal(report.stats.followupsCaptured,0);
  assert.equal(report.dispatches.length,1);
  assert.equal(report.dispatches[0].ttsText,'후원과 함께 보낸 말');
  assert.equal(report.dispatches[0].scheduledAtMs,base+9_000);
});

test('exact window boundary is accepted while one millisecond late chat is rejected',()=>{
  const base=Date.parse('2026-08-28T00:00:00.000Z');
  const accepted=new SyntheticSoopCorrelationLab();
  accepted.ingest(donation(),base);
  accepted.ingest(chat({occurredAt:'2026-08-28T00:00:10.000Z'}),base+10_000);
  assert.equal(accepted.finish(base+30_000).stats.followupsCaptured,1);
  const rejected=new SyntheticSoopCorrelationLab();
  rejected.ingest(donation(),base);
  rejected.ingest(chat({occurredAt:'2026-08-28T00:00:10.001Z'}),base+10_001);
  const result=rejected.finish(base+30_000);
  assert.equal(result.stats.followupsCaptured,0);
  assert.ok(result.stats.outsideWindow>=1);
});

test('duplicate and identity-changing SOOP events never create another dispatch',()=>{
  const lab=new SyntheticSoopCorrelationLab();
  const base=Date.parse('2026-08-28T00:00:00.000Z');
  lab.ingest(donation({message:'한 번'}),base);
  lab.ingest(donation({message:'한 번'}),base+1);
  assert.throws(()=>lab.ingest(donation({message:'변조'}),base+2),error=>error.code==='event_identity_changed');
  const report=lab.summary();
  assert.equal(report.dispatches.length,1);
  assert.equal(report.stats.duplicates,1);
  assert.equal(report.stats.identityConflicts,1);
});

test('latency summaries use upper-rank percentiles without hiding tail latency',()=>{
  const result=latencySummary([1,2,3,4,100]);
  assert.equal(result.p50,3);
  assert.equal(result.p95,100);
  assert.equal(result.p99,100);
  assert.equal(result.max,100);
});

test('full readiness report covers all five gates and explicit external blockers',()=>{
  const report=runNativeRouletteReadinessLab({
    reliabilityEvents:2_000,probabilitySpins:100_000,correlationCases:600,
    latencySamples:5_000,ttsIterations:2_000,seed:77
  });
  assert.equal(report.passed,true);
  assert.deepEqual(Object.values(report.checks),[true,true,true,true,true]);
  assert.equal(report.faults.scenarios.length,6);
  assert.ok(report.faults.scenarios.every(item=>item.lostEvents===0&&item.visibleExecutions===1));
  assert.equal(report.tts.requiresRealProviderBenchmark,true);
  assert.equal(report.releaseBlockers.length,3);
  assert.ok(report.correlation.summary.dispatchCount>20);
  assert.equal(report.correlation.summary.dispatchSamples.length,20);
  assert.equal('dispatches' in report.correlation.summary,false);
});

test('dashboard is self-contained, readable, and escapes report-controlled text',()=>{
  const report=runNativeRouletteReadinessLab({
    reliabilityEvents:200,probabilitySpins:10_000,correlationCases:60,
    latencySamples:1_000,ttsIterations:1_000,seed:9
  });
  report.releaseBlockers.push('<script>alert(1)</script>');
  const html=renderNativeRouletteReadinessDashboard(report);
  assert.match(html,/Native Roulette Readiness/);
  assert.match(html,/3초 룰렛 시간 예산/);
  assert.match(html,/SOOP 후원·채팅 결합/);
  assert.match(html,/장애 주입 결과/);
  assert.match(html,/합성 모델/);
  assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('optional real TTS benchmark is loopback-only and never prints its secret',async()=>{
  const source=await readFile(new URL('../tools/Benchmark-NativeRouletteTtsEndpoint.mjs',import.meta.url),'utf8');
  assert.match(source,/127\.0\.0\.1/);
  assert.match(source,/localhost/);
  assert.match(source,/실측 도구는 방송 경로 보호를 위해 로컬 HTTP TTS 주소만 허용/);
  assert.doesNotMatch(source,/console\.log\(\s*secret\b/i);
  assert.doesNotMatch(source,/console\.log\([^\n]*\$\{secret\}/i);
  assert.match(source,/완성 WAV 응답 시간이며 스트리밍 첫 PCM 조각 TTFA가 아닙니다/);
});

test('CLI defaults to an out-of-source report directory and writes JSON plus HTML',async()=>{
  const [source,ignore]=await Promise.all([
    readFile(new URL('../tools/Run-NativeRouletteReadinessLab.mjs',import.meta.url),'utf8'),
    readFile(new URL('../.vercelignore',import.meta.url),'utf8')
  ]);
  assert.match(source,/resolve\('\.\.','output','native-roulette-readiness-lab'\)/);
  assert.match(source,/report\.json/);
  assert.match(source,/index\.html/);
  assert.match(source,/NATIVE_ROULETTE_READINESS_/);
  for(const path of [
    'tools/native-roulette-readiness-lab.mjs','tools/native-roulette-readiness-dashboard.mjs',
    'tools/Run-NativeRouletteReadinessLab.mjs','tools/Benchmark-NativeRouletteTtsEndpoint.mjs',
    'docs/NATIVE_ROULETTE_READINESS_LAB_20260828_KO.md'
  ])assert.match(ignore,new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}$`,'m'));
});
