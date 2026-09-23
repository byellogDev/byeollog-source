const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q=value=>encodeURIComponent(JSON.stringify(String(value)));
const list=value=>Array.isArray(value)?value:[];
import {broadcastReadiness} from './broadcast-readiness.js';
export function historyRange(query,now=new Date()){
  const today=new Date(now.getTime()+9*3600000).toISOString().slice(0,10);
  const from=query.from||new Date(Date.parse(today)-6*86400000).toISOString().slice(0,10),until=query.until||today;
  const date=value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)throw Error('조회 날짜를 확인해주세요.');return Date.parse(value+'T00:00:00+09:00')};
  const start=date(from),end=date(until)+86400000;
  if(end<=start||end-start>366*86400000)throw Error('조회 기간은 최대 366일입니다.');
  let cursor=null;
  if(query.cursor){cursor=JSON.parse(query.cursor);if(!cursor||typeof cursor.at!=='string'||!Number.isFinite(Date.parse(cursor.at))||typeof cursor.key!=='string'||cursor.key.length>400)throw Error('다시 조회해주세요.')}
  const search=String(query.search||'').trim();if(search.length>100||/[\u0000-\u001f]/.test(search))throw Error('검색어를 확인해주세요.');
  return {p_from:new Date(start).toISOString(),p_until:new Date(end).toISOString(),p_before_at:cursor?.at||null,p_before_key:cursor?.key||null,p_search:search};
}
export async function uxControlsRequest({sb,workspaceId,userId,method,query={},body={}}){
  const kind=query.kind||'status';
  if(kind==='close-pending'&&method==='POST'){
    if(!uuid.test(body.id||'')||typeof body.updatedAt!=='string'||!Number.isFinite(Date.parse(body.updatedAt)))return {status:400,body:{message:'대기 목록을 새로고침해주세요.'}};
    const data=await sb('rpc/byeollog_close_stale_donation_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:userId,p_id:body.id,p_expected_updated_at:body.updatedAt}});
    return {status:200,body:data};
  }
  if(method!=='GET')return {status:405,body:{message:'Method not allowed'}};
  if(kind==='readiness')return {status:200,body:await broadcastReadiness({sb,workspaceId,userId})};
  if(kind==='notifications'){
    const data=await sb('rpc/byeollog_dashboard_counts_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:userId},signal:AbortSignal.timeout(8000)});
    return {status:200,body:{ok:true,...data}};
  }
  if(kind==='credits'){
    const credits=await sb('byeollog_credit_ledger',`?workspace_id=eq.${workspaceId}&select=credit_delta,entry_type,created_at&order=created_at.desc&limit=50`);
    return {status:200,body:{ok:true,creditEntries:list(credits)}};
  }
  if(kind==='history'){
    let range;try{range=historyRange(query)}catch(error){return {status:400,body:{message:error.message}}}
    const data=await sb('rpc/byeollog_ux_history_v1','',{method:'POST',body:{p_workspace_id:workspaceId,...range}});
    return {status:200,body:{ok:true,...data,checkedAt:new Date().toISOString()}};
  }
  if(kind==='diagnostic'){
    const key=String(query.key||'');if(!key||key.length>220||/[\u0000-\u001f]/.test(key))return {status:400,body:{message:'후원을 다시 선택해주세요.'}};
    const isSoop=key.startsWith('soop_sdk:'),providerKey=key.replace(/^(soop_sdk:|weflab:)/,'');
    const [original,staging,core]=await Promise.all([
      sb('bangsel_donations',`?workspace_id=eq.${workspaceId}&source_event_key=eq.${q(key)}&select=donated_at,imported_at,balloons,nickname&limit=1`),
      sb('bangsel_collector_staging',`?workspace_id=eq.${workspaceId}&source_uid=in.(${q(key)},${q(providerKey)})&select=source_uid,source_scope,process_status,uploaded_at,processed_at,validation&order=uploaded_at.desc&limit=4`),
      isSoop?sb('byeollog_soop_core_donations',`?workspace_id=eq.${workspaceId}&provider_event_id=eq.${q(providerKey)}&select=id,occurred_at,created_at,status,result_count,expected_spins,roulette_name,user_closed_at&limit=1`):[]
    ]);
    const donation=list(core)[0],stages=list(staging).filter(s=>isSoop?s.source_scope==='soop'||s.source_uid.startsWith('soop_sdk:'):s.source_scope!=='soop');
    if(!donation&&!list(original).length&&!stages.length)return {status:404,body:{message:'조회할 수 있는 후원 기록이 없습니다.'}};
    const [results,tiles]=donation?await Promise.all([
      sb('byeollog_soop_core_roulette_results',`?workspace_id=eq.${workspaceId}&donation_id=eq.${donation.id}&select=result_text,occurred_at,special_roulette,match_method&order=occurred_at.asc&limit=100`),
      sb('byeollog_wallpaper_tiles',`?workspace_id=eq.${workspaceId}&donation_event_id=eq.${donation.id}&select=id&limit=1`)
    ]):[[],[]];
    return {status:200,body:{ok:true,original:list(original)[0]||null,stage:stages[0]||null,donation:donation||null,results:list(results),wallpaperPrepared:list(tiles).length>0,displayConfirmed:false}};
  }
  if(kind!=='status')return {status:400,body:{message:'요청 종류를 확인해주세요.'}};
  const status=await sb('rpc/byeollog_ux_roulette_status_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:userId}});
  return {status:200,body:{ok:true,...status}};
}
export function uxError(error){
  if(error?.code==='PT409')return {status:409,body:{message:'처리 상태가 바뀌었거나 이미 진행된 업보입니다. 새로고침 후 확인해주세요.'}};
  if(error?.code==='PT404')return {status:404,body:{message:'해당 기록을 찾지 못했습니다.'}};
  if(error?.code==='42501')return {status:403,body:{message:'처리 권한이 없습니다.'}};
  return {status:502,body:{message:'처리 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'}};
}
