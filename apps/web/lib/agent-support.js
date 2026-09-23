import {sb} from './supabase-rest.js';
import {isJsonRequest,isTrustedMutationOrigin} from './request-origin.js';
import {isRateLimited,clientIp} from './rate-limit.js';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const freeBetaSupportEnabled=(env=process.env)=>String(env.BYEOLLOG_FREE_BETA_SUPPORT_ENABLED??'true').toLowerCase()==='true';
export async function handleAgentSupport(req,res,{authorize,sbImpl=sb,rateLimit=isRateLimited,env=process.env}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'요청 형식을 확인해주세요.'});
  if(!freeBetaSupportEnabled(env))return res.status(410).json({message:'무료 베타 긴급 호출이 종료되었습니다.',code:'beta_support_closed'});
  let body=req.body;
  try{if(typeof body==='string')body=JSON.parse(body)}catch{return res.status(400).json({message:'요청을 다시 작성해주세요.'})}
  const token=String(req.headers?.authorization||'').match(/^Bearer\s+(\S+)$/i)?.[1];
  if(!token)return res.status(401).json({message:'별록에 로그인한 뒤 다시 시도해주세요.',code:'agent_session_expired'});
  if(!body||!uuid.test(body.workspaceId)||!uuid.test(body.requestId)||typeof body.message!=='string'||body.message.trim().length<5||body.message.length>1000||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.message))return res.status(400).json({message:'장애 내용을 5~1,000자로 입력해주세요.'});
  try{
    if(await rateLimit('agent-support:ip:'+clientIp(req),{limit:30,windowMs:5*60000}))return res.status(429).json({message:'잠시 후 다시 시도해주세요.'});
    const auth=await authorize(token,body.workspaceId);
    if(auth.status!==200)return res.status(auth.status).json({message:'연결된 별록 계정을 확인해주세요.',code:auth.code});
    // Workspace name and author identity are obtained by the DB from verified membership.
    const result=await sbImpl('rpc/byeollog_submit_support_request_v1','',{method:'POST',body:{p_workspace_id:body.workspaceId,p_user_id:auth.user.id,p_request_id:body.requestId,p_message:body.message.trim()},signal:AbortSignal.timeout(8000)});
    return res.status(200).json({ok:result?.ok===true,message:'장애 내용을 접수했습니다. 운영자가 확인하겠습니다.'});
  }catch(error){
    if(error?.code==='PT429')return res.status(429).json({message:'이미 접수한 내용을 확인 중입니다. 추가 내용은 잠시 후 보내주세요.'});
    if(error?.code==='42501')return res.status(403).json({message:'이 계정에서는 긴급 호출을 보낼 수 없습니다.'});
    return res.status(503).json({message:'접수하지 못했습니다. 내용을 유지한 채 잠시 후 다시 보내주세요.'});
  }
}
