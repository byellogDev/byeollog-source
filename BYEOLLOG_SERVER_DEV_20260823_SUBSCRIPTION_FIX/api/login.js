import crypto from 'node:crypto';
import {createSessionToken,setSessionCookie} from '../lib/auth.js';
import {sb} from '../lib/supabase-rest.js';
import {handleSignup,handleSignupStatus} from '../lib/signup.js';
import handlePassword from '../lib/password.js';
import {isRateLimited, clientIp} from '../lib/rate-limit.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {isJsonRequest,isTrustedMutationOrigin} from '../lib/request-origin.js';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
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
  const memberships=await sb('byeollog_workspace_members',`?select=workspace_id,role,byeollog_workspaces(id,slug,display_name,status)&user_id=eq.${encodeURIComponent(userId)}`);
  let rows=Array.isArray(memberships)?memberships.filter(x=>x?.byeollog_workspaces?.status==='active'):[];
  if(requestedWorkspace)rows=rows.filter(x=>x.workspace_id===requestedWorkspace||x.byeollog_workspaces?.slug===requestedWorkspace);
  if(!rows.length){
    const applications=await sb('byeollog_signup_applications',`?select=status,rejection_reason&auth_user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc&limit=1`).catch(()=>[]);
    const application=Array.isArray(applications)?applications[0]:null;
    if(application?.status==='pending')return {error:'가입 신청을 확인하고 있습니다. 관리자 승인 후 이용할 수 있습니다.'};
    if(application?.status==='rejected')return {error:'가입 신청이 승인되지 않았습니다.'+(application.rejection_reason?` 사유: ${application.rejection_reason}`:'')};
    return {error:'이 계정에 연결된 별록 워크스페이스가 없습니다.'};
  }
  const m=rows[0],w=m.byeollog_workspaces;
  return {token:createSessionToken({mode:'beta',user_id:userId,email:data.user.email,workspace_id:m.workspace_id,workspace_slug:w?.slug,role:m.role}),workspace:w,role:m.role};
}


async function handleInquirySubmit(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
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

function soopCallbackPage({kind='ready'}={}){
  const copy={
    ready:{
      title:'SOOP 연동 콜백이 준비되었습니다',
      message:'이 주소는 SOOP 계정 연결 후 인증 결과를 받는 별록의 공식 콜백 URL입니다.'
    },
    received:{
      title:'SOOP 인증 응답을 확인했습니다',
      message:'개발자 연동 승인 후 실제 계정 연결 기능이 활성화됩니다.'
    },
    denied:{
      title:'SOOP 계정 연결이 완료되지 않았습니다',
      message:'SOOP 인증 화면에서 계정 연결을 다시 진행해주세요.'
    }
  }[kind]||null;
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>별록 | SOOP 인증 연결</title>
  <style>
    :root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#071a38;color:#f7f9ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(560px,100%);padding:34px;border:1px solid #29456d;border-radius:24px;background:#0b2144;box-shadow:0 20px 60px #0005}.eyebrow{margin:0 0 12px;color:#ffc44d;font-size:14px;font-weight:800;letter-spacing:.08em}.title{margin:0;font-size:clamp(26px,6vw,38px);line-height:1.2}.message{margin:18px 0 0;color:#c8d5eb;font-size:17px;line-height:1.7}.home{display:inline-block;margin-top:26px;color:#071a38;background:#ffc44d;padding:12px 18px;border-radius:12px;font-weight:800;text-decoration:none}
  </style>
</head>
<body>
  <main class="card">
    <p class="eyebrow">BYEOLLOG × SOOP</p>
    <h1 class="title">${copy.title}</h1>
    <p class="message">${copy.message}</p>
    <a class="home" href="/">별록 홈으로 돌아가기</a>
  </main>
</body>
</html>`;
}

function handleSoopCallback(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Robots-Tag','noindex, noarchive');
  if(!['GET','HEAD'].includes(req.method)){
    res.setHeader('Allow','GET, HEAD');
    return res.status(405).send('Method not allowed');
  }

  // SOOP은 성공 시 authCode를 전달한다. 승인 전에는 값을 저장·기록·노출하지 않는다.
  const denied=Boolean(String(req.query?.error||'').trim());
  const received=Boolean(String(req.query?.authCode||'').trim());
  const status=denied?400:200;
  if(req.method==='HEAD')return res.status(status).end();
  return res.status(status).send(soopCallbackPage({kind:denied?'denied':received?'received':'ready'}));
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store');
  if(rejectMaintenanceWrite(req,res))return;
  const operation=String(req.query?.operation||'');
  if(operation==='soop-callback')return handleSoopCallback(req,res);
  if(operation==='signup')return handleSignup(req,res);
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
        `?select=id,workspace_id,status&id=eq.${encodeURIComponent(deviceId)}`+
        `&workspace_id=eq.${encodeURIComponent(workspace.id)}&status=eq.active&limit=1`
      ).catch(()=>[]);
      const device=Array.isArray(devices)?devices[0]:null;
      if(!device || device.workspace_id!==workspace.id){
        return res.status(401).json({message:'연결된 Collector 기기가 해제되었거나 만료되었습니다.'});
      }
      deviceId=device.id;

      // handoff는 Collector를 소유한 스트리머의 대시보드 접근이므로 owner 역할을 부여.
      // 기기 등록 자체는 owner만 가능하도록 제한되어 있음.
      setSessionCookie(res,createSessionToken({
        mode:'collector_handoff',
        workspace_id:workspace.id,
        workspace_slug:workspace.slug,
        role:'owner',
        collector_device_id:deviceId,
      }));
      return res.status(200).json({ok:true,mode:'collector_handoff',workspace});
    }catch(e){
      return res.status(500).json({message:'Collector 대시보드 로그인 처리에 실패했습니다.'});
    }
  }

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
