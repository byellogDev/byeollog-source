import {handleAgentSupport,freeBetaSupportEnabled} from '../lib/agent-support.js';
import crypto from 'node:crypto';
import {createSessionToken,setSessionCookie} from '../lib/auth.js';
import {sb} from '../lib/supabase-rest.js';
import {handleReferrerSearch,handleSignup,handleSignupStatus} from '../lib/signup.js';
import handlePassword from '../lib/password.js';
import {isRateLimited, clientIp} from '../lib/rate-limit.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {retiredRuntimeOperation} from '../lib/core-product-scope.js';
import {isJsonRequest,isTrustedMutationOrigin} from '../lib/request-origin.js';
import {handleSoopOAuthCallback,handleSoopOAuthDiagnose,handleSoopOAuthDisconnect,handleSoopOAuthStart,handleSoopOAuthStatus,handleSoopSignupOAuthStart,handleSoopSignupOAuthStatus} from '../lib/soop-oauth.js';
import {handleSoopGatewayIngress} from '../lib/soop-gateway-api.js';
import {runAgentWallpaperControl} from '../lib/agent-wallpaper-control.js';
import {handleAgentDashboardHandoff} from '../lib/agent-dashboard-handoff.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}

async function betaLogin(id,password,requestedWorkspace){
  const url=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const anon=process.env.SUPABASE_ANON_KEY||process.env.SUPABASE_SECRET_KEY||'';
  if(!url||!anon)throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY is not configured');
  const auth=await fetch(`${url}/auth/v1/token?grant_type=password`,{
    method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},
    body:JSON.stringify({email:id,password}),cache:'no-store'
  });
  const data=await auth.json().catch(()=>({}));
  if(!auth.ok||!data?.user?.id)return null;
  const userId=data.user.id;
  const memberships=await sb('byeollog_workspace_members',`?select=workspace_id,role,web_session_epoch,byeollog_workspaces(id,slug,display_name,status)&user_id=eq.${encodeURIComponent(userId)}`);
  let rows=Array.isArray(memberships)?memberships.filter(x=>x?.byeollog_workspaces?.status==='active'):[];
  if(requestedWorkspace)rows=rows.filter(x=>x.workspace_id===requestedWorkspace||x.byeollog_workspaces?.slug===requestedWorkspace);
  if(!rows.length){
    const applications=await sb('byeollog_signup_applications',`?select=status,rejection_reason&auth_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`).catch(()=>[]);
    const application=Array.isArray(applications)?applications[0]:null;
    if(application?.status==='pending')return {error:'이전 가입 신청은 자동 처리되지 않습니다. 가입 화면에서 SOOP 계정을 연결해 가입을 완료해주세요.'};
    if(application?.status==='rejected')return {error:'이전 가입 기록으로는 로그인할 수 없습니다. 가입 화면에서 SOOP 계정을 연결해 다시 가입해주세요.'};
    return {error:'이 계정에 연결된 별록 워크스페이스가 없습니다.'};
  }
  const m=rows[0],w=m.byeollog_workspaces;
  return {token:createSessionToken({mode:'beta',user_id:userId,email:data.user.email,workspace_id:m.workspace_id,workspace_slug:w?.slug,role:m.role,session_epoch:m.web_session_epoch}),workspace:w,role:m.role};
}


async function handleInquirySubmit(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  if(await isRateLimited('inquiry:ip:'+clientIp(req),{limit:8,windowMs:15*60*1000}))return res.status(429).json({message:'문의 전송 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  const b=bodyOf(req);
  const contact=String(b.contact||'').trim();
  const message=String(b.message||'').trim();
  if(contact.length<2||contact.length>120)return res.status(400).json({message:'디스코드 ID를 입력해주세요.'});
  if(message.length<5||message.length>2000)return res.status(400).json({message:'문의 내용을 5자 이상 입력해주세요.'});
  const ip=clientIp(req);
  const ipHash=ip?crypto.createHash('sha256').update(ip).digest('hex').slice(0,32):null;
  const ua=String(req.headers['user-agent']||'').slice(0,240)||null;
  try{
    await sb('byeollog_inquiries','',{
      method:'POST',
      body:{contact,message,status:'archived',ip_hash:ipHash,user_agent:ua}
    });
    return res.status(200).json({ok:true,message:'문의가 접수되었습니다. 확인 후 연락드리겠습니다.'});
  }catch(e){
    return res.status(500).json({
      message:'문의 접수에 실패했습니다. 잠시 후 다시 시도해주세요.'
    });
  }
}

function bearer(req){
  const match=String(req.headers?.authorization||'').match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1]||'';
}

async function authenticatedBearerUser(accessToken,{signal}={}){
  const url=String(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const anon=String(process.env.SUPABASE_ANON_KEY||'');
  if(!url||!anon)throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY is not configured');
  const response=await fetch(`${url}/auth/v1/user`,{
    headers:{apikey:anon,Authorization:`Bearer ${accessToken}`},
    cache:'no-store',signal
  });
  const data=await response.json().catch(()=>({}));
  return response.ok&&data?.id?data:null;
}

async function authorizedAgentWorkspace(accessToken,workspaceId,{signal}={}){
  const user=await authenticatedBearerUser(accessToken,{signal});
  if(!user)return {status:401,code:'agent_session_expired'};
  const memberships=await sb(
    'byeollog_workspace_members',
    `?select=workspace_id,role,web_session_epoch,byeollog_workspaces(id,slug,display_name,status)`+
    `&user_id=eq.${encodeURIComponent(user.id)}&workspace_id=eq.${encodeURIComponent(workspaceId)}&limit=1`,
    {signal}
  );
  const membership=Array.isArray(memberships)?memberships[0]:null;
  const workspace=membership?.byeollog_workspaces;
  if(!membership||membership.workspace_id!==workspaceId||workspace?.id!==workspaceId||workspace?.status!=='active'){
    return {status:403,code:'agent_workspace_forbidden'};
  }
  return {status:200,user,membership,workspace};
}

async function handleAgentSessionValidate(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.',code:'invalid_content_type'});
  const accessToken=bearer(req);
  const workspaceId=String(bodyOf(req).workspaceId||'').trim().toLowerCase();
  if(!accessToken||!UUID.test(workspaceId)){
    return res.status(400).json({message:'Agent 세션 확인 요청이 올바르지 않습니다.',code:'invalid_agent_session_request'});
  }
  if(await isRateLimited(`agent-session-validate:ip:${clientIp(req)}`,{limit:30,windowMs:5*60*1000})){
    return res.status(429).json({message:'Agent 세션 확인 요청이 너무 많습니다.',code:'rate_limited'});
  }
  const authorization=await authorizedAgentWorkspace(accessToken,workspaceId);
  if(authorization.status===401){
    return res.status(401).json({message:'별록 계정 연결이 만료되었습니다.',code:authorization.code});
  }
  if(authorization.status===403){
    return res.status(403).json({message:'연결 가능한 워크스페이스를 찾지 못했습니다.',code:authorization.code});
  }
  return res.status(200).json({
    ok:true,
    userId:authorization.user.id,
    email:authorization.user.email||'',
    betaSupportEnabled:freeBetaSupportEnabled(),
    workspaceId
  });
}

async function handleAgentWebSession(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const accessToken=bearer(req);
  const workspaceId=String(bodyOf(req).workspaceId||'').trim().toLowerCase();
  if(!accessToken||!UUID.test(workspaceId))return res.status(400).json({message:'Agent 웹 편집기 요청이 올바르지 않습니다.'});
  if(await isRateLimited(`agent-web-session:ip:${clientIp(req)}`,{limit:30,windowMs:5*60*1000})){
    return res.status(429).json({message:'풍벽지 편집기 연결 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'});
  }

  const authorization=await authorizedAgentWorkspace(accessToken,workspaceId);
  if(authorization.status===401){
    return res.status(401).json({message:'별록 계정 연결이 만료되었습니다. 프로그램에서 다시 연결해주세요.'});
  }
  if(authorization.status===403){
    return res.status(403).json({message:'풍벽지 편집 권한이 있는 워크스페이스를 찾지 못했습니다.'});
  }
  const {user,membership,workspace}=authorization;

  const sessionCookie=createSessionToken({
    mode:'agent_webview',
    user_id:user.id,
    email:user.email||null,
    workspace_id:workspaceId,
    workspace_slug:workspace.slug||null,
    role:membership.role,
    session_epoch:membership.web_session_epoch,
  });
  return res.status(200).json({
    ok:true,
    cookieName:'bangsel_admin_session',
    cookieValue:sessionCookie,
    workspaceId,
    expiresAt:new Date(Date.now()+12*60*60*1000).toISOString()
  });
}

async function handleAgentWallpaperControl(req,res){
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.',code:'invalid_content_type'});
  const accessToken=bearer(req),requestBody=bodyOf(req);
  const workspaceId=String(requestBody.workspaceId||'').trim().toLowerCase();
  if(!accessToken||!UUID.test(workspaceId))return res.status(400).json({message:'Agent 풍벽지 요청이 올바르지 않습니다.',code:'invalid_agent_wallpaper_request'});
  const control=requestBody.control&&typeof requestBody.control==='object'&&!Array.isArray(requestBody.control)?requestBody.control:null;
  const rateLane=control?.action==='select-sessions'?'selection':control?'write':'read';
  // Finish before the Agent's 30 second HttpClient deadline. Every downstream
  // call receives the same signal, so a stalled write cannot retain this
  // serverless invocation or the per-instance workspace queue for 60 seconds.
  const deadline=AbortSignal.timeout(18_000);
  let stage='preauth-rate-limit';
  try{
    // Untrusted workspace IDs must not consume another customer's quota.
    // A separate short IP burst fence still protects the authentication service.
    if(await isRateLimited(`agent-wallpaper-preauth:${clientIp(req)}`,{limit:1000,windowMs:10*1000,signal:deadline}))return res.status(429).json({message:'풍벽지 요청이 잠시 많습니다.',code:'rate_limited'});
    stage='authorization';
    const authorization=await authorizedAgentWorkspace(accessToken,workspaceId,{signal:deadline});
    if(authorization.status!==200)return res.status(authorization.status).json({message:authorization.status===401?'별록 계정 연결이 만료되었습니다.':'풍벽지 편집 권한이 없습니다.',code:authorization.code});
    stage='workspace-rate-limit';
    if(await isRateLimited(`agent-wallpaper-control-v2:${rateLane}:${workspaceId}`,{limit:rateLane==='selection'?120:240,windowMs:5*60*1000,signal:deadline}))return res.status(429).json({message:'풍벽지 요청이 잠시 많습니다.',code:'rate_limited'});
    stage='wallpaper-control';
    const result=await runAgentWallpaperControl({workspaceId,userId:authorization.user.id,body:control,signal:deadline,onStage:value=>{stage=value}});
    return res.status(200).json(result);
  }catch(error){
    if(error?.name==='TimeoutError'||error?.name==='AbortError'||deadline.aborted){
      console.error('[agent-wallpaper-control] timed out',{stage});
      return res.status(504).json({message:'풍벽지 서버 응답이 지연되었습니다. 잠시 후 저장 상태를 다시 확인해주세요.',code:'wallpaper_upstream_timeout'});
    }
    if(error?.code==='40001'||error?.code==='PT409')return res.status(409).json({message:'다른 변경 사항이 먼저 저장되었습니다. 최신 상태를 확인한 뒤 다시 저장해주세요.',code:'wallpaper_revision_conflict'});
    if(error?.code==='P0002')return res.status(409).json({message:'풍벽지 회차 구성이 바뀌었습니다. 새로고침 후 다시 시도해주세요.',code:'wallpaper_session_changed'});
    const status=Number(error?.status)||502;
    console.error('[agent-wallpaper-control] failed',{code:error?.code||'agent_wallpaper_control_failed'});
    return res.status(status).json({message:error?.message||'풍벽지 상태를 처리하지 못했습니다.',code:error?.code||'agent_wallpaper_control_failed'});
  }
}

async function handleSoopWallpaperOverlayPage(req,res){
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const nonce=crypto.randomBytes(18).toString('base64url');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Security-Policy',`default-src 'none'; style-src 'nonce-${nonce}'; style-src-attr 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
  res.setHeader('X-Robots-Tag','noindex, noarchive');
  return res.status(410).send(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>별록 풍벽지 · 종료됨</title><style nonce="${nonce}">html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}</style></head><body aria-label="종료된 별록 웹 풍벽지 오버레이"></body></html>`);
}

async function handleSoopWallpaperState(req,res){
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  res.setHeader('Cache-Control','no-store, private');
  // 구형 웹 OBS 클라이언트는 clientVersion이 달라지면 페이지를 새로고침한다.
  // 새 페이지는 410 투명 문서이므로 이미 떠 있던 카드까지 즉시 제거되고 폴링도 종료된다.
  return res.status(200).json({ok:false,disabled:true,reason:'moved_to_local_agent',clientVersion:'agent-only-20260831'});
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(rejectMaintenanceWrite(req,res))return;
  const operation=String(req.query?.operation||'');
  if(retiredRuntimeOperation(operation)){
    return res.status(410).json({message:'이 방송 실행 기능은 종료되었습니다.',code:'feature_retired'});
  }
  if(operation==='soop-start')return handleSoopOAuthStart(req,res);
  if(operation==='soop-signup-start')return handleSoopSignupOAuthStart(req,res);
  if(operation==='soop-signup-status')return handleSoopSignupOAuthStatus(req,res);
  if(operation==='soop-callback')return handleSoopOAuthCallback(req,res);
  if(operation==='soop-status')return handleSoopOAuthStatus(req,res);
  if(operation==='soop-diagnose')return handleSoopOAuthDiagnose(req,res);
  if(operation==='soop-disconnect')return handleSoopOAuthDisconnect(req,res);
  if(operation==='soop-gateway')return handleSoopGatewayIngress(req,res);
  if(operation==='soop-wallpaper-page')return handleSoopWallpaperOverlayPage(req,res);
  if(operation==='soop-wallpaper-state')return handleSoopWallpaperState(req,res);
  if(operation==='agent-session-validate'){
    try{return await handleAgentSessionValidate(req,res)}
    catch(error){
      console.error('[agent-session-validate] failed',{type:error?.name||'Error',status:error?.status||null});
      return res.status(500).json({message:'Agent 세션을 확인하지 못했습니다.',code:'agent_session_validation_unavailable'});
    }
  }
  if(operation==='agent-web-session'){
    return res.status(410).json({message:'원격 웹 편집기 세션은 종료되었습니다.',code:'wallpaper_editor_moved_local'});
  }
  if(operation==='agent-support')return handleAgentSupport(req,res,{authorize:authorizedAgentWorkspace});
  if(operation==='agent-dashboard-handoff'||operation==='agent-dashboard-login'){
    return handleAgentDashboardHandoff(req,res,{authorize:authorizedAgentWorkspace});
  }
  if(operation==='agent-wallpaper-control')return handleAgentWallpaperControl(req,res);
  if(operation==='signup')return handleSignup(req,res);
  if(operation==='referrer-search')return handleReferrerSearch(req,res);
  if(operation==='signup-status')return handleSignupStatus(req,res);
  if(operation==='inquiry')return handleInquirySubmit(req,res);
  if(['request-reset','confirm-reset','change'].includes(operation))return handlePassword(req,res);
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});

  // Collector 대시보드 자동 로그인 (handoff)
  if(operation==='handoff'){
    try{
      const code=String(bodyOf(req).code||'').trim();
      if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
      if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
      if(!/^[A-Za-z0-9_-]{43}$/.test(code))return res.status(400).json({message:'대시보드 로그인 코드가 올바르지 않습니다.'});
      if(await isRateLimited('handoff:ip:'+clientIp(req),{limit:30,windowMs:5*60*1000}))return res.status(429).json({message:'대시보드 로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'});
      const now=new Date().toISOString();
      const codeHash=crypto.createHash('sha256').update(code).digest('hex');
      const rows=await sb(
        'byeollog_dashboard_handoffs',
        `?select=id,workspace_id,device_id,expires_at,used_at&code_hash=eq.${encodeURIComponent(codeHash)}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}&limit=1`
      );
      const handoff=Array.isArray(rows)?rows[0]:null;
      if(!handoff)return res.status(401).json({message:'대시보드 로그인 링크가 만료되었거나 이미 사용되었습니다.'});

      // M-02: used_at IS NULL 조건으로 PATCH 후 반환 행 수로 원자적 소비 확인
      const consumed=await sb(
        'byeollog_dashboard_handoffs',
        `?id=eq.${encodeURIComponent(handoff.id)}&used_at=is.null`,
        {method:'PATCH',body:{used_at:now},prefer:'return=representation'}
      );
      if(!Array.isArray(consumed)||!consumed.length){
        return res.status(401).json({message:'대시보드 로그인 링크가 만료되었거나 이미 사용되었습니다.'});
      }

      const workspaces=await sb(
        'byeollog_workspaces',
        `?select=id,slug,display_name,status&id=eq.${encodeURIComponent(handoff.workspace_id)}&status=eq.active&limit=1`
      );
      const workspace=Array.isArray(workspaces)?workspaces[0]:null;
      if(!workspace)return res.status(403).json({message:'연결된 워크스페이스를 찾을 수 없습니다.'});

      // H-01 / H-05: 기기 active 상태 재확인
      let deviceId=handoff.device_id||handoff.collector_device_id||null;
      if(!deviceId){
        return res.status(401).json({message:'연결된 Collector 기기를 확인할 수 없습니다.'});
      }
      const devices=await sb(
        'byeollog_collector_devices',
        `?select=id,workspace_id,status,created_by_user_id&id=eq.${encodeURIComponent(deviceId)}`+
        `&workspace_id=eq.${encodeURIComponent(workspace.id)}&status=eq.active&limit=1`
      ).catch(()=>[]);
      const device=Array.isArray(devices)?devices[0]:null;
      if(!device || device.workspace_id!==workspace.id || !device.created_by_user_id){
        return res.status(401).json({message:'연결된 Collector 기기가 해제되었거나 만료되었습니다.'});
      }
      deviceId=device.id;

      const memberships=await sb(
        'byeollog_workspace_members',
        `?select=role,workspace_id,web_session_epoch&user_id=eq.${encodeURIComponent(device.created_by_user_id)}`+
        `&workspace_id=eq.${encodeURIComponent(workspace.id)}&limit=1`
      ).catch(()=>[]);
      const membership=Array.isArray(memberships)?memberships[0]:null;
      if(!membership || membership.workspace_id!==workspace.id){
        return res.status(401).json({message:'Collector를 연결한 계정의 권한을 확인할 수 없습니다.'});
      }

      // 자동 로그인도 기기를 실제로 등록한 멤버의 신원과 현재 역할을 사용한다.
      // 기존 세션은 lib/auth.js의 실시간 재검증에서 같은 방식으로 보완된다.
      setSessionCookie(res,createSessionToken({
        mode:'collector_handoff',
        user_id:device.created_by_user_id,
        workspace_id:workspace.id,
        workspace_slug:workspace.slug,
        role:membership.role,
        collector_device_id:deviceId,
        session_epoch:membership.web_session_epoch,
      }));
      return res.status(200).json({ok:true,mode:'collector_handoff',workspace,role:membership.role});
    }catch(e){
      return res.status(500).json({message:'Collector 대시보드 로그인 처리에 실패했습니다.'});
    }
  }

  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const body=bodyOf(req),id=String(body.id||'').trim(),password=String(body.password||'');

  // M-01: 로그인 rate limit (IP + 계정)
  if(await isRateLimited('login:ip:'+clientIp(req), {limit:20, windowMs:10*60*1000}) ||
     (id && await isRateLimited('login:id:'+id.toLowerCase(), {limit:10, windowMs:10*60*1000}))){
    await sleep(350);
    return res.status(429).json({message:'로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'});
  }


  try{
    const result=await betaLogin(id,password,body.workspace||'');
    if(!result){await sleep(350);return res.status(401).json({message:'이메일 또는 비밀번호가 올바르지 않습니다.'});}
    if(result.error)return res.status(403).json({message:result.error});
    setSessionCookie(res,result.token);
    return res.status(200).json({ok:true,mode:'beta',workspace:result.workspace,role:result.role});
  }catch(e){return res.status(500).json({message:'계정 로그인 처리에 실패했습니다.'});}
}
