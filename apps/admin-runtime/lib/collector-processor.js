import {sb as serviceRest} from './supabase-rest.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {collectorSubscriptionInfo} from './collector-subscription.js';
import {createHash} from 'node:crypto';

const ACTIVE_STATES=['pending','needs_review','failed'];
const processingContext=new AsyncLocalStorage();
const sb=(table,path='',options={})=>serviceRest(table,path,{...options,signal:options.signal||processingContext.getStore()?.signal});

function q(v){return encodeURIComponent(String(v??''));}
function wsp(path,workspaceId){if(!workspaceId)return path||'';const p=path||'';return `${p}${p.includes('?')?'&':'?'}workspace_id=eq.${q(workspaceId)}`;}
function wsb(body,workspaceId){
  if(!workspaceId||!body||typeof body!=='object')return body;
  if(Array.isArray(body))return body.map(row=>row&&typeof row==='object'?{...row,workspace_id:workspaceId}:row);
  return {...body,workspace_id:workspaceId};
}
function nowIso(){return new Date().toISOString();}
function receiptProvider(row){return ['soop_chat_sdk','overlay_result'].includes(collectorProvider(row));}
function collectorProvider(row){
  if(row?.raw_payload?.source_provider==='overlay_result')return 'overlay_result';
  return String(row?.raw_payload?.source_provider||'').trim()==='soop_chat_sdk'
    ?'soop_chat_sdk':'weflab_collector';
}
function collectorSourceKey(row){
  const uid=String(row?.source_uid||'').trim();
  if(collectorProvider(row)==='overlay_result')return uid;
  if(receiptProvider(row))return uid.startsWith('soop_sdk:')?uid:`soop_sdk:${uid}`;
  return uid.startsWith('weflab:')?uid:`weflab:${uid}`;
}

function collectorDateTime(row){
  const s=String(row.donated_time_text||'').trim();
  const m=s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if(m)return {date:`${m[1]}-${m[2]}-${m[3]}`,time:`${m[4]}:${m[5]}:${m[6]||'00'}`,at:`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]||'00'}+09:00`};
  const d=new Date(row.uploaded_at||Date.now()),p=n=>String(n).padStart(2,'0');
  return {date:`${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`,time:`${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,at:d.toISOString()};
}

function collectorResultList(row){
  if(Array.isArray(row.roulette_results))return row.roulette_results.map(x=>({
    result:String(x?.result??x?.Result??''),probability:String(x?.probability??x?.Probability??''),
    ...(receiptProvider(row)&&typeof x?.receipt_identity==='string'
      ?{receipt_identity:x.receipt_identity}:{}),
    ...(receiptProvider(row)&&x&&Object.hasOwn(x,'special_roulette')
      ?{special_roulette:x.special_roulette}:{})
  })).filter(x=>x.result);
  const raw=row.raw_payload||{};let list=raw.list;
  try{if(typeof list==='string')list=JSON.parse(list)}catch{list=null}
  if(Array.isArray(list)&&list.length)return list.map(x=>Array.isArray(x)?{result:String(x[0]||''),probability:String(x[1]??'')}:{result:String(x||''),probability:''}).filter(x=>x.result);
  const winner=String(row.roulette||raw.roulette||'').trim();
  return winner?[{result:winner,probability:String(raw.percent||'')}]:[];
}

// These decisions are written by ownership-checked ingestion in the same FIFO
// transaction as the result. Never infer a past decision from today's settings.
function storedSpecialRouletteDecision(item){
  if(!Object.hasOwn(item,'special_roulette'))return {rewardMultiplier:1,multiplierControl:false};
  const decision=item.special_roulette;
  if(!decision||typeof decision!=='object'||Array.isArray(decision)
    ||decision.version!==1
    ||typeof decision.sourceEventKey!=='string'
    ||!decision.sourceEventKey.startsWith('soop_result:')||decision.sourceEventKey.length<=12
    ||decision.sourceEventKey.length>512||/[\u0000-\u001f\u007f]/u.test(decision.sourceEventKey)
    ||!Number.isInteger(decision.appliedMultiplier)||decision.appliedMultiplier<1||decision.appliedMultiplier>100
    ||typeof decision.controlEvent!=='boolean'
    ||(decision.controlEvent&&decision.appliedMultiplier!==1)
    ||(decision.pendingMultiplier!==null&&(!Number.isInteger(decision.pendingMultiplier)
      ||decision.pendingMultiplier<2||decision.pendingMultiplier>100)))return null;
  return {rewardMultiplier:decision.appliedMultiplier,multiplierControl:decision.controlEvent};
}


function fixedRewardList(row){
  let list=row?.fixed_rewards;
  try{if(typeof list==='string')list=JSON.parse(list)}catch{list=[]}
  if(!Array.isArray(list))return [];
  return list.map(x=>({
    event_name:String(x?.event_name??x?.eventName??x?.EventName??'').trim(),
    upbo_type:String(x?.upbo_type??x?.upboType??x?.UpboType??'').trim(),
    quantity:Math.max(1,Math.trunc(Number(x?.quantity??x?.Quantity??1)||1))
  })).filter(x=>x.event_name&&x.upbo_type);
}

function donationKind(row){
  if(collectorSubscriptionInfo(row).isSubscription)return 'subscription';
  const raw=row?.raw_payload||{};
  const type=String(raw?.type||raw?.subtype||'').trim().toUpperCase();
  const subtype=String(raw?.subtype||'').trim().toUpperCase();
  if(type==='CHALLENGE_SETTLE'||subtype==='CHALLENGE_SETTLE')return 'challenge_success';
  if(type==='CHALLENGE_GIFT'||subtype==='CHALLENGE_GIFT')return 'mission';
  if(type==='VIDEOBALLOON'||subtype==='VIDEOBALLOON')return 'video';
  if(type==='SENDBALLOON'||subtype==='SENDBALLOON')return collectorResultList(row).length?'roulette':'normal';
  const v=String(row?.validation||'').toLowerCase();
  if(v==='matched')return 'roulette';
  if(v==='unmapped')return 'normal';
  return 'unknown';
}
function donationKindLabel(row){
  const k=donationKind(row);
  return k==='subscription'?'구독':k==='challenge_success'?'도전성공':k==='mission'?'미션후원':k==='video'?'영상후원':k==='roulette'?'룰렛후원':k==='normal'?'일반후원':'알 수 없음';
}

export function splitUpboOutputTypes(text){
  const s=String(text||'').trim().normalize('NFC');
  if(!s)return [];
  return s.split(/\s*&\s*/u).map(value=>value.trim()).filter(Boolean);
}

async function loadRules(workspaceId){
  const legacyRows=await sb('bangsel_roulette_rules',wsp('?select=result_text,action,output_types',workspaceId));
  const map=new Map();
  for(const r of Array.isArray(legacyRows)?legacyRows:[])map.set(String(r.result_text||''),r);
  return map;
}

function collectorRuleFor(rules,row,resultText){
  const result=String(resultText||'');
  return rules.get(result)||null;
}

function relationRows(value){return Array.isArray(value)?value:(value&&typeof value==='object'?[value]:[]);}
function conditionValue(rule,path){return relationRows(rule?.rule_conditions).find(item=>item?.path===path&&item?.operator==='eq')?.value??null;}
async function loadRewardMultiplierRules(workspaceId){
  const select='id,priority,rule_conditions(position,path,operator,value),rule_actions(position,action_type,params)';
  const rows=await sb('rules',wsp(`?select=${q(select)}&enabled=eq.true&superseded_at=is.null&order=priority.desc,id.asc&limit=100`,workspaceId));
  const map=new Map();
  for(const rule of Array.isArray(rows)?rows:[]){
    const action=relationRows(rule?.rule_actions).find(item=>item?.action_type==='log'&&item?.params?.controlType==='next_roulette_reward_multiplier');
    if(!action)continue;
    const source=String(conditionValue(rule,'source')||'');
    const eventType=String(conditionValue(rule,'type')||'');
    const result=String(conditionValue(rule,'payload.result')||'');
    const multiplier=Math.trunc(Number(action.params?.multiplier));
    if(!source||eventType!=='roulette'||!result||multiplier<2||multiplier>100)continue;
    const key=`${source}\u001f${result}`;
    if(!map.has(key))map.set(key,{multiplier,allowStacking:action.params?.allowStacking===true});
  }
  return map;
}

export function assessCollectorRow(row,rules,multiplierRules,{allowValidationReview=false}={}){
  const validation=String(row.validation||'');
  const kind=donationKind(row);
  const results=collectorResultList(row);
  const fixedRewards=fixedRewardList(row);
  if(receiptProvider(row)&&results.some(item=>!storedSpecialRouletteDecision(item)))
    return {processable:false,reason:'invalid_special_roulette_decision',donationKind:kind};

  // 구독 개월 수는 별풍선 수가 아니며 후원 통계·고정 규칙·룰렛 액션 대상이 아닙니다.
  if(kind==='subscription')return {processable:true,statOnly:true,recordDonation:false,results:[],fixedRewards:[],donationKind:kind};

  // CHALLENGE_SETTLE은 도전미션 성공 후 스트리머에게 정산된 별풍선입니다.
  // 후원자 없는 시스템 정산 건이므로 일반 후원/업보로 만들지 않고 원본 내역만 보존합니다.
  if(kind==='challenge_success')return {processable:true,statOnly:true,recordDonation:true,results:[],fixedRewards:[],donationKind:kind};

  // Donation-time activation snapshot: preserve result history and fixed
  // rewards, but never retroactively activate donations received while off.
  if(receiptProvider(row)&&row.raw_payload?.roulette_enabled===false)
    return {processable:true,statOnly:fixedRewards.length===0,recordDonation:kind!=='mission',results,fixedRewards,donationKind:kind,rouletteDisabled:true};

  // 영상후원은 실제 지급 후원입니다. 고정 규칙이 있으면 통계와 고정 업보를 함께 처리합니다.
  if(kind==='video')return {processable:true,statOnly:fixedRewards.length===0,recordDonation:true,results,fixedRewards,donationKind:kind};

  // CHALLENGE_GIFT는 미션에 별풍선을 거는 시점입니다. 지급 통계에는 넣지 않지만,
  // 룰렛 업보와 명시적으로 설정된 고정 규칙은 처리할 수 있습니다.
  if(kind==='mission'){
    if(results.length){
      for(const rr of results){
        if(receiptProvider(row)&&storedSpecialRouletteDecision(rr).multiplierControl)continue;
        const rule=collectorRuleFor(rules,row,rr.result);
        const multiplierRule=receiptProvider(row)?null:multiplierRules.get(`weflab\u001f${rr.result}`);
        if((!rule&&!multiplierRule)||rule?.action==='review')return {processable:false,reason:'unknown_rule',donationKind:kind};
      }
    }
    return {processable:true,statOnly:results.length===0&&fixedRewards.length===0,recordDonation:false,results,fixedRewards,donationKind:kind};
  }

  // 자동 처리에서는 회전 수 불일치(short/over)를 계속 보수적으로 막습니다.
  // 다만 대시보드에서 사용자가 현재 수신 결과를 확인하고 명시적으로 일괄 등록한 경우에만
  // 이후의 학습 규칙 검사를 통과하도록 허용합니다. 미분류/결과 없음은 아래에서 계속 차단됩니다.
  if(['short','over'].includes(validation)){
    if(!allowValidationReview)
      return {processable:false,reason:'validation_review',donationKind:kind};
    // 결과가 하나도 없는 short 행은 현재 반영할 룰렛 결과 자체가 없습니다.
    // 고정 업보가 있더라도 행 전체를 완료 처리하면 뒤늦게 들어온 룰렛 결과를 잃을 수 있으므로 유지합니다.
    if(results.length===0)
      return {processable:false,reason:'no_roulette_result',donationKind:kind};
  }

  // 룰렛 이벤트가 없어도 고정 규칙이 있으면 업보 생성까지 진행합니다.
  if(!String(row.event_name||'').trim()&&!results.length)
    return {processable:true,statOnly:fixedRewards.length===0,recordDonation:true,results,fixedRewards,donationKind:kind};

  if(results.length){
    for(const rr of results){
      if(receiptProvider(row)&&storedSpecialRouletteDecision(rr).multiplierControl)continue;
      const rule=collectorRuleFor(rules,row,rr.result);
      const multiplierRule=receiptProvider(row)?null:multiplierRules.get(`weflab\u001f${rr.result}`);
      if((!rule&&!multiplierRule)||rule?.action==='review')return {processable:false,reason:'unknown_rule',donationKind:kind};
    }
  }else if(String(row.event_name||'').trim()&&fixedRewards.length===0){
    return {processable:false,reason:'no_roulette_result',donationKind:kind};
  }
  return {processable:true,statOnly:results.length===0&&fixedRewards.length===0,recordDonation:true,results,fixedRewards,donationKind:kind};
}

export function stableDevelopmentHash(seed){return createHash('sha256').update(String(seed),'utf8').digest('hex').slice(0,32);}
export function rouletteExternalEventId(row,index){
  const provider=receiptProvider(row)?'soop_sdk':'weflab';
  const base=`${provider}_${stableDevelopmentHash(`${row.session_id||''}|${row.source_uid||''}|${row.donated_time_text||''}`)}`;
  return `${base}_roulette_${index+1}`;
}
export function rewardMultiplierLedgerKeys(baseKey,multiplier){
  const count=Math.max(1,Math.min(100,Math.trunc(Number(multiplier)||1)));
  return Array.from({length:count},(_,index)=>index===0?baseKey:`${baseKey}|reward-multiplier-${index+1}`);
}
async function resolveRewardMultipliers(row,results,multiplierRules,workspaceId){
  if(receiptProvider(row)){
    return results.map(item=>{
      const decision=storedSpecialRouletteDecision(item);
      if(!decision)throw new Error('Stored special roulette decision is invalid');
      return {...item,...decision};
    });
  }
  const actorId=String(row.soop_id||'').trim();
  const resolved=[];
  for(let index=0;index<results.length;index++){
    const item=results[index];
    const control=multiplierRules.get(`weflab\u001f${item.result}`)||null;
    const response=await sb('rpc/resolve_roulette_reward_multiplier_v1','',{method:'POST',body:{
      p_workspace_id:workspaceId,
      p_source_event_key:rouletteExternalEventId(row,index),
      p_actor_id:actorId||null,
      p_result:item.result,
      p_configured_multiplier:control?.multiplier??null,
      p_allow_stacking:control?control.allowStacking:null
    }});
    const multiplier=Math.max(1,Math.min(100,Math.trunc(Number(response?.appliedMultiplier)||1)));
    resolved.push({...item,rewardMultiplier:multiplier,multiplierControl:Boolean(control)});
  }
  return resolved;
}

async function claimRow(uid,allowFailed=false,workspaceId=null){
  const states=allowFailed?'pending,needs_review,failed':'pending,needs_review';
  try{
    const rows=await sb('bangsel_collector_staging',wsp(`?source_uid=eq.${q(uid)}&process_status=in.(${states})`,workspaceId),{
      method:'PATCH',prefer:'return=representation',
      body:{process_status:'processing',processing_started_at:nowIso(),process_error:null}
    });
    return Array.isArray(rows)&&rows.length?rows[0]:null;
  }catch(e){
    // v7.4 migration 전에도 핵심 자동처리는 동작하도록 새 진단 컬럼이 없는 구형 staging에 fallback.
    const rows=await sb('bangsel_collector_staging',wsp(`?source_uid=eq.${q(uid)}&process_status=in.(${states})`,workspaceId),{
      method:'PATCH',prefer:'return=representation',body:{process_status:'processing'}
    });
    return Array.isArray(rows)&&rows.length?rows[0]:null;
  }
}

async function markRow(uid,status,extra={},workspaceId=null,{expectedUploadedAt=null,requireProcessing=false}={}){
  const terminal=status==='processed'||status==='ignored';
  const body={process_status:status,processing_started_at:null,...extra};
  if(terminal)body.processed_at=nowIso();
  const filters=[`source_uid=eq.${q(uid)}`];
  if(expectedUploadedAt)filters.push(`uploaded_at=eq.${q(expectedUploadedAt)}`);
  if(requireProcessing)filters.push('process_status=eq.processing');
  const path=wsp(`?${filters.join('&')}`,workspaceId);
  try{return await sb('bangsel_collector_staging',path,{method:'PATCH',body});}
  catch(e){
    const fallback={process_status:status};if(terminal)fallback.processed_at=nowIso();
    return sb('bangsel_collector_staging',path,{method:'PATCH',body:fallback});
  }
}

async function requeueChangedClaim(uid,claimedUploadedAt,workspaceId=null){
  // 처리 중 같은 source_uid가 merge-upsert되면 새 uploaded_at 버전을 완료 처리하면 안 됩니다.
  // 현재 processing 버전을 조건부로 pending에 돌려 다음 분류가 반드시 최신 내용을 다시 읽게 합니다.
  for(let attempt=0;attempt<3;attempt++){
    const rows=await sb('bangsel_collector_staging',wsp(`?select=uploaded_at,process_status&source_uid=eq.${q(uid)}&limit=1`,workspaceId));
    const current=Array.isArray(rows)?rows[0]:null;
    if(!current||String(current.process_status||'')!=='processing')return;
    const uploadedAt=String(current.uploaded_at||'');
    if(!uploadedAt||uploadedAt===String(claimedUploadedAt||''))return;
    const reset=await markRow(uid,'pending',{},workspaceId,{expectedUploadedAt:uploadedAt,requireProcessing:true});
    if(Array.isArray(reset)&&reset.length)return;
  }
}

async function finishClaimedRow(claimed,status,extra={},workspaceId=null){
  const uploadedAt=String(claimed?.uploaded_at||'');
  const updated=await markRow(claimed.source_uid,status,extra,workspaceId,{
    expectedUploadedAt:uploadedAt,
    requireProcessing:true
  });
  if(Array.isArray(updated)&&updated.length)return true;
  await requeueChangedClaim(claimed.source_uid,uploadedAt,workspaceId);
  return false;
}

async function recoverStaleProcessing(workspaceId=null){
  try{
    const cutoff=new Date(Date.now()-10*60*1000).toISOString();
    const rows=await sb('bangsel_collector_staging',wsp(`?select=source_uid&process_status=eq.processing&processing_started_at=lt.${q(cutoff)}&limit=100`,workspaceId));
    for(const r of Array.isArray(rows)?rows:[])await markRow(r.source_uid,'failed',{process_error:'stale processing recovered'},workspaceId);
    return Array.isArray(rows)?rows.length:0;
  }catch{return 0}
}

async function saveDonation(row,results,workspaceId=null){
  // Overlay is authoritative for upbo only. SOOP already owns donation statistics.
  if(collectorProvider(row)==='overlay_result')return;
  const kind=donationKind(row);
  const isChallengeSuccess=kind==='challenge_success';
  if((+row.balloons||0)<=0||(!isChallengeSuccess&&(!row.soop_id||!row.nickname)))return;
  const dt=collectorDateTime(row);
  const body={
    source_event_key:collectorSourceKey(row),
    source:collectorProvider(row),donation_type:donationKindLabel(row),
    donated_date:dt.date,donated_time:dt.time,donated_at:dt.at,
    soop_id:isChallengeSuccess?'__challenge_settle__':String(row.soop_id),nickname:isChallengeSuccess?'도전성공':String(row.nickname),balloons:+row.balloons||0,
    message:(row.raw_payload&&row.raw_payload.msg)||null,
    had_roulette:results.length>0,roulette_count:results.length,roulette_results:results,
    event_name:row.event_name||null,raw_payload:row.raw_payload||{},workspace_id:workspaceId||row.workspace_id||null
  };
  await sb('bangsel_donations','?on_conflict=workspace_id,source_event_key',{method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body});
}

function stationUrl(id){return id?`https://ch.sooplive.co.kr/${encodeURIComponent(id)}`:'';}
async function ensureFan(row,workspaceId=null){
  const id=String(row.soop_id||'').trim();if(!id)return;
  const found=await sb('bangsel_fans',wsp(`?select=*&soop_id=eq.${q(id)}&limit=1`,workspaceId)),old=Array.isArray(found)?found[0]:null;
  if(old){
    const patch={};
    if(row.nickname&&old.current_nickname!==row.nickname)patch.current_nickname=row.nickname;
    if(!old.station_url)patch.station_url=stationUrl(id);
    if(Object.keys(patch).length){
      const saved=await sb('bangsel_fans',wsp(`?soop_id=eq.${q(id)}`,workspaceId),{method:'PATCH',body:patch});
      return Array.isArray(saved)&&saved[0]?saved[0]:{...old,...patch};
    }
    return old;
  }else{
    const body={soop_id:id,alias:row.nickname||id,current_nickname:row.nickname||id,station_url:stationUrl(id),workspace_id:workspaceId||row.workspace_id||null};
    const saved=await sb('bangsel_fans','',{method:'POST',body});
    return Array.isArray(saved)&&saved[0]?saved[0]:body;
  }
}

async function rouletteIsVoided(uid,workspaceId=null){
    const r=await sb('bangsel_roulette_invalidations',wsp(`?select=source_uid&source_uid=eq.${q(uid)}&limit=1`,workspaceId));
    if(!Array.isArray(r))throw new Error('룰렛 무효화 상태를 확인하지 못했습니다.');
    return r.length>0;
}

async function processTaskGroup(group,row,profile,workspaceId=null){
  if(!workspaceId)throw new Error('Upbo workspace is required');
  if(!group.keys.length)return {taskId:null,added:0};
  // Ledger and quantity must commit together. Never fall back to split REST writes.
  const result=await sb('rpc/byeollog_commit_upbo_group_v1','',{method:'POST',body:{
    p_workspace_id:workspaceId,p_group:{...group,receiptProtocol:2,
      fan:profile?.alias||row.nickname||row.soop_id||'미지정',added_date:collectorDateTime(row).date}
  }});
  if(!Number.isSafeInteger(result?.added)||result.added<0||result.added>group.keys.length)
    throw new Error('Upbo atomic commit response is invalid');
  return result;
}

async function createTasks(row,results,rules,profile,workspaceId=null){
  const groups=new Map();
  const soopSdk=receiptProvider(row);
  for(let ri=0;ri<results.length;ri++){
    const rr=results[ri],rule=collectorRuleFor(rules,row,rr.result);
    if(rr.multiplierControl||!rule||rule.action!=='include')continue;
    const rawOuts=Array.isArray(rule.output_types)&&rule.output_types.length?rule.output_types:[rr.result];
    const outs=rawOuts.flatMap(splitUpboOutputTypes);
    for(let oi=0;oi<outs.length;oi++){
      const type=String(outs[oi]||'').trim();if(!type)continue;
      const gkey=[row.soop_id||'',row.event_name||'',type].join('|');
      if(!groups.has(gkey))groups.set(gkey,{soop_id:row.soop_id||'',event:row.event_name||'',type,keys:[],
        source:soopSdk?'soop_chat_sdk_result':'weflab_roulette',
        taskSource:soopSdk?'soop_chat_sdk_grouped':'weflab_roulette_grouped'});
      // Later spins can reorder a staging array (including equal-timestamp
      // results). New receipts identify the result itself, never its position.
      // Keep historical keys unchanged so pre-feature rows stay idempotent.
      const resultIdentity=soopSdk&&rr.special_roulette
        ?`soop-result:${q(rr.special_roulette.sourceEventKey)}`
        :soopSdk&&rr.receipt_identity?rr.receipt_identity:ri;
      const baseKey=`${collectorSourceKey(row)}|${resultIdentity}|${oi}|${type}`;
      groups.get(gkey).keys.push(...rewardMultiplierLedgerKeys(baseKey,rr.rewardMultiplier));
    }
  }
  let added=0;for(const g of groups.values())added+=(await processTaskGroup(g,row,profile,workspaceId)).added;return added;
}


async function createFixedTasks(row,fixedRewards,profile,workspaceId=null){
  const groups=new Map();
  for(let ri=0;ri<fixedRewards.length;ri++){
    const reward=fixedRewards[ri],event=String(reward.event_name||'').trim();
    const types=splitUpboOutputTypes(reward.upbo_type);
    if(!event||!types.length)continue;
    const qty=Math.max(1,Math.trunc(Number(reward.quantity)||1));
    for(let oi=0;oi<types.length;oi++){
      const type=types[oi];
      const gkey=[row.soop_id||'',event,type].join('|');
      if(!groups.has(gkey))groups.set(gkey,{soop_id:row.soop_id||'',event,type,keys:[],source:'collector_fixed_rule',taskSource:'collector_fixed_grouped'});
      const g=groups.get(gkey);
      for(let qi=0;qi<qty;qi++){
        const identity=types.length===1
          ?`fixed:${row.source_uid}|${ri}|${qi}|${event}|${type}`
          :`fixed:${row.source_uid}|${ri}|${oi}|${qi}|${event}|${type}`;
        g.keys.push(identity);
      }
    }
  }
  let added=0;for(const g of groups.values())added+=(await processTaskGroup(g,row,profile,workspaceId)).added;return added;
}

async function processOne(row,rules,multiplierRules,{allowFailed=false,approvedUploadedAt=null,workspaceId=null}={}){
  try{
    if(await rouletteIsVoided(row.source_uid,workspaceId))return {uid:row.source_uid,status:'voided',tasks:0};
  }catch(e){return {uid:row.source_uid,status:'failed',tasks:0,error:String(e?.message||e)};}
  // 명시적 승인이 없는 보수적 판정으로 먼저 불필요한 claim을 피합니다.
  // validation_review만 클릭 당시 승인 후보라면 claim 후 최신 행을 다시 판정합니다.
  const initialAssessment=assessCollectorRow(row,rules,multiplierRules);
  const mayUseValidationApproval=!initialAssessment.processable
    &&initialAssessment.reason==='validation_review'
    &&!!approvedUploadedAt;
  const hasIndependentFixed=fixedRewardList(row).length>0
    &&['unknown_rule','validation_review','no_roulette_result'].includes(initialAssessment.reason);
  if(!initialAssessment.processable&&!mayUseValidationApproval&&!hasIndependentFixed)
    return {uid:row.source_uid,status:'pending',reason:initialAssessment.reason};
  const claimed=await claimRow(row.source_uid,allowFailed,workspaceId);
  if(!claimed)return {uid:row.source_uid,status:'skipped',reason:'not_claimed'};
  try{
    // fetch와 claim 사이에 같은 UID가 merge-upsert될 수 있으므로 반드시 claimed 최신 스냅샷을 재평가합니다.
    // 경고 우회는 승인 당시 uploaded_at과 최신 행이 정확히 같을 때만 유효합니다.
    const allowValidationReview=!!approvedUploadedAt&&String(claimed.uploaded_at||'')===approvedUploadedAt;
    const assessment=assessCollectorRow(claimed,rules,multiplierRules,{allowValidationReview});
    if(!assessment.processable){
      let fixedAdded=0;
      if(['unknown_rule','validation_review','no_roulette_result'].includes(assessment.reason)
        &&fixedRewardList(claimed).length){
        // Fixed rewards do not depend on roulette classification. Keep the
        // roulette row pending; its independent receipt keys make retries safe.
        const profile=await ensureFan(claimed,workspaceId);
        fixedAdded=await createFixedTasks(claimed,fixedRewardList(claimed),profile,workspaceId);
      }
      await finishClaimedRow(claimed,assessment.reason==='unknown_rule'?'needs_review':'pending',{},workspaceId);
      return {uid:claimed.source_uid,status:'pending',reason:assessment.reason,tasks:fixedAdded,fixed_tasks:fixedAdded};
    }
    // 시도 횟수는 진단용 컬럼이 설치된 경우에만 증가시킨다.
    try{await sb('bangsel_collector_staging',wsp(`?source_uid=eq.${q(row.source_uid)}&uploaded_at=eq.${q(claimed.uploaded_at)}&process_status=eq.processing`,workspaceId),{method:'PATCH',body:{process_attempts:(Number(claimed.process_attempts)||0)+1}})}catch{}
    // 배수는 같은 후원자의 '바로 다음 룰렛 결과'에서 반드시 1회 소모한다.
    // 비업보/비액션 결과도 꽝으로 소비되어야 하므로 보상 생성 여부를 판단하기 전에 해소한다.
    const resolvedResults=await resolveRewardMultipliers(claimed,assessment.rouletteDisabled?[]:(assessment.results||[]),multiplierRules,workspaceId);
    if(assessment.recordDonation!==false)await saveDonation(claimed,assessment.results||[],workspaceId);
    const profile=await ensureFan(claimed,workspaceId);
    if(assessment.statOnly){
      const finished=await finishClaimedRow(claimed,'processed',{},workspaceId);
      return finished
        ? {uid:claimed.source_uid,status:'processed',tasks:0}
        : {uid:claimed.source_uid,status:'pending',reason:'row_changed_during_processing',tasks:0};
    }
    const fixedAdded=await createFixedTasks(claimed,assessment.fixedRewards||[],profile,workspaceId);
    const rouletteAdded=await createTasks(claimed,resolvedResults,rules,profile,workspaceId);
    const added=fixedAdded+rouletteAdded;
    const allExcluded=(assessment.results||[]).length>0&&(assessment.results||[]).every(x=>collectorRuleFor(rules,claimed,x.result)?.action==='exclude');
    // 고정 업보가 생성되었다면 룰렛 결과가 전부 비업보여도 이 후원 자체는 정상 처리로 남깁니다.
    const status=allExcluded&&fixedAdded===0?'ignored':'processed';
    const finished=await finishClaimedRow(claimed,status,{},workspaceId);
    return finished
      ? {uid:claimed.source_uid,status,tasks:added,fixed_tasks:fixedAdded,roulette_tasks:rouletteAdded}
      : {uid:claimed.source_uid,status:'pending',reason:'row_changed_during_processing',tasks:added,fixed_tasks:fixedAdded,roulette_tasks:rouletteAdded};
  }catch(e){
    const claimedForFailure=typeof claimed==='object'&&claimed?claimed:row;
    await finishClaimedRow(claimedForFailure,'failed',{process_error:String(e?.message||e).slice(0,2000)},workspaceId).catch(()=>{});
    return {uid:row.source_uid,status:'failed',error:String(e?.message||e)};
  }
}

async function fetchRows({sourceUids,includeFailed=false,limit=500,workspaceId=null}={}){
  if(Array.isArray(sourceUids)&&sourceUids.length){
    const rows=[];
    for(const uid of sourceUids){
      const r=await sb('bangsel_collector_staging',wsp(`?select=*&source_uid=eq.${q(uid)}&limit=1`,workspaceId));
      if(Array.isArray(r)&&r[0])rows.push(r[0]);
    }
    return rows;
  }
  const states=includeFailed?'pending,needs_review,failed':'pending,needs_review';
  const r=await sb('bangsel_collector_staging',wsp(`?select=*&process_status=in.(${states})&order=uploaded_at.asc&limit=${Math.min(1000,Math.max(1,limit))}`,workspaceId));
  return Array.isArray(r)?r:[];
}

export function processPendingCollectorRows(opt={}){
  return processingContext.run({signal:opt.signal},()=>processPendingCollectorRowsCore(opt));
}

async function processPendingCollectorRowsCore(opt={}){
  if(!opt.skipStaleRecovery)await recoverStaleProcessing(opt.workspaceId||null);
  const [rules,multiplierRules]=await Promise.all([
    loadRules(opt.workspaceId||null),
    loadRewardMultiplierRules(opt.workspaceId||null)
  ]);
  const rows=await fetchRows(opt);
  const results=[];
  for(const row of rows){
    if(!ACTIVE_STATES.includes(String(row.process_status||'')))continue;
    const approvedUploadedAt=opt.validationReviewApprovals instanceof Map
      ? opt.validationReviewApprovals.get(String(row.source_uid||''))
      : null;
    results.push(await processOne(row,rules,multiplierRules,{
      allowFailed:!!opt.includeFailed,
      approvedUploadedAt:approvedUploadedAt||null,
      workspaceId:opt.workspaceId||row.workspace_id||null
    }));
  }
  const counts={processed:0,ignored:0,pending:0,failed:0,skipped:0,voided:0,tasks:0};
  const pendingReasons={};
  for(const r of results){
    if(r.status in counts)counts[r.status]++;
    counts.tasks+=Number(r.tasks)||0;
    if(r.status==='pending'&&r.reason){
      const reason=String(r.reason);
      pendingReasons[reason]=(pendingReasons[reason]||0)+1;
    }
  }
  return {ok:counts.failed===0,counts,pending_reasons:pendingReasons,results};
}
