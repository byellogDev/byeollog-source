#!/usr/bin/env node
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {runNativeRouletteReliabilitySuite} from './native-roulette-reliability-core.mjs';

function parseInteger(value,label,min,max){
  const number=Number(value);
  if(!Number.isSafeInteger(number)||number<min||number>max)throw new Error(`${label} 범위가 올바르지 않습니다.`);
  return number;
}

function parseArgs(values){
  const options={eventCount:10_000,probabilitySpins:500_000,seed:8272026,jsonOutput:null};
  for(let index=0;index<values.length;index++){
    const key=values[index];const value=values[index+1];
    if(key==='--events'){options.eventCount=parseInteger(value,'events',100,200_000);index++}
    else if(key==='--probability-spins'){options.probabilitySpins=parseInteger(value,'probability-spins',10_000,10_000_000);index++}
    else if(key==='--seed'){options.seed=parseInteger(value,'seed',1,0xffff_ffff);index++}
    else if(key==='--json-output'){
      if(!value||value.startsWith('--'))throw new Error('json-output 경로가 필요합니다.');
      options.jsonOutput=resolve(value);index++;
    }else if(key==='--help'){
      console.log('Usage: node tools/Simulate-NativeRouletteReliability.mjs [--events 10000] [--probability-spins 500000] [--seed 8272026] [--json-output path]');
      process.exit(0);
    }else throw new Error(`알 수 없는 인자입니다: ${key}`);
  }
  return options;
}

const options=parseArgs(process.argv.slice(2));
const report=runNativeRouletteReliabilitySuite(options);
const pass=report.passed?'PASS':'FAIL';
console.log(`NATIVE_ROULETTE_RELIABILITY_${pass}`);
console.log(`mode=${report.mode} events=${report.eventCount} probabilitySpins=${report.probabilitySpins} seed=${report.seed}`);
console.log(`maxProbabilityZ=${report.probability.maxAbsoluteZ.toFixed(4)} delivered=${report.restart.summary.deliveryLedger}/${report.restart.expectedSpins}`);
console.log(`duplicates=${report.restart.summary.metrics.duplicates} suppressed=${report.restart.summary.metrics.duplicateDeliveriesSuppressed} retries=${report.restart.summary.metrics.retries}`);
for(const [name,value] of Object.entries(report.checks))console.log(`${value?'PASS':'FAIL'} ${name}`);
console.log(`elapsedMs=${report.elapsedMs}`);
if(options.jsonOutput){
  await mkdir(dirname(options.jsonOutput),{recursive:true});
  await writeFile(options.jsonOutput,`${JSON.stringify(report,null,2)}\n`,'utf8');
  console.log(`report=${options.jsonOutput}`);
}
if(!report.passed)process.exitCode=1;
