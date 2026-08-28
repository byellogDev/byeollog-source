import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  DeterministicRng,
  NativeRouletteReliabilitySimulator,
  runNativeRouletteReliabilitySuite
} from '../tools/native-roulette-reliability-core.mjs';

const testDirectory=path.dirname(fileURLToPath(import.meta.url));

test('simulator source is statically isolated from production and external I/O',()=>{
  const sourceFiles=[
    '../tools/native-roulette-reliability-core.mjs',
    '../tools/Simulate-NativeRouletteReliability.mjs'
  ];
  const forbiddenPatterns=[
    /@supabase/i,
    /\bfetch\s*\(/,
    /\bhttps?:\/\//i,
    /\bprocess\.env\b/,
    /node:(?:http|https|net|tls|dgram|child_process)/,
    /\b(?:exec|spawn|fork)Sync?\s*\(/
  ];
  for(const relativePath of sourceFiles){
    const source=fs.readFileSync(path.resolve(testDirectory,relativePath),'utf8');
    for(const pattern of forbiddenPatterns){
      assert.doesNotMatch(source,pattern,`${relativePath} must not contain ${pattern}`);
    }
  }
});

test('reliability simulator is deterministic and never contacts external systems',()=>{
  const first=runNativeRouletteReliabilitySuite({eventCount:400,probabilitySpins:20_000,seed:8272026});
  const second=runNativeRouletteReliabilitySuite({eventCount:400,probabilitySpins:20_000,seed:8272026});
  assert.equal(first.mode,'offline-memory-only');
  assert.equal(first.operatingSystemImpact,'no-network-no-database-no-deployment');
  assert.deepEqual({...first,elapsedMs:0},{...second,elapsedMs:0});
  assert.equal(first.passed,true);
});

test('unbiased PPM sampler never emits an out-of-range value',()=>{
  const rng=new DeterministicRng(1);
  for(let index=0;index<100_000;index++){
    const sample=rng.samplePpm();
    assert.ok(sample>=0&&sample<1_000_000);
  }
});

test('all deterministic bounded helpers use rejection sampling instead of biased modulo',()=>{
  const rng=new DeterministicRng(1);
  for(const width of [3,7,10,997,1_000_000]){
    for(let index=0;index<10_000;index++){
      const sample=rng.integer(0,width-1);
      assert.ok(sample>=0&&sample<width);
    }
  }
});

test('snapshot restoration preserves committed delivery idempotency',()=>{
  let simulator=new NativeRouletteReliabilitySimulator({seed:77});
  simulator.ingest({
    eventId:'restart-event',actor:{id:'viewer',name:'시청자'},amount:30,
    occurredAt:'2026-08-27T00:00:00.000Z'
  });
  const [job]=simulator.claim('before-restart',{limit:1});
  simulator.deliver(job.id,'before-restart',{mode:'crash_after_commit'});
  simulator=new NativeRouletteReliabilitySimulator({snapshot:simulator.snapshot()});
  simulator.advance(45_001);
  const [reclaimed]=simulator.claim('after-restart',{limit:1});
  simulator.deliver(reclaimed.id,'after-restart');
  const summary=simulator.summary();
  assert.equal(summary.deliveryLedger,1);
  assert.equal(summary.metrics.automationExecutions+summary.metrics.directUpboExecutions,1);
  assert.equal(summary.metrics.duplicateDeliveriesSuppressed,1);
  assert.equal(summary.outbox.succeeded,1);
});

test('full local suite covers probability, duplicates, disorder, restart, cache, and retry exhaustion',()=>{
  const report=runNativeRouletteReliabilitySuite({eventCount:2_000,probabilitySpins:100_000,seed:20260827});
  assert.equal(report.passed,true);
  assert.ok(report.restart.summary.metrics.crashBeforeCommit>0);
  assert.ok(report.restart.summary.metrics.crashAfterCommit>0);
  assert.ok(report.restart.summary.metrics.cacheMisses>0);
  assert.ok(report.restart.summary.metrics.duplicateDeliveriesSuppressed>0);
  assert.equal(report.retryExhaustion.outbox.failed,1);
});
