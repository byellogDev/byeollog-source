import {sb} from './supabase-rest.js';

const HOUR=3600000,DAY=24*HOUR;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
export function reportDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))throw fail('날짜를 선택해주세요.');
  const t=Date.parse(value+'T00:00:00Z');
  if(!Number.isFinite(t)||new Date(t).toISOString().slice(0,10)!==value)throw fail('올바른 날짜를 선택해주세요.');
  return value;
}
function localTime(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value))return NaN;
  try{reportDate(value.slice(0,10))}catch{return NaN}
  return Date.parse(value.replace(' ','T')+'+09:00');
}
const dayOf=t=>new Date(t+9*HOUR).toISOString().slice(0,10);
const median=values=>{const a=[...values].sort((a,b)=>a-b),m=Math.floor(a.length/2);return a.length?(a.length%2?a[m]:(a[m-1]+a[m])/2):0};
export function reportStarts(collector,wallpaper){
  const times=[...collector.map(r=>localTime(r.broadcast_start_local)),...wallpaper.map(r=>Date.parse(r.started_at))];
  return [...new Set(times.filter(Number.isFinite))].sort((a,b)=>a-b);
}
export function buildDonationReport(starts,rows,{from,to}){
  reportDate(from);reportDate(to);if(from>to)throw fail('시작일이 종료일보다 늦습니다.');
  starts=[...new Set(starts.filter(Number.isFinite))].sort((a,b)=>a-b);
  const sessions=starts.map((t,i)=>({t,next:starts[i+1]??Infinity,date:dayOf(t),start:new Date(t+9*HOUR).toISOString().slice(0,19),bins:Array(6).fill(0),count:0})).filter(s=>s.date>=from&&s.date<=to);
  const excluded={missionAmount:0,missionCount:0,subscriptionCount:0,unknownCount:0,unassignedAmount:0,unassignedCount:0,invalidCount:0};
  const seen=new Set();
  for(const r of rows){
    if(r.source_event_key){if(seen.has(r.source_event_key))continue;seen.add(r.source_event_key)}
    let t=localTime((r.donated_date||'')+'T'+(r.donated_time||''));
    if(!Number.isFinite(t))t=Date.parse(r.donated_at);
    const amount=Number(r.balloons);
    if(!Number.isFinite(t)||!Number.isSafeInteger(amount)||amount<0){excluded.invalidCount++;continue}
    // One event belongs to at most one start. The following start cuts a window.
    let lo=0,hi=sessions.length-1,idx=-1;
    while(lo<=hi){const mid=(lo+hi)>>1;if(sessions[mid].t<=t){idx=mid;lo=mid+1}else hi=mid-1}
    const s=sessions[idx];
    if(!s||t>=s.next||t>=s.t+3*HOUR){if(dayOf(t)>=from&&dayOf(t)<=to){excluded.unassignedAmount+=amount;excluded.unassignedCount++}continue}
    const type=String(r.donation_type||'').replace(/\s/g,'').toLowerCase(),raw=String(r.raw_type||r.raw_payload?.type||'').toUpperCase(),sub=String(r.raw_subtype||r.raw_payload?.subtype||'').toUpperCase();
    if(type.includes('구독')||type==='subscription'||[raw,sub].some(v=>v==='FOLLOW_ITEM'||v==='FOLLOW_ITEM_EFFECT')){excluded.subscriptionCount++;continue}
    if(/미션|도전|mission|challenge/.test(type)||[raw,sub].some(v=>v.startsWith('CHALLENGE_'))){excluded.missionAmount+=amount;excluded.missionCount++;continue}
    if(!['일반후원','별풍선','룰렛후원','영상후원','normal','roulette','video'].includes(type)){excluded.unknownCount++;continue}
    s.bins[Math.floor((t-s.t)/(HOUR/2))]+=amount;s.count++;
  }
  const safeSessions=sessions.map(s=>({start:s.start,date:s.date,hour:Number(s.start.slice(11,13)),eligible:s.next-s.t>=3*HOUR,availableMinutes:Math.min(180,(s.next-s.t)/60000),bins:s.bins,total:s.bins.reduce((a,b)=>a+b,0),count:s.count}));
  const comparable=safeSessions.filter(s=>s.eligible),n=comparable.length;
  const means=Array.from({length:6},(_,i)=>n?comparable.reduce((v,s)=>v+s.bins[i],0)/n:0),medians=Array.from({length:6},(_,i)=>median(comparable.map(s=>s.bins[i])));
  const groups=[...new Set(comparable.map(s=>s.hour))].sort((a,b)=>a-b).map(hour=>{const vals=comparable.filter(s=>s.hour===hour).map(s=>s.total);return {hour,count:vals.length,values:vals,mean:vals.reduce((a,b)=>a+b,0)/vals.length,median:median(vals)}});
  return {version:1,from,to,generatedAt:new Date().toISOString(),startCount:safeSessions.length,comparableCount:n,overlapCount:safeSessions.length-n,total:comparable.reduce((a,s)=>a+s.total,0),count:comparable.reduce((a,s)=>a+s.count,0),means,medians,groups,sessions:safeSessions,excluded,peakBin:means.some(v=>v>0)?means.indexOf(Math.max(...means)):null};
}

async function allRows(table,fields,order,params,{sbImpl,signal}){
  const out=[],limit=1000,cap=50000;
  for(let offset=0;offset<=cap;offset+=limit){
    const q=new URLSearchParams({...params,select:fields,order,limit:String(limit),offset:String(offset)});
    const rows=await sbImpl(table,'?'+q,{signal});
    if(!Array.isArray(rows))throw fail('리포트 자료를 읽지 못했습니다.',503);
    out.push(...rows);if(out.length>cap)throw fail('자료가 많아 한 번에 처리할 수 없습니다. 잠시 후 다시 시도해주세요.',422);
    if(rows.length<limit)return out;
  }
  throw fail('리포트 조회 범위를 초과했습니다.',422);
}
export async function loadDonationReport(workspaceId,query={}, {sbImpl=sb}={}){
  if(!UUID.test(workspaceId||''))throw fail('Workspace not resolved',403);
  if(query.from!==undefined||query.to!==undefined){reportDate(query.from);reportDate(query.to);if(query.from>query.to)throw fail('시작일이 종료일보다 늦습니다.')}
  if(query.mode!==undefined&&!['bounds','report'].includes(query.mode))throw fail('잘못된 리포트 요청입니다.');
  const signal=AbortSignal.timeout(22000),params={workspace_id:'eq.'+workspaceId},options={sbImpl,signal};
  const [collector,wallpaper]=await Promise.all([
    allRows('bangsel_collector_staging','broadcast_start_local','source_scope.asc,source_uid.asc',{...params,broadcast_start_local:'not.is.null'},options),
    allRows('byeollog_wallpaper_sessions','started_at','started_at.asc,id.asc',params,options)
  ]);
  const starts=reportStarts(collector,wallpaper),bounds={first:starts.length?dayOf(starts[0]):null,last:starts.length?dayOf(starts.at(-1)):null,startCount:starts.length};
  if(query.mode==='bounds'||!starts.length)return {bounds,report:null};
  const from=query.from??bounds.first,to=query.to??bounds.last;
  if(from<bounds.first||to>bounds.last)throw fail('기록된 방송일 범위 안에서 선택해주세요.');
  const end=dayOf(Date.parse(to+'T00:00:00+09:00')+DAY),after=dayOf(Date.parse(to+'T00:00:00+09:00')+2*DAY);
  const filter=`(and(donated_date.gte.${from},donated_date.lte.${end}),and(donated_date.is.null,donated_at.gte.${from}T00:00:00+09:00,donated_at.lt.${after}T00:00:00+09:00))`;
  const rows=await allRows('bangsel_donations','source_event_key,donation_type,donated_date,donated_time,donated_at,balloons,raw_type:raw_payload->>type,raw_subtype:raw_payload->>subtype','source_event_key.asc',{...params,or:filter},options);
  return {bounds,report:buildDonationReport(starts,rows,{from,to})};
}
