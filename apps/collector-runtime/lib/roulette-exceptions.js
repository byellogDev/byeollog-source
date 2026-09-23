const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q=encodeURIComponent;
function field(value,max){
  if(typeof value!=='string'||/[\u0000-\u001f\u007f]/u.test(value))throw Error('입력 내용을 확인해주세요.');
  const text=value.normalize('NFC').trim();
  if(!text||Array.from(text).length>max)throw Error('입력 길이를 확인해주세요.');
  return text;
}
export function normalizeExceptionDecision(body){
  if(!body||Array.isArray(body)||typeof body!=='object'||!uuid.test(body.id||''))throw Error('결과를 다시 선택해주세요.');
  if(['excluded','undo'].includes(body.action))return {id:body.id,decision:{action:body.action}};
  if(body.action!=='registered')throw Error('처리 방식을 선택해주세요.');
  if(!Number.isSafeInteger(body.quantity)||body.quantity<1||body.quantity>1000)throw Error('수량은 1~1,000 사이의 정수로 입력해주세요.');
  const decision={action:'registered',soopId:field(body.soopId,180),event:field(body.event,120),type:field(body.type,120),quantity:body.quantity};
  if(body.createFan===true){
    if(!/^[a-z0-9_.-]{2,80}$/.test(decision.soopId))throw Error('SOOP 아이디를 확인해주세요.');
    decision.createFan=true;decision.fanName=field(body.fanName,120);
  }
  return {id:body.id,decision};
}

// The caller supplies a freshly revalidated session. Client workspace/user
// fields are never forwarded. No writes are performed by the GET routes.
export async function rouletteExceptionsRequest({sb,workspaceId,userId,method,query={},body}){
  if(method==='POST'){
    if(body?.action==='bulk-excluded'){
      if(!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>50||new Set(body.ids).size!==body.ids.length||body.ids.some(id=>typeof id!=='string'||!uuid.test(id)))return {status:400,body:{message:'서로 다른 결과를 1~50건 선택해주세요.'}};
      const results=[];
      for(const id of body.ids){try{const data=await sb('rpc/resolve_soop_roulette_exception_v2','',{method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:userId,p_result_id:id,p_decision:{action:'excluded'}}});results.push({id,ok:true,...data})}catch(error){results.push({id,ok:false,message:exceptionError(error).body.message})}}
      return {status:200,body:{ok:true,results}};
    }
    let normalized;
    try{normalized=normalizeExceptionDecision(body)}catch(error){return {status:400,body:{message:error.message}}}
    const data=await sb('rpc/resolve_soop_roulette_exception_v2','',{method:'POST',body:{
      p_workspace_id:workspaceId,p_authorized_user_id:userId,p_result_id:normalized.id,p_decision:normalized.decision
    }});
    return {status:200,body:{ok:true,...data}};
  }
  if(method!=='GET')return {status:405,body:{message:'Method not allowed'}};
  if(query.historyId!==undefined){
    if(!uuid.test(query.historyId||''))return {status:400,body:{message:'결과를 다시 선택해주세요.'}};
    const items=await sb('byeollog_roulette_exception_reviews',`?workspace_id=eq.${q(workspaceId)}&result_id=eq.${q(query.historyId)}&select=action,previous_status,created_at&order=created_at.desc&limit=50`);
    return {status:200,body:{ok:true,items:Array.isArray(items)?items:[]}};
  }
  if(query.fans!==undefined){
    const term=String(query.fans).trim();
    if(!term||term.length>80||!/^[\p{L}\p{N} ._-]+$/u.test(term))return {status:400,body:{message:'후원자의 닉네임이나 SOOP 아이디를 입력해주세요. 특수문자는 빼고 검색해주세요.'}};
    const pattern=q(JSON.stringify('*'+term+'*'));
    const fans=await sb('bangsel_fans',`?workspace_id=eq.${q(workspaceId)}&select=soop_id,alias,current_nickname&or=(soop_id.ilike.${pattern},alias.ilike.${pattern},current_nickname.ilike.${pattern})&order=soop_id.asc&limit=20`);
    return {status:200,body:{ok:true,fans:Array.isArray(fans)?fans:[]}};
  }
  const filter=query.filter??'pending';
  if(!['pending','processed','all'].includes(filter))return {status:400,body:{message:'목록 구분을 확인해주세요.'}};
  let cursor='';
  if(query.before){
    try{
      const parsed=JSON.parse(query.before);
      if(!uuid.test(parsed.id)||typeof parsed.at!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(parsed.at)||!Number.isFinite(Date.parse(parsed.at)))throw Error();
      cursor=`&or=(occurred_at.lt.${q(parsed.at)},and(occurred_at.eq.${q(parsed.at)},id.lt.${parsed.id}))`;
    }catch{return {status:400,body:{message:'목록을 새로고침해주세요.'}}}
  }
  const status=filter==='all'?'':filter==='pending'?'&review_status=eq.pending':'&review_status=neq.pending';
  let criteria='';
  for(const key of ['from','until'])if(query[key]){
    const value=String(query[key]);if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)return {status:400,body:{message:'발생 날짜를 확인해주세요.'}};
    const at=new Date(Date.parse(value+'T00:00:00+09:00')+(key==='until'?86400000:0)).toISOString();criteria+=`&occurred_at=${key==='from'?'gte':'lt'}.${q(at)}`;
  }
  if(query.from&&query.until&&query.from>query.until)return {status:400,body:{message:'조회 시작일과 종료일을 확인해주세요.'}};
  if(query.reason){if(!['fifo_head_stale','fifo_head_roulette_mismatch','unmatched'].includes(query.reason))return {status:400,body:{message:'사유를 확인해주세요.'}};criteria+=query.reason==='unmatched'?'&match_state=eq.unmatched':`&match_method=eq.${query.reason}`}
  if(query.search){const term=String(query.search).trim();if(term.length>100||/[\u0000-\u001f\u007f]/.test(term))return {status:400,body:{message:'검색어를 확인해주세요.'}};criteria+='&result_text=ilike.'+q(JSON.stringify('*'+term.replace(/[*%_]/g,'\\$&')+'*'))}
  const rows=await sb('byeollog_soop_core_roulette_results',`?workspace_id=eq.${q(workspaceId)}&match_state=neq.matched&select=id,result_text,raw_message,occurred_at,created_at,roulette_name,donor_name_hint,match_state,match_method,review_status,reviewed_at,review_details&order=occurred_at.desc,id.desc&limit=51${status}${cursor}${criteria}`);
  const items=(Array.isArray(rows)?rows:[]).slice(0,50),last=items.at(-1);
  return {status:200,body:{ok:true,items,nextCursor:rows?.length>50?JSON.stringify({id:last.id,at:last.occurred_at}):null}};
}

export function exceptionError(error){
  if(error?.code==='PT409')return {status:409,body:{message:'이미 처리되었거나 업보가 변경·완료되어 되돌릴 수 없습니다. 새로고침 후 현재 상태를 확인해주세요.'}};
  if(error?.code==='PT404')return {status:404,body:{message:'결과 또는 후원자를 찾지 못했습니다. 목록을 다시 확인해주세요.'}};
  if(['42501','28000'].includes(error?.code))return {status:403,body:{message:'처리 권한을 확인해주세요.'}};
  if(error?.code==='22023')return {status:400,body:{message:'업보 등록 내용을 확인해주세요.'}};
  return {status:502,body:{message:'처리를 확인하지 못했습니다. 목록을 새로고침한 뒤 다시 시도해주세요.'}};
}
