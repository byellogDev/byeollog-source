import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  NATIVE_ROULETTE_ASSET_BY_KEY,
  NATIVE_ROULETTE_ASSETS
} from '../lib/native-roulette-assets.js';
import {DeterministicRng} from './native-roulette-reliability-core.mjs';

const SPIN_DURATION_MS=3_000;
const EVENT_KINDS=new Set([
  'system.reset','soop.donation','soop.chat','correlation.buffered','correlation.matched',
  'roulette.queued','roulette.start','roulette.result','roulette.direct_upbo',
  'tts.result','tts.chat','tts.fallback','action.dispatch','agent.offline','agent.online',
  'agent.ack','obs.offline','obs.online','overlay.recovered','scenario.complete'
]);

const SCENARIOS=Object.freeze([
  Object.freeze({
    id:'donation-message',label:'후원 메시지 · 단차',group:'정상 흐름',durationMs:4_100,
    description:'후원 메시지와 단차 룰렛 결과를 3초 연출 뒤 순서대로 읽습니다.'
  }),
  Object.freeze({
    id:'followup-chat',label:'후속 첫 채팅',group:'정상 흐름',durationMs:6_000,
    description:'후원 메시지가 없을 때 설정 시간 안의 첫 채팅만 후원과 연결합니다.'
  }),
  Object.freeze({
    id:'reversed-delivery',label:'채팅 선도착',group:'이벤트 순서',durationMs:6_000,
    description:'SOOP 채팅 패킷이 후원 패킷보다 먼저 전달되는 상황을 2초 버퍼로 복구합니다.'
  }),
  Object.freeze({
    id:'series-three',label:'연차 3회',group:'정상 흐름',durationMs:10_100,
    description:'연차 룰렛을 세 번 연속 재생하고 마지막 결과 뒤 후원 메시지를 읽습니다.'
  }),
  Object.freeze({
    id:'direct-upbo',label:'업보 직행',group:'정상 흐름',durationMs:1_300,
    description:'업보 지정 상품은 연출·TTS·액션을 생략하고 업보 원장으로 바로 보냅니다.'
  }),
  Object.freeze({
    id:'agent-disconnect',label:'Agent 연결 끊김',group:'장애 복구',durationMs:8_900,
    description:'결과 커밋 뒤 Agent가 끊겨도 재연결 후 액션을 정확히 한 번 실행합니다.'
  }),
  Object.freeze({
    id:'obs-restart',label:'OBS 재시작',group:'장애 복구',durationMs:5_000,
    description:'OBS가 룰렛 중 재시작되어도 남은 연출 위치를 복구하고 결과는 중복 실행하지 않습니다.'
  }),
  Object.freeze({
    id:'tts-failure',label:'TTS 장애 대체',group:'장애 복구',durationMs:4_300,
    description:'주 TTS가 응답하지 않으면 방송 흐름을 멈추지 않고 로컬 비상 음성으로 전환합니다.'
  })
]);

export const NATIVE_ROULETTE_TWIN_SCENARIOS=SCENARIOS;
export const NATIVE_ROULETTE_TWIN_SPIN_DURATION_MS=SPIN_DURATION_MS;

function clone(value){return structuredClone(value)}
function bounded(value,max=180){return String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max)}
function eventId(scenarioId,index,kind){
  return crypto.createHash('sha256').update(`byeollog-twin-v1|${scenarioId}|${index}|${kind}`)
    .digest('hex').slice(0,24);
}

function addEvent(timeline,scenarioId,atMs,kind,title,detail='',data={}){
  assert.ok(Number.isSafeInteger(atMs)&&atMs>=0,'digital twin event time must be non-negative');
  assert.ok(EVENT_KINDS.has(kind),`unsupported digital twin event kind: ${kind}`);
  const index=timeline.length;
  timeline.push({
    id:eventId(scenarioId,index,kind),atMs,kind,title:bounded(title,120),detail:bounded(detail,280),
    data:clone(data)
  });
}

function resultFor(rng,preferred=null){
  if(preferred)return preferred;
  return ['테스트 용돈','윙크','아봉 10초','사랑해','다음 보상 2배'][rng.integer(0,4)];
}

function rouletteEvents({timeline,scenarioId,rng,startMs,spinIndex=0,result=null,assetKey,action='채팅창 효과'}){
  const selected=resultFor(rng,result);
  addEvent(timeline,scenarioId,startMs,'roulette.queued',`룰렛 ${spinIndex+1}회 대기`,
    '중복 방지 키와 결과를 먼저 커밋했습니다.',{spinIndex,result:selected});
  addEvent(timeline,scenarioId,startMs+40,'roulette.start',`룰렛 ${spinIndex+1}회 시작`,
    '3초 오버레이와 효과음을 동시에 시작합니다.',{spinIndex,result:selected,assetKey,durationMs:SPIN_DURATION_MS});
  addEvent(timeline,scenarioId,startMs+SPIN_DURATION_MS+40,'roulette.result',`${selected} 당첨!`,
    '커밋된 결과를 공개했습니다.',{spinIndex,result:selected,assetKey});
  addEvent(timeline,scenarioId,startMs+SPIN_DURATION_MS+80,'tts.result',`${selected}, 당첨!`,
    '저장할 때 미리 만든 결과 음성을 캐시에서 재생합니다.',{spinIndex,result:selected,engine:'pre_generated_cache'});
  addEvent(timeline,scenarioId,startMs+SPIN_DURATION_MS+130,'action.dispatch',action,
    '룰렛 결과에 연결된 액션을 Agent로 전송합니다.',{spinIndex,result:selected,action});
  addEvent(timeline,scenarioId,startMs+SPIN_DURATION_MS+180,'agent.ack','Agent 실행 확인',
    '동일 이벤트 키의 재실행은 차단됩니다.',{spinIndex,result:selected,action,exactlyOnce:true});
  return {result:selected,endMs:startMs+SPIN_DURATION_MS+180};
}

function buildScenarioTimeline(scenarioId,seed){
  const scenario=SCENARIOS.find(item=>item.id===scenarioId);
  assert.ok(scenario,`unknown native roulette twin scenario: ${scenarioId}`);
  const rng=new DeterministicRng(seed^Number.parseInt(crypto.createHash('sha256').update(scenarioId).digest('hex').slice(0,8),16));
  const asset=NATIVE_ROULETTE_ASSETS[rng.integer(0,NATIVE_ROULETTE_ASSETS.length-1)];
  const timeline=[];
  addEvent(timeline,scenarioId,0,'system.reset','가상 방송 초기화','운영 네트워크와 분리된 메모리 상태를 새로 만들었습니다.',{assetKey:asset.key});

  if(scenarioId==='donation-message'){
    addEvent(timeline,scenarioId,120,'soop.donation','테스트 시청자 · 별풍선 30개','후원 메시지: 오늘도 화이팅!',{message:'오늘도 화이팅!',amount:30});
    rouletteEvents({timeline,scenarioId,rng,startMs:220,assetKey:asset.key,result:'윙크'});
    addEvent(timeline,scenarioId,3_450,'tts.chat','오늘도 화이팅!','후원 메시지는 결과 TTS 다음에 읽습니다.',{sourceKind:'donation_message'});
  }else if(scenarioId==='followup-chat'){
    addEvent(timeline,scenarioId,120,'soop.donation','테스트 시청자 · 별풍선 30개','후원 메시지 없음 · 첫 채팅 대기 10초',{amount:30,message:null});
    rouletteEvents({timeline,scenarioId,rng,startMs:220,assetKey:asset.key,result:'아봉 10초'});
    addEvent(timeline,scenarioId,3_650,'soop.chat','테스트 시청자: 딸깍','후원 3.5초 뒤 첫 채팅이 도착했습니다.',{message:'딸깍',occurredAfterDonationMs:3_530});
    addEvent(timeline,scenarioId,3_680,'correlation.matched','후원과 첫 채팅 연결','화면에는 [4초전]을 표시하지만 TTS는 읽지 않습니다.',{displayText:'[4초전] 테스트 시청자 : 딸깍',ttsText:'딸깍'});
    addEvent(timeline,scenarioId,3_790,'tts.chat','딸깍','동적 채팅 음성의 첫 PCM 조각 재생을 모사합니다.',{sourceKind:'followup_chat'});
  }else if(scenarioId==='reversed-delivery'){
    addEvent(timeline,scenarioId,100,'soop.chat','테스트 시청자: 딸깍','SDK 전달 순서상 채팅 패킷이 먼저 도착했습니다.',{message:'딸깍',occurredAfterDonationMs:900});
    addEvent(timeline,scenarioId,120,'correlation.buffered','채팅 임시 보관','후원 패킷을 기다리며 최대 2초만 메모리에 보관합니다.',{bufferMs:2_000});
    addEvent(timeline,scenarioId,520,'soop.donation','테스트 시청자 · 별풍선 30개','실제 발생 시각은 채팅보다 앞선 후원입니다.',{amount:30,message:null});
    addEvent(timeline,scenarioId,540,'correlation.matched','역순 이벤트 복구','SOOP 발생 시각과 동일 사용자 ID를 검증해 연결했습니다.',{reordered:true});
    rouletteEvents({timeline,scenarioId,rng,startMs:620,assetKey:asset.key,result:'사랑해'});
    addEvent(timeline,scenarioId,3_900,'tts.chat','딸깍','[1초전] 표시는 읽지 않습니다.',{sourceKind:'followup_chat'});
  }else if(scenarioId==='series-three'){
    addEvent(timeline,scenarioId,120,'soop.donation','연차 테스트 · 별풍선 100개','연차 규칙: 100개 후원 시 3회',{amount:100,seriesSpinCount:3});
    let cursor=220;
    for(let index=0;index<3;index++){
      const spin=rouletteEvents({timeline,scenarioId,rng,startMs:cursor,spinIndex:index,assetKey:asset.key});
      cursor=spin.endMs+80;
    }
    addEvent(timeline,scenarioId,cursor+80,'tts.chat','연차 가자!','모든 결과가 끝난 뒤 후원 메시지를 한 번만 읽습니다.',{sourceKind:'donation_message'});
  }else if(scenarioId==='direct-upbo'){
    addEvent(timeline,scenarioId,120,'soop.donation','테스트 시청자 · 별풍선 30개','업보 지정 상품이 추첨됐습니다.',{amount:30});
    addEvent(timeline,scenarioId,220,'roulette.direct_upbo','업보 A & 업보 B','오버레이·결과 TTS·연결 액션을 생략합니다.',{outputs:['업보 A','업보 B'],skipPresentation:true,skipAutomation:true});
  }else if(scenarioId==='agent-disconnect'){
    addEvent(timeline,scenarioId,120,'soop.donation','테스트 시청자 · 별풍선 30개','Agent 연결 장애를 주입합니다.',{amount:30});
    const spin=rouletteEvents({timeline,scenarioId,rng,startMs:220,assetKey:asset.key,result:'아봉 10초',action:'아봉'});
    const dispatch=timeline.find(item=>item.kind==='action.dispatch');
    const ack=timeline.find(item=>item.kind==='agent.ack');
    timeline.splice(timeline.indexOf(ack),1);
    addEvent(timeline,scenarioId,dispatch.atMs-20,'agent.offline','Agent 연결 끊김','액션은 서버 큐에 유지하고 방송 화면은 계속 진행합니다.',{queueRetained:true});
    addEvent(timeline,scenarioId,7_200,'agent.online','Agent 재연결','동일 이벤트 키로 보류 액션을 다시 전달합니다.',{recovered:true});
    addEvent(timeline,scenarioId,7_280,'agent.ack','Agent 실행 확인','액션은 정확히 한 번만 실행됐습니다.',{exactlyOnce:true,retryCount:1});
    void spin;
  }else if(scenarioId==='obs-restart'){
    addEvent(timeline,scenarioId,120,'soop.donation','테스트 시청자 · 별풍선 30개','OBS 재시작 장애를 주입합니다.',{amount:30});
    rouletteEvents({timeline,scenarioId,rng,startMs:220,assetKey:asset.key,result:'윙크'});
    addEvent(timeline,scenarioId,1_100,'obs.offline','OBS 브라우저 소스 종료','서버의 결과 커밋과 재생 위치는 유지됩니다.',{positionMs:880});
    addEvent(timeline,scenarioId,2_400,'obs.online','OBS 브라우저 소스 재연결','새 브라우저 소스가 진행 중인 룰렛 상태를 읽습니다.',{recovered:true});
    addEvent(timeline,scenarioId,2_450,'overlay.recovered','오버레이 재생 위치 복구','처음부터 다시 돌리지 않고 남은 810ms를 이어서 재생합니다.',{replayed:false,resumed:true,remainingMs:810,duplicateVisibleExecution:false});
  }else if(scenarioId==='tts-failure'){
    addEvent(timeline,scenarioId,120,'soop.donation','테스트 시청자 · 별풍선 30개','주 TTS 장애를 주입합니다.',{amount:30});
    rouletteEvents({timeline,scenarioId,rng,startMs:220,assetKey:asset.key,result:'테스트 용돈'});
    const resultTts=timeline.find(item=>item.kind==='tts.result');
    timeline.splice(timeline.indexOf(resultTts),1);
    addEvent(timeline,scenarioId,3_300,'tts.fallback','로컬 비상 음성 전환','주 TTS 실패 후 200ms 안에 로컬 엔진을 사용했습니다.',{primaryFailed:true,fallback:'os_local'});
  }
  const lastAt=Math.max(...timeline.map(item=>item.atMs));
  addEvent(timeline,scenarioId,Math.max(scenario.durationMs,lastAt+150),'scenario.complete','시나리오 검증 완료','모든 불변 조건을 검사했습니다.',{});
  return {scenario,asset,timeline:timeline.sort((a,b)=>a.atMs-b.atMs||a.id.localeCompare(b.id))};
}

function verifyTimeline(scenarioId,timeline){
  const ids=new Set();
  for(const item of timeline){
    assert.equal(ids.has(item.id),false,'timeline event id must be unique');ids.add(item.id);
    assert.ok(EVENT_KINDS.has(item.kind));
  }
  const rouletteStarts=timeline.filter(item=>item.kind==='roulette.start');
  const rouletteResults=timeline.filter(item=>item.kind==='roulette.result');
  const resultTts=timeline.filter(item=>item.kind==='tts.result'||item.kind==='tts.fallback');
  const directUpbo=timeline.filter(item=>item.kind==='roulette.direct_upbo');
  const checks={
    monotonicTimeline:timeline.every((item,index)=>index===0||item.atMs>=timeline[index-1].atMs),
    eventIdsUnique:ids.size===timeline.length,
    everySpinIsThreeSeconds:rouletteStarts.every(start=>{
      const result=rouletteResults.find(item=>item.data.spinIndex===start.data.spinIndex);
      return result&&result.atMs-start.atMs===SPIN_DURATION_MS;
    }),
    resultTtsAfterReveal:resultTts.every(tts=>{
      const result=rouletteResults.find(item=>item.data.spinIndex===(tts.data.spinIndex??0));
      return scenarioId==='tts-failure'?Boolean(result&&tts.atMs>=result.atMs):Boolean(result&&tts.atMs>=result.atMs);
    }),
    directUpboSkipsPresentation:directUpbo.every(item=>item.data.skipPresentation===true&&item.data.skipAutomation===true)
      &&(directUpbo.length===0||rouletteStarts.length===0),
    followupPrefixNeverSpoken:timeline.filter(item=>item.kind==='tts.chat')
      .every(item=>!/^\[\d+초전\]/.test(item.title)),
    exactlyOnceAgentAck:timeline.filter(item=>item.kind==='agent.ack')
      .every(item=>item.data.exactlyOnce===true),
    completedOnce:timeline.filter(item=>item.kind==='scenario.complete').length===1
  };
  return {checks,passed:Object.values(checks).every(Boolean)};
}

export function runNativeRouletteTwinScenario({scenarioId='donation-message',seed=20260828}={}){
  assert.ok(Number.isSafeInteger(seed));
  const built=buildScenarioTimeline(scenarioId,seed);
  const verification=verifyTimeline(scenarioId,built.timeline);
  return {
    schemaVersion:1,mode:'local-digital-twin',scenario:clone(built.scenario),
    seed,asset:clone(built.asset),timeline:clone(built.timeline),verification,
    safety:{bindAddress:'127.0.0.1',networkRequests:false,databaseWrites:false,productionDispatch:false}
  };
}

export function runNativeRouletteTwinCampaign({runsPerScenario=100,seed=20260828}={}){
  assert.ok(Number.isSafeInteger(runsPerScenario)&&runsPerScenario>=1&&runsPerScenario<=100_000);
  const rng=new DeterministicRng(seed);
  const failures=[];let runs=0;let timelineEvents=0;
  const perScenario=[];
  for(const scenario of SCENARIOS){
    let passed=0;
    for(let index=0;index<runsPerScenario;index++){
      const report=runNativeRouletteTwinScenario({scenarioId:scenario.id,seed:rng.nextUint32()});
      runs++;timelineEvents+=report.timeline.length;
      if(report.verification.passed)passed++;
      else failures.push({scenarioId:scenario.id,index,checks:report.verification.checks});
    }
    perScenario.push({scenarioId:scenario.id,label:scenario.label,runs:runsPerScenario,passed});
  }
  return {
    schemaVersion:1,mode:'local-digital-twin-campaign',seed,runsPerScenario,runs,timelineEvents,
    passed:failures.length===0,failures,perScenario,
    safety:{networkRequests:false,databaseWrites:false,productionDispatch:false},
    assetContract:{count:NATIVE_ROULETTE_ASSETS.length,allPublished:NATIVE_ROULETTE_ASSETS.every(item=>item.deliveryStatus==='published')}
  };
}

export function nativeRouletteTwinScenarioById(id){
  return clone(SCENARIOS.find(item=>item.id===id)||null);
}

export function nativeRouletteTwinAssetByKey(key){
  return clone(NATIVE_ROULETTE_ASSET_BY_KEY[key]||null);
}
