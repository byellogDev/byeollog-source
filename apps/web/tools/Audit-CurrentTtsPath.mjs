#!/usr/bin/env node
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';

const sourcePath=new URL('../lib/soop-roulette-service.js',import.meta.url);
const source=await readFile(sourcePath,'utf8');
const pollMatch=source.match(/setTimeout\(poll,(\d+)\)/);
const pollIntervalMs=Number(pollMatch?.[1]||0);
const pollingLatency=pollIntervalMs?{
  best:0,
  mean:pollIntervalMs/2,
  p95:Math.round(pollIntervalMs*.95),
  worst:pollIntervalMs
}:null;
const report={
  schemaVersion:1,generatedAt:new Date().toISOString(),path:'common OBS overlay production client',
  findings:{
    commandTransport:pollIntervalMs?{kind:'http-polling',idleIntervalMs:pollIntervalMs,theoreticalAddedLatencyMs:pollingLatency}:{kind:'unknown'},
    synthesisEngine:{kind:source.includes('SpeechSynthesisUtterance')?'browser-speechSynthesis':'unknown',providerControlledVoice:false,streamingPcm:false,measuredTtfa:false},
    resultPreparation:{preGeneratedAudioUsedByOverlay:false,observedTextFallback:source.includes("p.ttsText||((p.resultText||'')+', 당첨!')")},
    chatOrdering:{donationChatCommand:source.includes("command.kind==='donation_chat_tts'"),displayTimeExcludedFromTts:source.includes('p.ttsText||p.message')},
    playback:{audioWorklet:source.includes('AudioWorklet'),jitterBuffer:false,gaplessQueue:false}
  },
  releaseBlockers:[
    '브라우저·운영체제마다 음색과 발음이 달라 동일 방송 품질을 보장할 수 없습니다.',
    pollIntervalMs
      ? `명령 폴링만으로 평균 약 ${pollingLatency.mean}ms, p95 약 ${pollingLatency.p95}ms의 대기시간이 추가될 수 있습니다.`
      : '명령 수신 지연을 현재 소스에서 자동 산출할 수 없습니다.',
    '첫 음성 조각과 실제 재생 시작 시각이 계측되지 않습니다.',
    'PCM 스트리밍·지터 버퍼·공급자 장애 전환이 없습니다.'
  ]
};
const output=resolve(process.argv[2]||'output/tts-phase1/current-path-baseline.json');
await mkdir(dirname(output),{recursive:true});
await writeFile(output,JSON.stringify(report,null,2)+'\n','utf8');
console.log(`TTS_CURRENT_PATH_AUDIT_COMPLETE\nreport=${output}`);
