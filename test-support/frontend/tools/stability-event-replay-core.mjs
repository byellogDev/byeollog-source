import crypto from 'node:crypto';
import {
  buildNativeRouletteDispatch,
  nativeRouletteSpinPlan,
  normalizeNativeRouletteActivation,
  normalizeSoopDonationEnvelope,
  selectNativeRouletteItem
} from '../../../apps/web/lib/native-roulette.js';
import {collectorSubscriptionInfo,normalizeCollectorRawPayload} from '../../../apps/web/lib/collector-subscription.js';
import {overlayTtsText,resolveCeremonyForOverlay} from '../../../apps/admin-runtime/lib/soop-roulette-service.js';

const DEVICE_ID='20000000-0000-4000-8000-000000000001';
const WORKSPACE_ID='10000000-0000-4000-8000-000000000001';

function stableJson(value){
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function fingerprint(value){
  return crypto.createHash('sha256').update(stableJson(value),'utf8').digest('hex');
}

function activation(){
  return normalizeNativeRouletteActivation({
    draft:{
      name:'안정성 룰렛',balloonsPerSpin:152,seriesEnabled:true,
      seriesBalloons:330,seriesSpinCount:10,
      overlayAssetKey:'roulette_navy_gold_v1',customSingleImage:null,customSeriesImage:null,
      items:[
        {resultText:'노래',probabilityPpm:500000,directUpbo:false},
        {resultText:'휴식',probabilityPpm:500000,directUpbo:false}
      ]
    },
    overlay:{agentDeviceId:DEVICE_ID,soundVolumePercent:75,ttsVolumePercent:85}
  });
}

async function ceremony(donation){
  return resolveCeremonyForOverlay(WORKSPACE_ID,{source:'soop',providerUrl:donation.ceremonyImageUrl},{
    amount:donation.amount,
    sbImpl:async()=>[{pc_image:{storagePath:`workspaces/${WORKSPACE_ID}/default-pc/30000000-0000-4000-8000-000000000001.gif`}}],
    hydrate:async()=>({previewUrl:'https://byeollog.invalid/stability/default.gif'})
  });
}

export async function runStabilityEventReplay(fixture){
  const profile=activation(),identities=new Map(),timeline=[],failures=[];
  let dispatchCount=0,duplicateCount=0,identityConflictCount=0,subscriptionCount=0;
  const eventById=new Map();
  const record=(id,stage,data={})=>timeline.push({sequence:timeline.length+1,id,stage,...data});
  const fail=(id,message)=>failures.push({id,message});

  for(const scenario of fixture?.events||[]){
    try{
      if(scenario.kind==='donation'){
        const donation=normalizeSoopDonationEnvelope(scenario);
        const digest=fingerprint(donation),known=identities.get(donation.eventId);
        if(known){
          if(known!==digest){identityConflictCount+=1;record(scenario.id,'identity_conflict');}
          else{duplicateCount+=1;record(scenario.id,'duplicate');}
          continue;
        }
        identities.set(donation.eventId,digest);eventById.set(donation.eventId,donation);
        record(scenario.id,'normalized',{eventId:donation.eventId,traceId:donation.eventId});
        const image=await ceremony(donation);
        record(scenario.id,'ceremony_resolved',{source:image.source});
        const plan=nativeRouletteSpinPlan(donation.amount,profile);
        if(!plan){
          record(scenario.id,'donation_only',{spinCount:0});
          if(scenario.expect?.spinCount!==0)fail(scenario.id,'expected a roulette trigger');
          if(image.source!==scenario.expect?.ceremonySource)fail(scenario.id,'unexpected ceremony source');
          continue;
        }
        const item=selectNativeRouletteItem(profile.items,scenario.sample);
        const dispatch=buildNativeRouletteDispatch({
          profile,item,donation,spinIndex:0,sourceEventKey:`stability:${donation.eventId}:0`
        });
        const overlayPayload={
          eventId:donation.eventId,amount:donation.amount,actor:donation.actor,
          resultText:item.resultText,rouletteItems:profile.items.map(candidate=>candidate.resultText),
          ceremony:image,donationTypeLabel:donation.donationTypeLabel
        };
        const ttsText=overlayTtsText('roulette_spin',overlayPayload);
        dispatchCount+=1;
        record(scenario.id,'roulette_dispatched',{
          traceId:dispatch.event.payload.donationEventId,
          spinCount:plan.spinCount,result:dispatch.event.payload.result,ttsText
        });
        if(plan.spinCount!==scenario.expect?.spinCount)fail(scenario.id,'unexpected spin count');
        if(item.resultText!==scenario.expect?.result)fail(scenario.id,'unexpected deterministic result');
        if(image.source!==scenario.expect?.ceremonySource)fail(scenario.id,'unexpected ceremony source');
        if(dispatch.event.payload.donationEventId!==donation.eventId)fail(scenario.id,'trace identity was not preserved');
        if(ttsText!==item.resultText)fail(scenario.id,'result TTS does not match the revealed product');
      }else if(scenario.kind==='collector'){
        const info=collectorSubscriptionInfo(scenario.raw),normalized=normalizeCollectorRawPayload(scenario.raw);
        if(info.isSubscription)subscriptionCount+=1;
        record(scenario.id,'collector_classified',{subscription:info.isSubscription,months:info.months,collectorEventKind:normalized.collector_event_kind||null});
        if(info.isSubscription!==scenario.expect?.subscription||info.months!==scenario.expect?.months)fail(scenario.id,'subscription classification mismatch');
      }else if(scenario.kind==='duplicate'){
        const original=eventById.get(scenario.eventId);
        if(!original)throw new Error('duplicate source event is missing');
        const before=dispatchCount,known=identities.get(scenario.eventId),digest=fingerprint(original);
        const duplicate=known===digest;
        if(duplicate)duplicateCount+=1;
        record(scenario.id,'duplicate',{duplicate,additionalDispatches:dispatchCount-before});
        if(!duplicate||dispatchCount-before!==scenario.expect?.additionalDispatches)fail(scenario.id,'duplicate was not exactly-once');
      }else if(scenario.kind==='identity-conflict'){
        const original=eventById.get(scenario.eventId);
        if(!original)throw new Error('identity-conflict source event is missing');
        const before=dispatchCount,changed={...original,amount:scenario.replacementAmount};
        const conflict=identities.get(scenario.eventId)!==fingerprint(changed);
        if(conflict)identityConflictCount+=1;
        record(scenario.id,'identity_conflict',{identityConflict:conflict,additionalDispatches:dispatchCount-before});
        if(!conflict||dispatchCount-before!==scenario.expect?.additionalDispatches)fail(scenario.id,'changed identity did not fail closed');
      }else{
        fail(scenario.id,'unknown fixture kind');
      }
    }catch(error){
      fail(scenario.id,String(error?.message||error));
    }
  }

  const checks={
    fixtureVersion:fixture?.schemaVersion===1,
    allScenariosExecuted:new Set(timeline.map(item=>item.id)).size===(fixture?.events||[]).length,
    noFailures:failures.length===0,
    exactlyOnce:duplicateCount===1&&dispatchCount===2,
    identityChangesFailClosed:identityConflictCount===1,
    subscriptionsSeparated:subscriptionCount===1,
    traceContinuity:timeline.filter(item=>item.stage==='roulette_dispatched').every(item=>item.traceId),
    resultTtsAfterSelection:timeline.filter(item=>item.stage==='roulette_dispatched').every(item=>item.result===item.ttsText)
  };
  return {
    schemaVersion:1,mode:'offline-production-function-replay',
    safety:{networkRequests:false,databaseWrites:false,productionDispatch:false},
    passed:Object.values(checks).every(Boolean),checks,
    summary:{scenarios:(fixture?.events||[]).length,dispatchCount,duplicateCount,identityConflictCount,subscriptionCount},
    failures,timeline
  };
}
