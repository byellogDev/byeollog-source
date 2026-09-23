import crypto from 'node:crypto';
import {sb} from './supabase-rest.js';
import {createSessionToken,setSessionCookie,revalidateMembership} from './auth.js';
import {isRateLimited,clientIp} from './rate-limit.js';
import {isJsonRequest,isTrustedMutationOrigin} from './request-origin.js';

const TABLE='byeollog_agent_dashboard_handoffs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=code=>crypto.createHash('sha256').update(code).digest('hex');

// Separate from retired collector-device handoffs: account authentication is
// sufficient, but a server-verified workspace membership is always required.
export async function handleAgentDashboardHandoff(req,res,{authorize,sbImpl=sb,rateLimit=isRateLimited,revalidate=revalidateMembership,now=()=>Date.now()}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  let body=req.body||{};
  if(typeof body==='string'){try{body=JSON.parse(body)}catch{return res.status(400).json({message:'잘못된 요청입니다.'})}}
  const exchange=req.query?.operation==='agent-dashboard-login';
  const lane=exchange?'consume':'issue';
  try{
    if(await rateLimit(`agent-dashboard:${lane}:ip:${clientIp(req)}`,{limit:30,windowMs:5*60*1000})){
      return res.status(429).json({message:'요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',code:'rate_limited'});
    }
    if(!exchange){
      const token=String(req.headers?.authorization||'').match(/^Bearer\s+([^\s]+)$/i)?.[1];
      const workspaceId=String(body.workspaceId||'').trim().toLowerCase();
      if(!token)return res.status(401).json({message:'별록 계정 연결이 필요합니다.',code:'agent_session_expired'});
      if(!UUID.test(workspaceId))return res.status(400).json({message:'워크스페이스가 올바르지 않습니다.'});
      const auth=await authorize(token,workspaceId);
      if(auth.status!==200)return res.status(auth.status).json({message:'별록 계정 연결 또는 워크스페이스 권한을 확인해주세요.',code:auth.code});
      if(await rateLimit(`agent-dashboard:issue:user:${auth.user.id}`,{limit:30,windowMs:5*60*1000})){
        return res.status(429).json({message:'요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',code:'rate_limited'});
      }
      const instant=now(),code=crypto.randomBytes(32).toString('base64url');
      const expires=new Date(instant+45000).toISOString();
      // Indexed cleanup runs only on a user click; no new polling or worker.
      await sbImpl(TABLE,`?expires_at=lt.${encodeURIComponent(new Date(instant).toISOString())}`,{method:'DELETE',prefer:'return=minimal'});
      await sbImpl(TABLE,'',{method:'POST',prefer:'return=minimal',body:{
        code_hash:hash(code),user_id:auth.user.id,workspace_id:workspaceId,
        session_epoch:auth.membership.web_session_epoch||0,expires_at:expires
      }});
      return res.status(200).json({ok:true,workspaceId,dashboard_url:`/login#agent_handoff=${code}`,expires_at:expires});
    }
    const code=String(body.code||'');
    if(!/^[A-Za-z0-9_-]{43}$/.test(code))return res.status(400).json({message:'로그인 링크가 올바르지 않습니다.'});
    // DELETE RETURNING is the atomic single-use claim, including the expiry
    // predicate: concurrent requests cannot both obtain the same credential.
    const rows=await sbImpl(TABLE,`?code_hash=eq.${hash(code)}&expires_at=gt.${encodeURIComponent(new Date(now()).toISOString())}`,{method:'DELETE',prefer:'return=representation'});
    const row=Array.isArray(rows)&&rows.length===1?rows[0]:null;
    if(!row)return res.status(401).json({message:'대시보드 로그인 링크가 만료되었거나 이미 사용되었습니다.',code:'handoff_expired'});
    const session=await revalidate({mode:'beta',user_id:row.user_id,workspace_id:row.workspace_id,session_epoch:row.session_epoch});
    if(!session)return res.status(403).json({message:'계정 권한이 변경되었습니다. 프로그램에서 다시 연결해주세요.',code:'agent_workspace_forbidden'});
    setSessionCookie(res,createSessionToken(session));
    return res.status(200).json({ok:true});
  }catch(error){
    console.error('[agent-dashboard] failed',{lane,type:error?.name||'Error',status:error?.status||null});
    return res.status(503).json({message:'대시보드 연결을 완료하지 못했습니다. 잠시 후 다시 눌러주세요.',code:'agent_dashboard_unavailable'});
  }
}
