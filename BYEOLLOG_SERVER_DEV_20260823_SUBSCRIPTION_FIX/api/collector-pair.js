import crypto from 'node:crypto';
import {sb} from '../lib/supabase-rest.js';
import {sha256,q} from '../lib/workspace.js';
import {isRateLimited, clientIp} from '../lib/rate-limit.js';
import {
  AUTOMATION_SESSION_MODE,
  buildAutomationSessionResponseFields,
  evaluateAutomationSessionEligibility,
  evaluateAutomationSessionRequest,
  OFFSL_AUTOMATION_PROJECT_REF,
  OFFSL_AUTOMATION_PROJECT_URL,
  PUBLIC_AUTOMATION_RELEASE_EVIDENCE
} from '../lib/collector-automation-session-contract.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}

async function authenticateAccount(email,password,requestedWorkspace=''){
  const url=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const anon=process.env.SUPABASE_ANON_KEY||process.env.SUPABASE_SECRET_KEY||'';
  if(!url||!anon)throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY is not configured');

  const auth=await fetch(`${url}/auth/v1/token?grant_type=password`,{
    method:'POST',
    headers:{apikey:anon,'Content-Type':'application/json'},
    body:JSON.stringify({email,password}),
    cache:'no-store'
  });
  const data=await auth.json().catch(()=>({}));
  if(!auth.ok||!data?.user?.id)return null;

  const memberships=await sb(
    'byeollog_workspace_members',
    `?select=workspace_id,role,byeollog_workspaces(id,slug,display_name,status)&user_id=eq.${q(data.user.id)}`
  );

  let rows=Array.isArray(memberships)
    ? memberships.filter(x=>x?.byeollog_workspaces?.status==='active')
    : [];

  if(requestedWorkspace){
    rows=rows.filter(x=>
      x.workspace_id===requestedWorkspace ||
      x.byeollog_workspaces?.slug===requestedWorkspace
    );
  }

  if(!rows.length)return {
    error:'이 계정에 연결된 활성 별록 워크스페이스가 없습니다.',
    code:'workspace_not_found',
    status:403
  };
  if(rows.length>1)return {
    error:requestedWorkspace
      ? '요청한 워크스페이스가 중복되어 안전하게 선택할 수 없습니다.'
      : '연결할 워크스페이스를 선택해주세요.',
    code:requestedWorkspace?'workspace_ambiguous':'workspace_selection_required',
    status:409
  };
  const m=rows[0];
  return {
    user:data.user,
    workspace_id:m.workspace_id,
    workspace:m.byeollog_workspaces,
    role:m.role,
    auth_session:data
  };
}

async function buildAccountAutomationFields(body,account){
  // This release is pinned to one Supabase project. The non-secret constants
  // keep an API-uploaded deployment deterministic; explicit env values still
  // override them, including a non-matching mode as an additional kill switch.
  const policyInput={
    requestBody:body,
    supabaseUrl:process.env.SUPABASE_URL,
    configuredProjectUrl:process.env.BYEOLLOG_AUTOMATION_PROJECT_URL||OFFSL_AUTOMATION_PROJECT_URL,
    configuredProjectRef:process.env.BYEOLLOG_AUTOMATION_PROJECT_REF||OFFSL_AUTOMATION_PROJECT_REF,
    automationSessionMode:process.env.BYEOLLOG_AUTOMATION_SESSION_MODE||AUTOMATION_SESSION_MODE
  };
  const requestDecision=evaluateAutomationSessionRequest(policyInput);
  if(!requestDecision.eligible)return {};

  const omit=(reason,error=null)=>{
    const detail=error?.detail&&typeof error.detail==='object'?error.detail:{};
    console.warn('[collector-pair:automation] omitted',{
      reason,
      status:Number.isFinite(Number(error?.status))?Number(error.status):null,
      code:String(detail.code||error?.code||'').slice(0,40)||null,
      type:String(error?.name||error?.constructor?.name||'').slice(0,80)||null
    });
    // Keep Collector pairing additive and fail-closed, but return a non-secret
    // diagnostic so the Agent can distinguish an automation hand-off failure
    // from a normal legacy-only login.
    return {automation_ready:false,automation_status:String(reason).slice(0,96)};
  };

  const controller=new AbortController();
  // Enrollment and readiness are sequential database RPCs. Both enforce their
  // own 5 second statement_timeout, so the former 2 second shared deadline
  // could cancel healthy cold-start logins before the Agent session was issued.
  // This path runs only while pairing; it is not on donation/action hot paths.
  const timer=setTimeout(()=>controller.abort(),12000);
  let stage='enrollment';
  try{
    const userId=account.user?.id;
    const workspaceId=account.workspace_id;
    // Public distribution remains fail-closed. The service-only RPC creates
    // the exact workspace mirror/gate only for an active owner membership.
    // Existing disabled rows are never re-enabled by login, preserving a
    // workspace-specific emergency stop.
    const enrollmentRows=await sb('rpc/byeollog_ensure_automation_workspace_v1','',{
      method:'POST',
      body:{
        p_workspace_id:workspaceId,
        p_authorized_user_id:userId,
        p_release_evidence:PUBLIC_AUTOMATION_RELEASE_EVIDENCE
      },
      signal:controller.signal
    });
    if(!Array.isArray(enrollmentRows)||enrollmentRows.length!==1)return omit('enrollment_shape');
    if(enrollmentRows[0]?.workspace_id!==workspaceId
      ||enrollmentRows[0]?.authorized_user_id!==userId
      ||enrollmentRows[0]?.enabled!==true)return omit('enrollment_receipt');

    stage='readiness';
    const readinessRows=await sb('rpc/g3a_automation_schema_readiness_v1','',{
      method:'POST',
      body:{
        p_workspace_id:workspaceId,
        p_authorized_user_id:userId
      },
      signal:controller.signal
    });
    if(!Array.isArray(readinessRows)||readinessRows.length!==1)return omit('readiness_shape');
    if(readinessRows[0]?.workspace_id!==workspaceId)return omit('readiness_workspace');
    if(readinessRows[0]?.authorized_user_id!==userId)return omit('readiness_user');

    stage='session_policy';
    const decision=evaluateAutomationSessionEligibility({
      ...policyInput,
      readiness:readinessRows[0],
      authorizedWorkspaceId:workspaceId,
      authorizedUserId:userId
    });
    const fields=buildAutomationSessionResponseFields(decision,account.auth_session);
    if(fields.automation_ready!==true)return omit('session_policy_'+String(decision?.reason||'ineligible'));
    return fields;
  }catch(error){
    // Automation is additive. A readiness/allowlist outage must not break pairing.
    return omit(stage+'_error',error);
  }finally{
    clearTimeout(timer);
  }
}

async function registerDirectDevice(body, req){
  const email=String(body.email||body.id||'').trim();
  const password=String(body.password||'');
  if(!email||!password)return {status:400,body:{message:'이메일과 비밀번호를 입력해주세요.'}};
  if(req && (await isRateLimited('pair:ip:'+clientIp(req), {limit:15, windowMs:10*60*1000}) ||
             await isRateLimited('pair:email:'+email.toLowerCase(), {limit:8, windowMs:10*60*1000}))){
    return {status:429,body:{message:'연결 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.'}};
  }

  const account=await authenticateAccount(email,password,String(body.workspace||'').trim());
  if(!account)return {status:401,body:{message:'이메일 또는 비밀번호가 올바르지 않습니다.'}};
  if(account.error)return {
    status:Number(account.status)||403,
    body:{message:account.error,code:account.code||'workspace_forbidden'}
  };

  // H-01: 기기 등록은 owner만 허용
  const role = String(account.role||'').toLowerCase();
  if(role !== 'owner'){
    return {status:403,body:{message:'Collector 기기 등록은 워크스페이스 소유자(owner)만 할 수 있습니다.', current_role: role || 'unknown'}};
  }

  const now=new Date().toISOString();
  const deviceName=String(body.device_name||'별록 Collector').trim().slice(0,80)||'별록 Collector';
  const version=String(body.collector_version||'unknown').slice(0,40);
  const token='blc_'+crypto.randomBytes(32).toString('base64url');
  const expiresAt=new Date(Date.now()+90*24*60*60*1000).toISOString();

  // H-02 / G1: 기존 active 토큰 폐기와 새 device row 확정은 DB 트랜잭션
  // 하나에서만 수행한다. RPC가 실패하면 PostgreSQL이 전체 변경을 rollback하므로
  // v0.5.1.8이 사용 중인 기존 토큰은 그대로 유효하다.
  const rows=await sb('rpc/byeollog_rotate_collector_device_v1','',{
    method:'POST',
    body:{
      p_workspace_id:account.workspace_id,
      p_device_name:deviceName,
      p_token_hash:sha256(token),
      p_collector_version:version,
      p_token_expires_at:expiresAt,
      p_created_by_user_id:account.user?.id||null
    }
  });
  const device=Array.isArray(rows)&&rows.length===1?rows[0]:null;
  if(!device?.id||device.workspace_id!==account.workspace_id){
    throw new Error('Atomic Collector device rotation returned an invalid receipt');
  }

  await sb('byeollog_audit_log','',{
    method:'POST',
    body:{
      workspace_id:account.workspace_id,
      actor_user_id:account.user?.id||null,
      actor_kind:'user',
      action:'collector_account_login_registered',
      target_type:'collector_device',
      target_id:device?.id||null,
      metadata:{
        device_name:deviceName,
        collector_version:version,
        email:account.user?.email||email
      }
    }
  }).catch(()=>{});

  const automationFields=await buildAccountAutomationFields(body,account);

  return {
    status:200,
    body:{
      ok:true,
      mode:'account',
      device_token:token,
      device_id:device?.id||null,
      workspace_id:account.workspace_id,
      workspace:account.workspace,
      role:account.role,
      upload_url:'/api/collector',
      ...automationFields
    }
  };
}

async function registerPairingCode(body){
  const code=String(body.code||'').trim().toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(code.length!==8)return {status:400,body:{message:'8자리 연결 코드를 입력해주세요.'}};

  const hash=sha256(code),now=new Date().toISOString();
  const rows=await sb(
    'byeollog_collector_devices',
    `?select=*&pairing_code_hash=eq.${q(hash)}&status=eq.pending&pairing_expires_at=gt.${q(now)}&limit=1`
  );
  const device=Array.isArray(rows)?rows[0]:null;
  if(!device)return {status:400,body:{message:'연결 코드가 올바르지 않거나 만료되었습니다.'}};

  const workspaces=await sb(
    'byeollog_workspaces',
    `?select=id,status&id=eq.${q(device.workspace_id)}&status=eq.active&limit=1`
  );
  if(!Array.isArray(workspaces)||workspaces[0]?.id!==device.workspace_id){
    return {status:403,body:{message:'연결된 워크스페이스가 비활성 상태입니다.'}};
  }

  const token='blc_'+crypto.randomBytes(32).toString('base64url');
  const expiresAt=new Date(Date.now()+90*24*60*60*1000).toISOString();
  await sb('byeollog_collector_devices',`?id=eq.${q(device.id)}`,{
    method:'PATCH',
    body:{
      status:'active',
      token_hash:sha256(token),
      pairing_code_hash:null,
      pairing_expires_at:null,
      collector_version:String(body.collector_version||'unknown').slice(0,40),
      last_seen_at:now,
      paired_at:now,
      last_rotated_at:now,
      token_expires_at:expiresAt
    }
  });

  await sb('byeollog_audit_log','',{
    method:'POST',
    body:{
      workspace_id:device.workspace_id,
      actor_kind:'collector',
      action:'collector_paired',
      target_type:'collector_device',
      target_id:device.id,
      metadata:{
        device_name:body.device_name||device.device_name,
        collector_version:body.collector_version||null
      }
    }
  }).catch(()=>{});

  return {
    status:200,
    body:{
      ok:true,
      mode:'pairing_code',
      device_token:token,
      device_id:device.id,
      workspace_id:device.workspace_id,
      upload_url:'/api/collector'
    }
  };
}

async function createDashboardHandoff(req){
  const authorization=String(req.headers?.authorization||'');
  const token=authorization.replace(/^Bearer\s+/i,'').trim();
  if(!token)return {status:401,body:{message:'Collector 기기 인증 정보가 없습니다.'}};

  let devices;
  try{
    devices=await sb(
      'byeollog_collector_devices',
      `?select=id,workspace_id,status,token_expires_at&token_hash=eq.${q(sha256(token))}&status=eq.active&limit=1`
    );
  }catch(e){
    return {status:500,body:{message:'Collector 기기 조회에 실패했습니다.'}};
  }
  const device=Array.isArray(devices)?devices[0]:null;
  if(!device?.workspace_id)return {status:401,body:{message:'Collector 기기 인증이 만료되었거나 해제되었습니다. 프로그램을 다시 로그인해주세요.'}};

  // 만료 토큰이면 명확히 안내 (500 대신 401)
  if(device.token_expires_at){
    const exp=Date.parse(device.token_expires_at);
    if(Number.isFinite(exp) && exp < Date.now()){
      await sb('byeollog_collector_devices',`?id=eq.${q(device.id)}`,{
        method:'PATCH',body:{status:'revoked',token_hash:null,revoked_at:new Date().toISOString()}
      }).catch(()=>{});
      return {status:401,body:{message:'Collector 기기 토큰이 만료되었습니다. 프로그램을 다시 로그인해주세요.'}};
    }
  }

  const code=crypto.randomBytes(32).toString('base64url');
  const now=new Date();
  const expires=new Date(now.getTime()+45*1000).toISOString(); // 방송 주소창 노출 대비 45초
  try{
    await sb('byeollog_dashboard_handoffs','',{
      method:'POST',
      body:{
        workspace_id:device.workspace_id,
        device_id:device.id,
        code_hash:sha256(code),
        expires_at:expires
      }
    });
  }catch(e){
    return {status:500,body:{message:'대시보드 로그인 코드 발급에 실패했습니다.'}};
  }

  await sb('byeollog_collector_devices',`?id=eq.${q(device.id)}`,{
    method:'PATCH',body:{last_seen_at:now.toISOString()}
  }).catch(()=>{});

  // Fragment values are not sent in the HTTP request line, CDN logs, or Referer.
  // The login page consumes and removes it immediately; legacy query links remain
  // accepted there only for a backwards-compatible transition.
  return {status:200,body:{ok:true,mode:'dashboard_handoff',dashboard_url:`/login#handoff=${encodeURIComponent(code)}`,expires_at:expires}};
}

export default async function handler(req,res){
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});

  const body=bodyOf(req);
  try{
    if(String(body.mode||'').toLowerCase()==='dashboard_handoff'){
      const result=await createDashboardHandoff(req);
      return res.status(result.status).json(result.body);
    }

    // 기본: Collector에서 별록 관리자 계정으로 로그인하여 기기 등록.
    if(String(body.mode||'').toLowerCase()==='account' || body.email || body.password){
      const result=await registerDirectDevice(body, req);
      return res.status(result.status).json(result.body);
    }

    // 숨김/보조 기능: 관리자 페이지에서 발급한 8자리 연결 코드.
    const result=await registerPairingCode(body);
    return res.status(result.status).json(result.body);
  }catch(e){
    console.error('collector pair failed',e);
    return res.status(500).json({message:'Collector 연결 처리에 실패했습니다.'});
  }
}
