import {createHash} from 'node:crypto';

function round(value,digits=2){
  const scale=10**digits;
  return Math.round(value*scale)/scale;
}

export function percentile(values,ratio){
  const sorted=values.filter(Number.isFinite).toSorted((a,b)=>a-b);
  if(!sorted.length)return null;
  const index=Math.max(0,Math.ceil(sorted.length*ratio)-1);
  return round(sorted[index]);
}

export function summarize(values){
  const clean=values.filter(Number.isFinite);
  if(!clean.length)return {count:0,min:null,p50:null,p95:null,p99:null,max:null,mean:null};
  return {
    count:clean.length,
    min:round(Math.min(...clean)),
    p50:percentile(clean,.5),
    p95:percentile(clean,.95),
    p99:percentile(clean,.99),
    max:round(Math.max(...clean)),
    mean:round(clean.reduce((sum,value)=>sum+value,0)/clean.length)
  };
}

export function analyzePcm16le(input,{sampleRate,channels=1}={}){
  const bytes=Buffer.from(input||[]);
  if(!Number.isSafeInteger(sampleRate)||sampleRate<8_000||sampleRate>192_000)throw new Error('PCM sample rate is invalid');
  if(!Number.isSafeInteger(channels)||channels<1||channels>8)throw new Error('PCM channel count is invalid');
  if(bytes.length<2||bytes.length%2!==0)throw new Error('PCM16LE payload is empty or misaligned');
  const samples=bytes.length/2;
  let peak=0,sumSquares=0,nonZero=0,clipped=0;
  for(let offset=0;offset<bytes.length;offset+=2){
    const sample=bytes.readInt16LE(offset),magnitude=Math.abs(sample);
    peak=Math.max(peak,magnitude);
    sumSquares+=sample*sample;
    if(sample!==0)nonZero++;
    if(magnitude>=32760)clipped++;
  }
  return {
    byteLength:bytes.length,
    samples,
    durationMs:round(samples/(sampleRate*channels)*1000),
    peakRatio:round(peak/32768,5),
    rmsRatio:round(Math.sqrt(sumSquares/samples)/32768,5),
    nonZeroPercent:round(nonZero/samples*100,4),
    clippedPercent:round(clipped/samples*100,4),
    sha256:createHash('sha256').update(bytes).digest('hex')
  };
}

export function pcm16leToWav(input,{sampleRate,channels=1}={}){
  const pcm=Buffer.from(input),blockAlign=channels*2,byteRate=sampleRate*blockAlign;
  const header=Buffer.alloc(44);
  header.write('RIFF',0,'ascii');
  header.writeUInt32LE(36+pcm.length,4);
  header.write('WAVE',8,'ascii');
  header.write('fmt ',12,'ascii');
  header.writeUInt32LE(16,16);
  header.writeUInt16LE(1,20);
  header.writeUInt16LE(channels,22);
  header.writeUInt32LE(sampleRate,24);
  header.writeUInt32LE(byteRate,28);
  header.writeUInt16LE(blockAlign,32);
  header.writeUInt16LE(16,34);
  header.write('data',36,'ascii');
  header.writeUInt32LE(pcm.length,40);
  return Buffer.concat([header,pcm]);
}

export function wavPcm16le(input){
  const wav=Buffer.from(input||[]);
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'){
    throw new Error('WAV container is invalid');
  }
  let offset=12,format=null,pcm=null;
  while(offset+8<=wav.length){
    const id=wav.toString('ascii',offset,offset+4),size=wav.readUInt32LE(offset+4),start=offset+8,end=start+size;
    if(end>wav.length)throw new Error('WAV chunk exceeds payload');
    if(id==='fmt '){
      if(size<16)throw new Error('WAV format chunk is too short');
      format={audioFormat:wav.readUInt16LE(start),channels:wav.readUInt16LE(start+2),sampleRate:wav.readUInt32LE(start+4),bitsPerSample:wav.readUInt16LE(start+14)};
    }else if(id==='data')pcm=Buffer.from(wav.subarray(start,end));
    offset=end+(size%2);
  }
  if(!format||format.audioFormat!==1||format.bitsPerSample!==16||!pcm?.length)throw new Error('WAV must contain PCM16LE audio');
  return {pcm,sampleRate:format.sampleRate,channels:format.channels};
}

function aggregate(rows){
  return {
    requestToFirstByteMs:summarize(rows.map(row=>row.requestToFirstByteMs)),
    requestToFirstAudioMs:summarize(rows.map(row=>row.requestToFirstAudioMs)),
    totalResponseMs:summarize(rows.map(row=>row.totalResponseMs)),
    audioDurationMs:summarize(rows.map(row=>row.audio?.durationMs)),
    audioBytes:summarize(rows.map(row=>row.audio?.byteLength)),
    clippedPercent:summarize(rows.map(row=>row.audio?.clippedPercent)),
    rmsRatio:summarize(rows.map(row=>row.audio?.rmsRatio))
  };
}

async function runSynthesis(adapter,item,timeoutMs){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('TTS request timed out')),timeoutMs);
  const started=performance.now();
  let firstByteAt=null,firstAudioAt=null;
  try{
    const result=await adapter.synthesize({
      text:item.ttsText,
      caseId:item.id,
      signal:controller.signal,
      onFirstByte:()=>{if(firstByteAt===null)firstByteAt=performance.now()},
      onFirstAudio:()=>{if(firstAudioAt===null)firstAudioAt=performance.now()}
    });
    const completed=performance.now();
    if(firstByteAt===null||firstAudioAt===null)throw new Error('adapter did not report first byte and first playable audio');
    const audio=analyzePcm16le(result.pcm,{sampleRate:result.sampleRate,channels:result.channels});
    if(audio.nonZeroPercent<1)throw new Error('audio payload is effectively silent');
    return {
      ok:true,
      requestToFirstByteMs:round(firstByteAt-started),
      requestToFirstAudioMs:round(firstAudioAt-started),
      totalResponseMs:round(completed-started),
      sampleRate:result.sampleRate,
      channels:result.channels,
      audio,
      pcm:Buffer.from(result.pcm)
    };
  }catch(error){
    return {ok:false,errorCode:error?.name==='AbortError'?'timeout':String(error?.code||error?.name||'tts_error').slice(0,80),errorMessage:String(error?.message||error).slice(0,240)};
  }finally{clearTimeout(timer)}
}

async function runPool(jobs,concurrency,worker){
  let cursor=0;
  await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{
    while(cursor<jobs.length){
      const job=jobs[cursor++];
      await worker(job);
    }
  }));
}

export async function runProviderBenchmark({provider,adapter,corpus,iterations=3,warmups=1,concurrency=1,timeoutMs=15_000,onSample}={}){
  if(!provider?.id||!adapter?.synthesize||!Array.isArray(corpus)||!corpus.length)throw new Error('benchmark configuration is incomplete');
  for(let cycle=0;cycle<warmups;cycle++){
    for(const item of corpus)await runSynthesis(adapter,item,timeoutMs);
  }
  const jobs=[];
  for(let iteration=1;iteration<=iterations;iteration++)for(const item of corpus)jobs.push({iteration,item});
  const rows=[],captured=new Set();
  await runPool(jobs,concurrency,async({iteration,item})=>{
    const measured=await runSynthesis(adapter,item,timeoutMs);
    const row={iteration,caseId:item.id,category:item.category||'uncategorized',...measured};
    rows.push(row);
    if(measured.ok&&onSample&&!captured.has(item.id)){
      captured.add(item.id);
      await onSample({provider,item,pcm:measured.pcm,sampleRate:measured.sampleRate,channels:measured.channels});
    }
    delete row.pcm;
  });
  rows.sort((a,b)=>a.iteration-b.iteration||a.caseId.localeCompare(b.caseId));
  const successes=rows.filter(row=>row.ok),failures=rows.filter(row=>!row.ok);
  const byCase=Object.fromEntries(corpus.map(item=>{
    const selected=successes.filter(row=>row.caseId===item.id);
    return [item.id,{category:item.category||'uncategorized',textLength:item.ttsText.length,successes:selected.length,failures:rows.filter(row=>row.caseId===item.id&&!row.ok).length,metrics:aggregate(selected)}];
  }));
  const successRatePercent=round(successes.length/rows.length*100,4);
  return {
    provider:{id:provider.id,label:provider.label||provider.id,kind:provider.kind,metadata:provider.metadata||{}},
    requestCount:rows.length,successes:successes.length,failures:failures.length,successRatePercent,
    metrics:aggregate(successes),byCase,
    failureCodes:Object.fromEntries([...new Set(failures.map(row=>row.errorCode))].map(code=>[code,failures.filter(row=>row.errorCode===code).length])),
    rows
  };
}

export function evaluateLatencyGate(result,targets={p50Ms:450,p95Ms:800,p99Ms:1200,minSuccessRatePercent:99.9}){
  const metric=result?.metrics?.requestToFirstAudioMs||{};
  const checks={
    p50:Number.isFinite(metric.p50)&&metric.p50<=targets.p50Ms,
    p95:Number.isFinite(metric.p95)&&metric.p95<=targets.p95Ms,
    p99:Number.isFinite(metric.p99)&&metric.p99<=targets.p99Ms,
    successRate:Number(result?.successRatePercent)>=targets.minSuccessRatePercent
  };
  return {targets,checks,passed:Object.values(checks).every(Boolean)};
}
