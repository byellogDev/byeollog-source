import assert from 'node:assert/strict';
import {
  buildNativeRouletteDispatch,
  nativeRouletteSpinCount,
  normalizeNativeRouletteDraft,
  normalizeSoopDonationEnvelope,
  selectNativeRouletteItem
} from '../../../apps/web/lib/native-roulette.js';

const UINT32_RANGE=0x1_0000_0000;
const PPM_LIMIT=Math.floor(UINT32_RANGE/1_000_000)*1_000_000;
const DEFAULT_LEASE_MS=45_000;
const MAX_ATTEMPTS=10;

export class DeterministicRng{
  constructor(seed=8272026){
    const value=Number(seed)>>>0;
    this.state=value||0x6d2b79f5;
  }
  nextUint32(){
    let value=this.state>>>0;
    value^=value<<13;value^=value>>>17;value^=value<<5;
    this.state=value>>>0;
    return this.state;
  }
  samplePpm(){
    let value;
    do value=this.nextUint32();while(value>=PPM_LIMIT);
    return value%1_000_000;
  }
  integer(min,max){
    assert.ok(Number.isSafeInteger(min)&&Number.isSafeInteger(max)&&max>=min);
    const width=max-min+1;
    assert.ok(width>=1&&width<=UINT32_RANGE);
    const limit=Math.floor(UINT32_RANGE/width)*width;
    let value;
    do value=this.nextUint32();while(value>=limit);
    return min+(value%width);
  }
  shuffle(values){
    for(let index=values.length-1;index>0;index--){
      const target=this.integer(0,index);
      [values[index],values[target]]=[values[target],values[index]];
    }
    return values;
  }
}

function defaultDraft(){
  return {
    name:'신뢰성 검증 룰렛',balloonsPerSpin:30,allowMultipleSpins:true,
    agentDeviceId:'20000000-0000-4000-8000-000000000001',
    overlayAssetKey:'roulette_navy_gold_v1',soundKey:'roulette_spin_v1',
    soundVolumePercent:75,ttsVolumePercent:85,
    items:[
      {resultText:'일반 A',probabilityPpm:450000,directUpbo:false,ttsText:'일반 A 당첨!'},
      {resultText:'일반 B',probabilityPpm:300000,directUpbo:false,ttsText:'일반 B 당첨!'},
      {resultText:'업보 A & 업보 B',probabilityPpm:150000,directUpbo:true,upboEventName:'검증 이벤트'},
      {resultText:'잭팟',probabilityPpm:100000,directUpbo:false,ttsText:'잭팟 당첨!'}
    ]
  };
}

function identityOf(donation){
  return `${donation.actor.id}\u0000${donation.amount}\u0000${donation.occurredAt}`;
}

function clone(value){return structuredClone(value)}

export class NativeRouletteReliabilitySimulator{
  constructor({draft=defaultDraft(),seed=8272026,snapshot=null}={}){
    this.draft=normalizeNativeRouletteDraft(draft);
    this.profile={id:'sim-profile',...this.draft};
    this.profile.items=this.draft.items.map((item,index)=>({id:`sim-item-${index+1}`,...item}));
    this.rng=new DeterministicRng(seed);
    this.nowMs=Date.parse('2026-08-27T00:00:00.000Z');
    this.sequence=0;
    this.donations=new Map();
    this.outbox=new Map();
    this.deliveryLedger=new Map();
    this.presentationLog=[];
    this.metrics={
      ingested:0,duplicates:0,identityConflicts:0,ignored:0,spins:0,
      claims:0,retries:0,crashBeforeCommit:0,crashAfterCommit:0,
      cacheMisses:0,succeeded:0,failed:0,duplicateDeliveriesSuppressed:0,
      automationExecutions:0,directUpboExecutions:0
    };
    if(snapshot)this.restore(snapshot);
  }

  ingest(input){
    const donation=normalizeSoopDonationEnvelope(input);
    const existing=this.donations.get(donation.eventId);
    if(existing){
      if(existing.identity!==identityOf(donation)){
        this.metrics.identityConflicts++;
        const error=new Error('native roulette SOOP event identity changed');
        error.code='event_identity_changed';
        throw error;
      }
      this.metrics.duplicates++;
      return {duplicate:true,spinCount:existing.spinCount,sourceEventKeys:[...existing.sourceEventKeys]};
    }
    const spinCount=nativeRouletteSpinCount(donation.amount,this.draft);
    const record={donation:clone(donation),identity:identityOf(donation),spinCount,sourceEventKeys:[]};
    this.donations.set(donation.eventId,record);
    this.metrics.ingested++;
    if(spinCount===0)this.metrics.ignored++;
    for(let spinIndex=0;spinIndex<spinCount;spinIndex++){
      const sample=this.rng.samplePpm();
      const selected=selectNativeRouletteItem(this.profile.items,sample);
      const sourceEventKey=`soop-native-roulette:${donation.eventId}:${spinIndex}`;
      const payload=buildNativeRouletteDispatch({
        profile:this.profile,item:selected,donation,spinIndex,sourceEventKey
      });
      assert.equal(this.outbox.has(sourceEventKey),false,'sourceEventKey must be unique');
      this.outbox.set(sourceEventKey,{
        id:`dispatch-${++this.sequence}`,sourceEventKey,payload,sample,spinIndex,
        status:'pending',attemptCount:0,workerId:null,leaseExpiresAt:null,
        createdSequence:this.sequence,lastError:null
      });
      record.sourceEventKeys.push(sourceEventKey);
      this.metrics.spins++;
    }
    return {duplicate:false,spinCount,sourceEventKeys:[...record.sourceEventKeys]};
  }

  claim(workerId,{limit=50,leaseMs=DEFAULT_LEASE_MS}={}){
    assert.match(workerId,/^[A-Za-z0-9_.:-]{1,180}$/);
    assert.ok(Number.isSafeInteger(limit)&&limit>=1&&limit<=50);
    assert.ok(Number.isSafeInteger(leaseMs)&&leaseMs>=5_000&&leaseMs<=600_000);
    const available=[];
    for(const record of [...this.outbox.values()].sort((a,b)=>a.createdSequence-b.createdSequence)){
      const expired=record.status==='processing'&&record.leaseExpiresAt<=this.nowMs;
      if(expired&&record.attemptCount>=MAX_ATTEMPTS){
        record.status='failed';record.workerId=null;record.leaseExpiresAt=null;
        record.lastError='dispatch lease expired after final attempt';
        this.metrics.failed++;
        continue;
      }
      if(record.attemptCount<MAX_ATTEMPTS&&(record.status==='pending'||expired))available.push(record);
      if(available.length===limit)break;
    }
    for(const record of available){
      record.status='processing';record.attemptCount++;
      record.workerId=workerId;record.leaseExpiresAt=this.nowMs+leaseMs;record.lastError=null;
      this.metrics.claims++;
    }
    return available.map(clone);
  }

  deliver(dispatchId,workerId,{mode='success',ttsFirstChunkMs=180,spinDurationMs=3_000}={}){
    const record=[...this.outbox.values()].find(item=>item.id===dispatchId);
    assert.ok(record,'dispatch must exist');
    assert.equal(record.status,'processing');
    assert.equal(record.workerId,workerId);
    assert.ok(record.leaseExpiresAt>this.nowMs,'dispatch lease must be live');
    if(mode==='cache_miss'&&record.payload.kind==='automation_event'){
      record.status='pending';record.workerId=null;record.leaseExpiresAt=null;
      record.lastError='native roulette cache is not ready';
      this.metrics.cacheMisses++;this.metrics.retries++;
      return {status:'pending',committed:false};
    }
    if(mode==='crash_before_commit'){
      this.metrics.crashBeforeCommit++;
      return {status:'processing',committed:false};
    }
    const alreadyCommitted=this.deliveryLedger.has(record.sourceEventKey);
    if(alreadyCommitted){
      this.metrics.duplicateDeliveriesSuppressed++;
    }else{
      this.deliveryLedger.set(record.sourceEventKey,{kind:record.payload.kind,payload:clone(record.payload)});
      if(record.payload.kind==='direct_upbo'){
        assert.equal(record.payload.skipAutomation,true);
        assert.equal(record.payload.skipPresentation,true);
        this.metrics.directUpboExecutions++;
      }else{
        assert.equal(record.payload.skipAutomation,false);
        assert.equal(record.payload.skipPresentation,false);
        const delay=Math.max(0,Number(ttsFirstChunkMs)||0);
        this.presentationLog.push({
          sourceEventKey:record.sourceEventKey,
          overlayStartedAt:this.nowMs,soundStartedAt:this.nowMs,
          resultTtsStartedAt:this.nowMs+spinDurationMs+delay,
          ttsFirstChunkMs:delay
        });
        this.metrics.automationExecutions++;
      }
    }
    if(mode==='crash_after_commit'){
      this.metrics.crashAfterCommit++;
      return {status:'processing',committed:true,alreadyCommitted};
    }
    record.status='succeeded';record.workerId=null;record.leaseExpiresAt=null;record.lastError=null;
    this.metrics.succeeded++;
    return {status:'succeeded',committed:true,alreadyCommitted};
  }

  fail(dispatchId,workerId,{retryable=true,error='simulated transient failure'}={}){
    const record=[...this.outbox.values()].find(item=>item.id===dispatchId);
    assert.ok(record&&record.status==='processing'&&record.workerId===workerId);
    record.workerId=null;record.leaseExpiresAt=null;record.lastError=String(error).slice(0,2000);
    if(retryable&&record.attemptCount<MAX_ATTEMPTS){record.status='pending';this.metrics.retries++}
    else{record.status='failed';this.metrics.failed++}
    return {status:record.status,attemptCount:record.attemptCount};
  }

  advance(milliseconds){
    assert.ok(Number.isSafeInteger(milliseconds)&&milliseconds>=0);
    this.nowMs+=milliseconds;
  }

  snapshot(){
    return clone({
      draft:this.draft,rngState:this.rng.state,nowMs:this.nowMs,sequence:this.sequence,
      donations:[...this.donations],outbox:[...this.outbox],
      deliveryLedger:[...this.deliveryLedger],presentationLog:this.presentationLog,metrics:this.metrics
    });
  }

  restore(snapshot){
    this.draft=normalizeNativeRouletteDraft(snapshot.draft);
    this.profile={id:'sim-profile',...this.draft};
    this.profile.items=this.draft.items.map((item,index)=>({id:`sim-item-${index+1}`,...item}));
    this.rng.state=snapshot.rngState>>>0;this.nowMs=snapshot.nowMs;this.sequence=snapshot.sequence;
    this.donations=new Map(clone(snapshot.donations));this.outbox=new Map(clone(snapshot.outbox));
    this.deliveryLedger=new Map(clone(snapshot.deliveryLedger));
    this.presentationLog=clone(snapshot.presentationLog);this.metrics=clone(snapshot.metrics);
  }

  summary(){
    const status={pending:0,processing:0,succeeded:0,failed:0};
    for(const item of this.outbox.values())status[item.status]++;
    return {metrics:clone(this.metrics),outbox:status,deliveryLedger:this.deliveryLedger.size,
      presentations:this.presentationLog.length};
  }
}

function donation(index,amount=30){
  return {
    eventId:`sdk-event-${String(index).padStart(8,'0')}`,
    actor:{id:`viewer-${index%997}`,name:`시청자 ${index%997}`},amount,
    message:index%9===0?'룰렛 도전!':null,
    occurredAt:new Date(Date.parse('2026-08-27T00:00:00.000Z')+index*17).toISOString()
  };
}

function probabilityScenario(spins,seed){
  const normalized=normalizeNativeRouletteDraft(defaultDraft());
  const rng=new DeterministicRng(seed);
  const counts=normalized.items.map(()=>0);
  for(let index=0;index<spins;index++){
    const item=selectNativeRouletteItem(normalized.items,rng.samplePpm());
    counts[item.position]++;
  }
  const items=normalized.items.map((item,index)=>{
    const probability=item.probabilityPpm/1_000_000;
    const expected=spins*probability;
    const sigma=Math.sqrt(spins*probability*(1-probability));
    return {resultText:item.resultText,probabilityPpm:item.probabilityPpm,
      observed:counts[index],expected,zScore:sigma===0?0:(counts[index]-expected)/sigma};
  });
  return {spins,items,maxAbsoluteZ:Math.max(...items.map(item=>Math.abs(item.zScore)))};
}

function duplicateScenario(seed){
  const simulator=new NativeRouletteReliabilitySimulator({seed});
  const input=donation(1,90);
  const first=simulator.ingest(input);
  for(let index=0;index<99;index++)simulator.ingest(input);
  let identityConflictRejected=false;
  try{simulator.ingest({...input,amount:120})}catch(error){identityConflictRejected=error.code==='event_identity_changed'}
  return {firstSpinCount:first.spinCount,outbox:simulator.outbox.size,
    duplicates:simulator.metrics.duplicates,identityConflictRejected};
}

function retryExhaustionScenario(seed){
  const simulator=new NativeRouletteReliabilitySimulator({seed});
  simulator.ingest(donation(2,30));
  for(let attempt=0;attempt<MAX_ATTEMPTS;attempt++){
    const [job]=simulator.claim('terminal-worker',{limit:1});
    assert.ok(job);
    simulator.fail(job.id,'terminal-worker',{retryable:true});
  }
  const summary=simulator.summary();
  return {attempts:MAX_ATTEMPTS,outbox:summary.outbox,failed:summary.metrics.failed};
}

function disorderAndRestartScenario(eventCount,seed){
  let simulator=new NativeRouletteReliabilitySimulator({seed});
  const inputs=[];
  let expectedSpins=0;
  for(let index=0;index<eventCount;index++){
    const amount=index%13===0?29:[30,60,90][index%3];
    const value=donation(index+100,amount);
    inputs.push(value);
    if(index%7===0)inputs.push(clone(value));
    expectedSpins+=amount<30?0:Math.floor(amount/30);
  }
  simulator.rng.shuffle(inputs);
  for(const input of inputs)simulator.ingest(input);
  const firstWave=simulator.claim('worker-before-restart',{limit:50});
  firstWave.forEach((job,index)=>{
    const mode=index%11===0?'crash_after_commit':index%7===0?'crash_before_commit':
      index%5===0?'cache_miss':'success';
    simulator.deliver(job.id,'worker-before-restart',{mode,ttsFirstChunkMs:80+(index%9)*90});
  });
  simulator=new NativeRouletteReliabilitySimulator({snapshot:simulator.snapshot()});
  simulator.advance(DEFAULT_LEASE_MS+1);
  let safety=0;
  while(safety++<Math.max(100,expectedSpins*2)){
    const jobs=simulator.claim('worker-after-restart',{limit:50});
    if(!jobs.length)break;
    for(const job of jobs)simulator.deliver(job.id,'worker-after-restart',{
      mode:'success',ttsFirstChunkMs:60+(simulator.rng.integer(0,8)*110)
    });
  }
  const summary=simulator.summary();
  const orderingValid=simulator.presentationLog.every(item=>
    item.overlayStartedAt===item.soundStartedAt&&item.resultTtsStartedAt>=item.overlayStartedAt+3_000
      &&item.resultTtsStartedAt<=item.overlayStartedAt+4_000);
  const directUpboPresentationLeak=[...simulator.deliveryLedger].some(([sourceEventKey,value])=>
    value.kind==='direct_upbo'&&simulator.presentationLog.some(item=>item.sourceEventKey===sourceEventKey));
  return {eventCount,expectedSpins,summary,orderingValid,directUpboPresentationLeak};
}

export function runNativeRouletteReliabilitySuite({
  eventCount=10_000,probabilitySpins=500_000,seed=8272026
}={}){
  assert.ok(Number.isSafeInteger(eventCount)&&eventCount>=100&&eventCount<=200_000);
  assert.ok(Number.isSafeInteger(probabilitySpins)&&probabilitySpins>=10_000&&probabilitySpins<=10_000_000);
  const startedAt=performance.now();
  const probability=probabilityScenario(probabilitySpins,seed^0x12345678);
  const duplicates=duplicateScenario(seed^0x23456789);
  const restart=disorderAndRestartScenario(eventCount,seed^0x3456789a);
  const retryExhaustion=retryExhaustionScenario(seed^0x456789ab);
  const checks={
    probabilityWithinSixSigma:probability.maxAbsoluteZ<6,
    duplicateStormCreatedOneSpinSet:duplicates.firstSpinCount===3&&duplicates.outbox===3&&duplicates.duplicates===99,
    changedDuplicateRejected:duplicates.identityConflictRejected,
    noSpinLoss:restart.summary.deliveryLedger===restart.expectedSpins,
    noDuplicateVisibleExecution:restart.summary.metrics.automationExecutions
      +restart.summary.metrics.directUpboExecutions===restart.expectedSpins,
    allOutboxSucceeded:restart.summary.outbox.succeeded===restart.expectedSpins
      &&restart.summary.outbox.pending===0&&restart.summary.outbox.processing===0&&restart.summary.outbox.failed===0,
    crashRecoveryExercised:restart.summary.metrics.crashBeforeCommit>0
      &&restart.summary.metrics.crashAfterCommit>0&&restart.summary.metrics.duplicateDeliveriesSuppressed>0,
    cacheRetryExercised:restart.summary.metrics.cacheMisses>0&&restart.summary.metrics.retries>0,
    presentationOrderingValid:restart.orderingValid,
    directUpboSkippedPresentation:restart.directUpboPresentationLeak===false,
    retryLimitTerminates:retryExhaustion.outbox.failed===1&&retryExhaustion.failed===1
  };
  return {
    schemaVersion:1,mode:'offline-memory-only',seed,eventCount,probabilitySpins,
    operatingSystemImpact:'no-network-no-database-no-deployment',
    passed:Object.values(checks).every(Boolean),checks,probability,duplicates,restart,retryExhaustion,
    elapsedMs:Math.round((performance.now()-startedAt)*100)/100
  };
}

export {defaultDraft};
