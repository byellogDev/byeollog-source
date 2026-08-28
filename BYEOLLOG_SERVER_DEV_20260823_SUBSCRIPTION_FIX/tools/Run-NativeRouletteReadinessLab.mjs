#!/usr/bin/env node
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runNativeRouletteReadinessLab} from './native-roulette-readiness-lab.mjs';
import {renderNativeRouletteReadinessDashboard} from './native-roulette-readiness-dashboard.mjs';

function integer(value,label,min,max){
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<min||parsed>max)throw new Error(`${label} 범위가 올바르지 않습니다.`);
  return parsed;
}
function parseArgs(values){
  const options={
    reliabilityEvents:10_000,probabilitySpins:1_000_000,correlationCases:6_000,
    latencySamples:20_000,ttsIterations:5_000,seed:8282026,
    outputDirectory:resolve('..','output','native-roulette-readiness-lab')
  };
  for(let index=0;index<values.length;index++){
    const key=values[index];const value=values[index+1];
    if(key==='--events'){options.reliabilityEvents=integer(value,'events',100,200_000);index++}
    else if(key==='--probability-spins'){options.probabilitySpins=integer(value,'probability-spins',10_000,10_000_000);index++}
    else if(key==='--correlation-cases'){options.correlationCases=integer(value,'correlation-cases',60,100_000);index++}
    else if(key==='--latency-samples'){options.latencySamples=integer(value,'latency-samples',1_000,1_000_000);index++}
    else if(key==='--tts-iterations'){options.ttsIterations=integer(value,'tts-iterations',1_000,100_000);index++}
    else if(key==='--seed'){options.seed=integer(value,'seed',1,0xffff_ffff);index++}
    else if(key==='--output-dir'){
      if(!value||value.startsWith('--'))throw new Error('output-dir 경로가 필요합니다.');
      options.outputDirectory=resolve(value);index++;
    }else if(key==='--help'){
      console.log('Usage: node tools/Run-NativeRouletteReadinessLab.mjs [--events 10000] [--probability-spins 1000000] [--correlation-cases 6000] [--latency-samples 20000] [--tts-iterations 5000] [--seed 8282026] [--output-dir path]');
      process.exit(0);
    }else throw new Error(`알 수 없는 인자입니다: ${key}`);
  }
  return options;
}

const options=parseArgs(process.argv.slice(2));
const {outputDirectory,...runOptions}=options;
const report=runNativeRouletteReadinessLab(runOptions);
const jsonPath=resolve(outputDirectory,'report.json');
const htmlPath=resolve(outputDirectory,'index.html');
await mkdir(outputDirectory,{recursive:true});
await Promise.all([
  writeFile(jsonPath,`${JSON.stringify(report,null,2)}\n`,'utf8'),
  writeFile(htmlPath,renderNativeRouletteReadinessDashboard(report),'utf8')
]);
console.log(`NATIVE_ROULETTE_READINESS_${report.status}`);
console.log(`score=${report.readinessScore} checks=${Object.values(report.checks).filter(Boolean).length}/${Object.keys(report.checks).length}`);
console.log(`probabilitySpins=${report.reliability.probabilitySpins} maxZ=${report.reliability.probability.maxAbsoluteZ.toFixed(4)}`);
console.log(`soopCases=${report.correlation.caseCount} followups=${report.correlation.summary.stats.followupsCaptured} reordered=${report.correlation.summary.stats.reorderedRecovered}`);
console.log(`overlayP95=${report.pipeline.metrics.donationToOverlayMs.p95}ms dynamicChatP95=${report.pipeline.metrics.chatArrivalToFirstAudioMs.p95}ms`);
console.log(`report=${jsonPath}`);
console.log(`dashboard=${htmlPath}`);
if(!report.passed)process.exitCode=1;
