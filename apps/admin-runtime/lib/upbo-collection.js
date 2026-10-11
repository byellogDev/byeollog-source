import {fetchAutomaticRouletteRules} from './weflab-collection-config.js';
const overlayPattern=/^https:\/\/weflab\.com\/page\/[A-Za-z0-9]+$/;
export function normalizeCollectionSettings(body){
  if(typeof body?.enabled!=='boolean'||typeof body.url!=='string')throw Error('수집 상태와 후원알림 오버레이 주소를 확인해주세요.');
  const url=body.url.trim();
  if(url.length>256||(url&&!overlayPattern.test(url)))throw Error('현재 연결을 지원하지 않는 주소입니다. 방송에 사용하는 후원알림 오버레이 주소인지 확인해주세요.');
  if(body.enabled&&!url)throw Error('후원알림 오버레이 주소를 먼저 입력해주세요.');
  return {enabled:body.enabled,url};
}
export function normalizeEventName(body){
  const amount=Number(body?.amount),amountMax=Number(body?.amountMax??amount),name=String(body?.name??'').trim().normalize('NFC');
  if(!Number.isSafeInteger(amount)||amount<1||!Number.isSafeInteger(amountMax)||amountMax<amount||amountMax>1e9)throw Error('별풍선 범위를 확인해주세요.');
  if(!name||name.length>120||/[\u0000-\u001f\u007f]/.test(name))throw Error('이벤트명은 1~120자로 입력해주세요.');
  return {amount,amountMax,name};
}
export async function upboCollectionRequest({sb,workspaceId,userId,method,body={},query={},fetchRules=fetchAutomaticRouletteRules}){
  let request;
  if(method==='GET')request={action:'get'};
  else if(method==='POST'){
    try{
      request=query.kind==='name'?{action:'name_save',...normalizeEventName(body)}:{action:'settings_save',...normalizeCollectionSettings(body)};
    }catch(error){return {status:400,body:{message:error.message}}}
  }else if(method==='DELETE'&&query.kind==='name'){
    if(!Number.isSafeInteger(body.amount)||body.amount<1||body.amount>1e9)return {status:400,body:{message:'삭제할 별풍선 범위를 확인해주세요.'}};
    request={action:'name_delete',amount:body.amount};
  }else return {status:405,body:{message:'Method not allowed'}};
  if(request.action==='settings_save'&&request.enabled){
    const rows=await sb('byeollog_workspaces',`?id=eq.${encodeURIComponent(workspaceId)}&select=soop_id&limit=1`);
    try{request.rules=await fetchRules(request.url,rows?.[0]?.soop_id)}
    catch{return {status:400,body:{message:'오버레이 설정을 확인하지 못했습니다. 연결된 숲 계정과 룰렛 설정을 확인해주세요. 지원하지 않는 조건이 있으면 연결할 수 없습니다. 수집 상태는 변경하지 않았습니다.'}}}
  }
  const result=await sb('rpc/byeollog_upbo_collection_settings_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:userId,p_request:request}});
  return {status:200,body:{ok:true,...result}};
}
export function upboCollectionError(error){
  if(error?.code==='42501')return {status:403,body:{message:'업보 수집 설정을 변경할 권한이 없습니다.'}};
  if(error?.code==='23P01')return {status:409,body:{message:'다른 이벤트명과 별풍선 범위가 겹칩니다.'}};
  if(error?.code==='22023')return {status:400,body:{message:'오버레이 주소와 입력 내용을 확인해주세요.'}};
  return {status:502,body:{message:'업보 수집 설정을 저장하거나 읽지 못했습니다. 입력 내용은 유지됩니다.'}};
}
