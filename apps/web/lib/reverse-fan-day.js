const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function normalizeReverseFanDay(input){
 if(!input||typeof input!=='object'||Array.isArray(input))throw Error('설정 내용을 확인해주세요.');
 const name=typeof input.name==='string'?input.name.normalize('NFC').trim():'';
 if(!name||[...name].length>80||/[\u0000-\u001f\u007f]/.test(name))throw Error('회차 이름은 1~80자로 입력해주세요.');
 const date=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|\+09:00)$/.test(value)||!Number.isFinite(Date.parse(value)))throw Error('기간을 확인해주세요.');const offset=value.endsWith('+09:00')?9*3600000:0;if(new Date(Date.parse(value)+offset).toISOString().slice(0,19)!==value.slice(0,19))throw Error('존재하는 날짜를 입력해주세요.');return new Date(value).toISOString()};
 const startsAt=date(input.startsAt),endsAt=date(input.endsAt),duration=Date.parse(endsAt)-Date.parse(startsAt);
 if(duration<=0||duration>366*86400000)throw Error('종료 시각은 시작 이후여야 하며, 한 회차는 최대 366일입니다.');
 if(!Array.isArray(input.rules)||!input.rules.length||input.rules.length>30)throw Error('환급 범위는 1~30개 등록해주세요.');
 const rules=input.rules.map(r=>{if(!r||![r.min,r.max,r.rateBp].every(Number.isSafeInteger)||r.min<1||r.max<r.min||r.max>1000000000||r.rateBp<1||r.rateBp>10000)throw Error('범위는 1~10억 개, 환급률은 0.01~100%로 입력해주세요.');return {min:r.min,max:r.max,rateBp:r.rateBp}}).sort((a,b)=>a.min-b.min);
 if(rules.some((r,i)=>i>0&&r.min<=rules[i-1].max))throw Error('별풍선 범위가 겹칩니다. 겹치지 않게 입력해주세요.');
 return {name,startsAt,endsAt,rules};
}
export async function reverseFanDayRequest({sb,workspaceId,userId,method,query={},body={}}){
 if(!['GET','POST'].includes(method))return {status:405,body:{message:'Method not allowed'}};
 let action,payload;
 try{
  if(method==='GET'){
   action=query.id?'get':'list';payload={page:Number(query.page??0)};
   if(!Number.isSafeInteger(payload.page)||payload.page<0||payload.page>10000)throw Error('페이지를 확인해주세요.');
   if(action==='get'){
    if(typeof query.id!=='string'||!uuid.test(query.id))throw Error('회차를 다시 선택해주세요.');
    payload={...payload,id:query.id,filter:query.filter??'all',search:String(query.search??'').trim()};
    if(!['all','pending','paid','review'].includes(payload.filter)||payload.search.length>80)throw Error('검색 조건을 확인해주세요.');
   }
  }else{
   if(!body||Array.isArray(body)||typeof body!=='object')throw Error('입력 내용을 확인해주세요.');
   action=body.action;
   if(!['create','save','delete','pay','undo'].includes(action)||!uuid.test(body.id??''))throw Error('요청을 다시 확인해주세요.');
   payload={id:body.id};
   if(action!=='create'){
    if(!Number.isSafeInteger(body.revision)||body.revision<1)throw Error('목록을 새로고침해주세요.');
    payload.revision=body.revision;
   }
   if(['create','save'].includes(action))Object.assign(payload,normalizeReverseFanDay(body));
   if(['pay','undo'].includes(action)){
    if(typeof body.fanId!=='string'||!body.fanId.trim()||body.fanId.length>250||!Number.isSafeInteger(body.expectedRefund)||body.expectedRefund<0||!Number.isSafeInteger(body.expectedPaid)||body.expectedPaid<0)throw Error('지급할 시청자와 수량을 확인해주세요.');
    Object.assign(payload,{fanId:body.fanId,expectedRefund:body.expectedRefund,expectedPaid:body.expectedPaid});
   }
  }
 }catch(error){return {status:400,body:{message:error.message}}}
 const data=await sb('rpc/byeollog_reverse_fan_day_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:userId,p_action:action,p_payload:payload}});
 return {status:200,body:data};
}
export function reverseFanDayError(error){
 if(error?.code==='PT409')return {status:409,body:{message:'후원 수량이나 지급 상태가 변경됐습니다. 새로고침 후 다시 확인해주세요.'}};
 if(error?.code==='PT422')return {status:409,body:{message:'지급 기록이 있는 회차의 조건은 수정하거나 삭제할 수 없습니다. 잘못 표시했다면 지급완료를 취소한 뒤 변경해주세요.'}};
 if(error?.code==='PT404')return {status:404,body:{message:'회차 또는 시청자를 찾지 못했습니다. 목록을 새로고침해주세요.'}};
 if(['42501','28000'].includes(error?.code))return {status:403,body:{message:'역팬데이 관리 권한을 확인해주세요.'}};
 if(['22023','22P02','23514','22007','22008','22003'].includes(error?.code))return {status:400,body:{message:'기간·별풍선 범위·환급률을 다시 확인해주세요.'}};
 return {status:502,body:{message:'결과를 확인하지 못했습니다. 새로고침해 현재 지급 상태를 확인한 뒤 다시 시도해주세요.'}};
}
