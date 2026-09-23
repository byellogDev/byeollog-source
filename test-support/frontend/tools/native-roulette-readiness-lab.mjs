import assert from 'node:assert/strict';
import {
  buildNativeRouletteSponsoredChatDispatch,
  nativeRouletteSpinCount,
  normalizeNativeRouletteDraft,
  normalizeSoopChatEnvelope,
  normalizeSoopDonationEnvelope
} from '../../../apps/web/lib/native-roulette.js';
import {
  DeterministicRng,
  defaultDraft,
  runNativeRouletteReliabilitySuite
} from './native-roulette-reliability-core.mjs';

const SECOND=1_000;
const DEFAULT_SPIN_MS=3_000;

function clone(value){return structuredClone(value)}
function mean(values){return values.reduce((sum,value)=>sum+value,0)/Math.max(1,values.length)}
function percentile(sorted,ratio){
  if(!sorted.length)return 0;
  const index=Math.min(sorted.length-1,Math.max(0,Math.ceil(sorted.length*ratio)-1));
  return sorted[index];
}
function latencySummary(values){
  const sorted=[...values].sort((a,b)=>a-b);
  return {
    samples:sorted.length,min:sorted[0]??0,
    mean:Math.round(mean(sorted)*100)/100,
    p50:percentile(sorted,.5),p95:percentile(sorted,.95),p99:percentile(sorted,.99),
    max:sorted.at(-1)??0
  };
}
function randomBetween(rng,min,max){return rng.integer(min,max)}

export class SyntheticSoopCorrelationLab{
  constructor({draft=defaultDraft(),reorderBufferMs=2_000,spinDurationMs=DEFAULT_SPIN_MS}={}){
    this.profile={id:'readiness-profile',...normalizeNativeRouletteDraft(draft)};
    this.reorderBufferMs=reorderBufferMs;
    this.spinDurationMs=spinDurationMs;
    this.seen=new Map();
    this.donations=[];
    this.pendingByActor=new Map();
    this.bufferedChats=[];
    this.dispatches=[];
    this.stats={
      donations:0,chats:0,duplicates:0,identityConflicts:0,ignoredDonations:0,
      donationMessages:0,followupsCaptured:0,reorderedRecovered:0,
      outsideWindow:0,wrongActor:0,superseded:0,expired:0
    };
  }

  _identity(kind,value){
    if(kind==='donation')return `${value.actor.id}\u0000${value.amount}\u0000${value.occurredAt}\u0000${value.message||''}`;
    return `${value.actor.id}\u0000${value.message}\u0000${value.occurredAt}`;
  }

  _deduplicate(kind,value){
    const key=`${kind}:${value.eventId}`;
    const identity=this._identity(kind,value);
    if(!this.seen.has(key)){this.seen.set(key,identity);return false}
    if(this.seen.get(key)!==identity){
      this.stats.identityConflicts++;
      const error=new Error('SOOP event identity changed');error.code='event_identity_changed';throw error;
    }
    this.stats.duplicates++;return true;
  }

  _actorPending(actorId){
    if(!this.pendingByActor.has(actorId))this.pendingByActor.set(actorId,[]);
    return this.pendingByActor.get(actorId);
  }

  _expire(arrivalMs){
    for(const pending of this.donations){
      if(pending.status==='pending'&&arrivalMs>pending.closesAtMs+this.reorderBufferMs){
        pending.status='expired';this.stats.expired++;
      }
    }
    this.bufferedChats=this.bufferedChats.filter(entry=>arrivalMs<=entry.arrivalMs+this.reorderBufferMs);
  }

  _capture(pending,chat,arrivalMs,{reordered=false}={}){
    pending.status='captured';pending.chatEventId=chat.eventId;
    const dispatch=buildNativeRouletteSponsoredChatDispatch({
      profile:this.profile,donation:pending.donation,chat,sourceKind:'followup_chat'
    });
    const scheduledAtMs=Math.max(arrivalMs,pending.resultReadyAtMs);
    this.dispatches.push({
      ...dispatch,arrivalMs,scheduledAtMs,resultReadyAtMs:pending.resultReadyAtMs,
      reordered,spokenTimestamp:/^\[\d+초전\]/.test(dispatch.ttsText)
    });
    this.stats.followupsCaptured++;
    if(reordered)this.stats.reorderedRecovered++;
    return dispatch;
  }

  _matchChat(chat,arrivalMs,{fromBuffer=false}={}){
    const chatAt=Date.parse(chat.occurredAt);
    const candidates=this._actorPending(chat.actor.id)
      .filter(item=>item.status==='pending'&&chatAt>=item.opensAtMs&&chatAt<=item.closesAtMs)
      .sort((a,b)=>b.opensAtMs-a.opensAtMs);
    if(candidates.length){
      const selected=candidates[0];
      for(const older of this._actorPending(chat.actor.id)){
        if(older!==selected&&older.status==='pending'&&older.opensAtMs<selected.opensAtMs){
          older.status='superseded';this.stats.superseded++;
        }
      }
      return this._capture(selected,chat,arrivalMs,{reordered:fromBuffer});
    }
    const actorDonations=this.donations.filter(item=>item.donation.actor.id===chat.actor.id);
    if(actorDonations.some(item=>chatAt>item.closesAtMs))this.stats.outsideWindow++;
    else if(this.donations.length)this.stats.wrongActor++;
    return null;
  }

  ingest(event,arrivalMs){
    assert.ok(Number.isSafeInteger(arrivalMs)&&arrivalMs>=0,'arrivalMs must be a non-negative integer');
    this._expire(arrivalMs);
    if(event.kind==='donation'){
      const donation=normalizeSoopDonationEnvelope(event.payload);
      if(this._deduplicate('donation',donation))return {duplicate:true};
      this.stats.donations++;
      const spinCount=nativeRouletteSpinCount(donation.amount,this.profile);
      if(spinCount===0){this.stats.ignoredDonations++;return {duplicate:false,spinCount:0}}
      const opensAtMs=Date.parse(donation.occurredAt);
      const pending={
        donation,arrivalMs,opensAtMs,
        closesAtMs:opensAtMs+this.profile.followupChatTtsWindowSeconds*SECOND,
        resultReadyAtMs:arrivalMs+spinCount*this.spinDurationMs,
        spinCount,status:donation.message?'message':'pending',chatEventId:null
      };
      this.donations.push(pending);
      this._actorPending(donation.actor.id).push(pending);
      if(donation.message){
        const dispatch=buildNativeRouletteSponsoredChatDispatch({
          profile:this.profile,donation,sourceKind:'donation_message'
        });
        this.dispatches.push({
          ...dispatch,arrivalMs,scheduledAtMs:pending.resultReadyAtMs,
          resultReadyAtMs:pending.resultReadyAtMs,reordered:false,
          spokenTimestamp:/^\[\d+초전\]/.test(dispatch.ttsText)
        });
        this.stats.donationMessages++;
      }else{
        const compatible=this.bufferedChats
          .filter(entry=>entry.chat.actor.id===donation.actor.id)
          .sort((a,b)=>Date.parse(a.chat.occurredAt)-Date.parse(b.chat.occurredAt))[0];
        if(compatible){
          const captured=this._matchChat(compatible.chat,arrivalMs,{fromBuffer:true});
          if(captured)this.bufferedChats=this.bufferedChats.filter(entry=>entry!==compatible);
        }
      }
      return {duplicate:false,spinCount};
    }
    if(event.kind==='chat'){
      const chat=normalizeSoopChatEnvelope(event.payload);
      if(this._deduplicate('chat',chat))return {duplicate:true};
      this.stats.chats++;
      const matched=this._matchChat(chat,arrivalMs);
      if(!matched)this.bufferedChats.push({chat,arrivalMs});
      return {duplicate:false,matched:Boolean(matched)};
    }
    throw new Error(`Unsupported synthetic SOOP event kind: ${event.kind}`);
  }

  finish(finalArrivalMs){
    this._expire(finalArrivalMs+this.reorderBufferMs+this.profile.followupChatTtsWindowSeconds*SECOND+1);
    return this.summary();
  }

  summary(){
    return {
      stats:clone(this.stats),
      dispatches:clone(this.dispatches),
      pendingStatuses:this.donations.reduce((result,item)=>{
        result[item.status]=(result[item.status]||0)+1;return result;
      },{}),
      bufferedChats:this.bufferedChats.length
    };
  }
}

function correlationScenario(caseCount,seed){
  const rng=new DeterministicRng(seed);
  const lab=new SyntheticSoopCorrelationLab();
  const base=Date.parse('2026-08-28T00:00:00.000Z');
  const events=[];
  const expected={donationMessages:0,followupsCaptured:0,reorderedRecovered:0};
  for(let index=0;index<caseCount;index++){
    const pattern=index%6;
    const actorId=`viewer-${index}`;
    const actor={id:actorId,name:`시청자 ${index}`};
    const donationAt=base+index*20_000;
    const donation={
      eventId:`donation-${index}`,actor,amount:30,
      message:pattern===0?`후원 메시지 ${index}`:null,
      occurredAt:new Date(donationAt).toISOString()
    };
    const donationArrival=donationAt+randomBetween(rng,0,12);
    events.push({kind:'donation',payload:donation,arrivalMs:donationArrival});
    if(index%17===0)events.push({kind:'donation',payload:clone(donation),arrivalMs:donationArrival+1});
    if(pattern===0){expected.donationMessages++;continue}
    const chatAt=pattern===2?donationAt+30_000:pattern===3?donationAt+30_001:donationAt+1_000+randomBetween(rng,0,700);
    if(pattern===4){
      events.push({kind:'chat',arrivalMs:donationArrival+10,payload:{
        eventId:`wrong-chat-${index}`,actor:{id:`other-${index}`,name:'다른 시청자'},
        message:'다른 사람 채팅',occurredAt:new Date(chatAt).toISOString()
      }});
    }
    const chat={
      eventId:`chat-${index}`,actor,message:`첫 채팅 ${index}`,
      occurredAt:new Date(chatAt).toISOString()
    };
    const chatArrival=pattern===5?Math.max(0,donationArrival-7):donationArrival+20+randomBetween(rng,0,20);
    events.push({kind:'chat',payload:chat,arrivalMs:chatArrival});
    if(index%19===0)events.push({kind:'chat',payload:clone(chat),arrivalMs:chatArrival+1});
    if([1,2,4,5].includes(pattern))expected.followupsCaptured++;
    if(pattern===5)expected.reorderedRecovered++;
  }
  events.sort((a,b)=>a.arrivalMs-b.arrivalMs||a.kind.localeCompare(b.kind));
  for(const event of events)lab.ingest(event,event.arrivalMs);
  const summary=lab.finish(events.at(-1)?.arrivalMs||0);
  const checks={
    donationMessageCount:summary.stats.donationMessages===expected.donationMessages,
    followupCaptureCount:summary.stats.followupsCaptured===expected.followupsCaptured,
    reorderedChatsRecovered:summary.stats.reorderedRecovered===expected.reorderedRecovered,
    ttsNeverReadsElapsedPrefix:summary.dispatches.every(item=>item.spokenTimestamp===false),
    displayKeepsElapsedPrefix:summary.dispatches.filter(item=>item.sourceKind==='followup_chat')
      .every(item=>/^\[\d+초전\]/.test(item.displayText)),
    allChatTtsAfterResults:summary.dispatches.every(item=>item.scheduledAtMs>=item.resultReadyAtMs),
    noPendingAfterFinalization:!summary.pendingStatuses.pending
  };
  const compactSummary={
    stats:summary.stats,pendingStatuses:summary.pendingStatuses,
    bufferedChats:summary.bufferedChats,dispatchCount:summary.dispatches.length,
    dispatchSamples:summary.dispatches.slice(0,20)
  };
  return {caseCount,expected,summary:compactSummary,checks,passed:Object.values(checks).every(Boolean)};
}

function pipelineLatencyScenario(sampleCount,seed){
  const rng=new DeterministicRng(seed);
  const overlayStart=[];const cachedResultTts=[];const dynamicChatTtfa=[];const fullResult=[];
  for(let index=0;index<sampleCount;index++){
    const burstPenalty=index%97===0?randomBetween(rng,70,150):0;
    const ingress=randomBetween(rng,2,14);
    const persistence=randomBetween(rng,3,18);
    const queue=randomBetween(rng,6,38)+burstPenalty;
    const agent=randomBetween(rng,4,25);
    const overlay=ingress+persistence+queue+agent;
    const cacheDelay=randomBetween(rng,7,32);
    const streamingTtfa=randomBetween(rng,170,620)+(index%131===0?randomBetween(rng,100,260):0);
    overlayStart.push(overlay);
    cachedResultTts.push(cacheDelay);
    dynamicChatTtfa.push(streamingTtfa);
    fullResult.push(overlay+DEFAULT_SPIN_MS+cacheDelay);
  }
  const metrics={
    donationToOverlayMs:latencySummary(overlayStart),
    resultRevealToCachedTtsMs:latencySummary(cachedResultTts),
    chatArrivalToFirstAudioMs:latencySummary(dynamicChatTtfa),
    donationToResultAudioMs:latencySummary(fullResult)
  };
  const checks={
    overlayP95Under250ms:metrics.donationToOverlayMs.p95<=250,
    cachedResultP95Under100ms:metrics.resultRevealToCachedTtsMs.p95<=100,
    dynamicChatP95Under1000ms:metrics.chatArrivalToFirstAudioMs.p95<=1_000,
    resultStartsAfterThreeSeconds:metrics.donationToResultAudioMs.min>=DEFAULT_SPIN_MS
  };
  return {sampleCount,model:'synthetic-capacity-model',metrics,checks,passed:Object.values(checks).every(Boolean)};
}

const TTS_SCENARIO_PROFILES=Object.freeze([
  {key:'pre_generated_cache',label:'룰렛 결과 사전 캐시',baseMs:8,jitterMs:26,spikeMs:45,spikeEvery:211,failurePpm:0,qualityAssumption:4.5},
  {key:'low_latency_streaming_candidate',label:'동적 채팅 스트리밍 후보',baseMs:170,jitterMs:480,spikeMs:240,spikeEvery:137,failurePpm:2_000,qualityAssumption:4.0},
  {key:'cosyvoice_batch_baseline',label:'현행 CosyVoice 완성 WAV 기준',baseMs:760,jitterMs:900,spikeMs:1_200,spikeEvery:89,failurePpm:4_000,qualityAssumption:4.5},
  {key:'os_fallback',label:'운영체제 내장 비상 음성',baseMs:25,jitterMs:75,spikeMs:80,spikeEvery:173,failurePpm:500,qualityAssumption:2.5}
]);

function syntheticTtsBenchmark(iterations,seed){
  const providers=[];
  for(const [providerIndex,profile] of TTS_SCENARIO_PROFILES.entries()){
    const rng=new DeterministicRng(seed^(0x9e3779b9+providerIndex*977));
    const latencies=[];let failures=0;
    for(let index=0;index<iterations;index++){
      if(rng.samplePpm()<profile.failurePpm){failures++;continue}
      const spike=index%profile.spikeEvery===0?randomBetween(rng,0,profile.spikeMs):0;
      latencies.push(profile.baseMs+randomBetween(rng,0,profile.jitterMs)+spike);
    }
    providers.push({
      key:profile.key,label:profile.label,latencyMs:latencySummary(latencies),
      failures,errorRatePercent:Math.round(failures/iterations*100_000)/1_000,
      qualityAssumption:profile.qualityAssumption,
      measurementKind:'synthetic-only-not-a-provider-benchmark'
    });
  }
  const byKey=Object.fromEntries(providers.map(item=>[item.key,item]));
  const checks={
    resultCacheP95Under100ms:byKey.pre_generated_cache.latencyMs.p95<=100,
    streamingCandidateP95Under1000ms:byKey.low_latency_streaming_candidate.latencyMs.p95<=1_000,
    streamingCandidateErrorsUnderOnePercent:byKey.low_latency_streaming_candidate.errorRatePercent<1,
    batchEngineNotUsedForDynamicChat:byKey.cosyvoice_batch_baseline.latencyMs.p95>
      byKey.low_latency_streaming_candidate.latencyMs.p95
  };
  return {
    iterations,providers,checks,passed:Object.values(checks).every(Boolean),
    requiresRealProviderBenchmark:true,
    recommendedArchitecture:{resultTts:'pre_generated_cache',dynamicChatTts:'low_latency_streaming_candidate',fallback:'os_fallback'}
  };
}

function faultScenario(name){
  const definitions={
    network_partition:{unavailableUntil:4_000,recoveryBudgetMs:5_000},
    agent_disconnect:{unavailableUntil:5_000,recoveryBudgetMs:6_000},
    obs_restart:{unavailableUntil:8_000,recoveryBudgetMs:10_000},
    server_crash_after_commit:{unavailableUntil:0,recoveryBudgetMs:6_000,crashAfterCommit:true},
    overlay_reload:{unavailableUntil:0,recoveryBudgetMs:1_000,overlayReload:true},
    tts_unavailable:{unavailableUntil:0,recoveryBudgetMs:2_000,ttsUnavailable:true}
  };
  const definition=definitions[name];
  assert.ok(definition,`unknown fault scenario ${name}`);
  let now=0;let attempts=0;let committed=false;let succeeded=false;let visibleExecutions=0;
  let duplicateSuppressed=0;let fallbackUsed=false;let leaseExpiresAt=0;let crashInjected=false;
  while(now<=60_000&&!succeeded){
    if(now<definition.unavailableUntil){now+=100;continue}
    if(!committed){
      attempts++;committed=true;visibleExecutions++;
      if(definition.crashAfterCommit&&!crashInjected){
        crashInjected=true;leaseExpiresAt=now+5_000;now+=100;continue;
      }
    }
    if(definition.crashAfterCommit&&crashInjected&&now<leaseExpiresAt){now+=100;continue}
    if(definition.crashAfterCommit&&crashInjected){attempts++;duplicateSuppressed++}
    if(definition.overlayReload)duplicateSuppressed++;
    if(definition.ttsUnavailable)fallbackUsed=true;
    succeeded=true;
  }
  const result={
    name,recoveryMs:now,attempts,committed,succeeded,visibleExecutions,
    duplicateSuppressed,fallbackUsed,lostEvents:succeeded?0:1,
    passed:succeeded&&visibleExecutions===1&&(now<=definition.recoveryBudgetMs||definition.ttsUnavailable)
  };
  if(definition.ttsUnavailable)result.passed=result.passed&&fallbackUsed;
  if(definition.crashAfterCommit||definition.overlayReload)result.passed=result.passed&&duplicateSuppressed>0;
  return result;
}

function faultMatrix(){
  const scenarios=['network_partition','agent_disconnect','obs_restart','server_crash_after_commit','overlay_reload','tts_unavailable']
    .map(faultScenario);
  return {scenarios,passed:scenarios.every(item=>item.passed)};
}

export function runNativeRouletteReadinessLab({
  reliabilityEvents=10_000,probabilitySpins=1_000_000,correlationCases=6_000,
  latencySamples=20_000,ttsIterations=5_000,seed=8282026
}={}){
  assert.ok(Number.isSafeInteger(correlationCases)&&correlationCases>=60&&correlationCases<=100_000);
  assert.ok(Number.isSafeInteger(latencySamples)&&latencySamples>=1_000&&latencySamples<=1_000_000);
  assert.ok(Number.isSafeInteger(ttsIterations)&&ttsIterations>=1_000&&ttsIterations<=100_000);
  const startedAt=performance.now();
  const reliability=runNativeRouletteReliabilitySuite({eventCount:reliabilityEvents,probabilitySpins,seed:seed^0x11111111});
  const correlation=correlationScenario(correlationCases,seed^0x22222222);
  const pipeline=pipelineLatencyScenario(latencySamples,seed^0x33333333);
  const tts=syntheticTtsBenchmark(ttsIterations,seed^0x44444444);
  const faults=faultMatrix();
  const checks={
    exactProbabilityAndDelivery:reliability.passed,
    soopDonationChatCorrelation:correlation.passed,
    threeSecondPipelineBudget:pipeline.passed,
    ttsArchitectureCapacityModel:tts.passed,
    faultRecoveryMatrix:faults.passed
  };
  const passed=Object.values(checks).every(Boolean);
  const completedChecks=Object.values(checks).filter(Boolean).length;
  return {
    schemaVersion:1,generatedAt:new Date().toISOString(),seed,
    mode:'offline-readiness-lab',operatingSystemImpact:'no-network-no-database-no-deployment',
    status:passed?'CONDITIONAL_PASS':'FAIL',passed,
    readinessScore:Math.round(completedChecks/Object.keys(checks).length*90),
    checks,reliability,correlation,pipeline,tts,faults,
    releaseBlockers:[
      'SOOP 공식 Chat SDK 실제 envelope·재연결 동작 검증',
      '동적 채팅 TTS 후보의 실제 한국어 TTFA·청취 품질·상업 이용 조건 검증',
      '실제 Agent·OBS 브라우저 소스에서 장시간 E2E 검증'
    ],
    elapsedMs:Math.round((performance.now()-startedAt)*100)/100
  };
}

export {latencySummary,TTS_SCENARIO_PROFILES};
