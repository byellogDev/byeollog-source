import crypto from 'node:crypto';
import {requireSession,isPlatformAdmin,revalidateMembership,clearSessionCookie} from './auth.js';
import {sb,supabaseConfig} from './supabase-rest.js';
import {isRateLimited,clientIp} from './rate-limit.js';
import {isJsonRequest,isTrustedMutationOrigin} from './request-origin.js';
import {clearSoopSignupCookie,getPendingSoopSignup} from './soop-oauth.js';

function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}
function tokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}
const WORKSPACE_SLUG=/^[a-z0-9][a-z0-9_-]{1,63}$/;

export async function handleReferrerSearch(req,res,{sbImpl=sb,rateLimit=isRateLimited}={}){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  if(Number(req.headers?.['content-length']||0)>2*1024)return res.status(413).json({message:'검색 내용이 너무 큽니다.'});
  if(await rateLimit('signup-referrer-search:ip:'+clientIp(req),{limit:60,windowMs:10*60*1000}))return res.status(429).json({message:'검색 요청이 너무 많습니다. 잠시 후 다시 시도해주세요.'});
  const query=String(bodyOf(req).query||'').trim();
  if(query.length<2||query.length>80||/[\u0000-\u001f\u007f]/.test(query))return res.status(400).json({message:'스트리머명을 두 글자 이상 입력해주세요.'});
  try{
    const rows=await sbImpl('rpc/byeollog_search_referrable_streamers_v1','',{
      method:'POST',body:{p_query:query,p_limit:10}
    });
    const streamers=(Array.isArray(rows)?rows:[]).filter(row=>
      WORKSPACE_SLUG.test(String(row?.workspace_slug||''))&&
      String(row?.streamer_name||'').trim().length>0&&
      String(row?.streamer_name||'').trim().length<=80
      &&!/[\u0000-\u001f\u007f]/.test(String(row.streamer_name))
    ).map(row=>({key:String(row.workspace_slug),name:String(row.streamer_name).trim()}));
    return res.status(200).json({streamers});
  }catch{
    return res.status(500).json({message:'추천 스트리머를 검색하지 못했습니다.'});
  }
}

export async function handleSignup(req,res,{
  sbImpl=sb,rateLimit=isRateLimited,pendingResolver=getPendingSoopSignup,
  createAuthUser=createAuthUserForSignup,deleteAuthUserImpl=deleteAuthUser,
  sendSetupEmail=sendPasswordSetupLink
}={}){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  if(Number(req.headers?.['content-length']||0)>16*1024)return res.status(413).json({message:'가입 신청 내용이 너무 큽니다.'});
  if(await rateLimit('signup:ip:'+clientIp(req),{limit:5,windowMs:10*60*1000}))return res.status(429).json({message:'가입 신청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});

  const b=bodyOf(req);
  const email=String(b.email||'').trim().toLowerCase();
  const streamerName=String(b.streamer_name||'').trim();
  const note=String(b.note||'').trim();
  const referrerWorkspaceSlug=String(b.referrer_workspace_slug||'').trim().toLowerCase();

  if(email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({message:'올바른 이메일을 입력해주세요.'});
  if(await rateLimit('signup:email:'+email,{limit:3,windowMs:10*60*1000}))return res.status(429).json({message:'이 이메일의 가입 신청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  if(!streamerName||streamerName.length>80||/[\u0000-\u001f\u007f]/.test(streamerName))return res.status(400).json({message:'스트리머명을 입력해주세요.'});
  if(note.length>1000)return res.status(400).json({message:'가입 메모는 1,000자 이하로 입력해주세요.'});
  if(referrerWorkspaceSlug&&!WORKSPACE_SLUG.test(referrerWorkspaceSlug))return res.status(400).json({message:'추천한 스트리머를 다시 선택해주세요.'});

  const consents=b.consents;
  if(!consents||consents.termsVersion!=='2026-10-11'||consents.privacyVersion!=='2026-10-11'||consents.termsAgreed!==true||consents.collectionAgreed!==true||consents.age14Confirmed!==true)
    return res.status(400).json({code:'signup_consent_required',message:'현재 약관·개인정보 수집 동의와 만 14세 이상 확인이 필요합니다. 가입 화면을 새로고침해 확인해주세요.'});
  let pending;
  try{
    pending=await pendingResolver(req,{sbImpl});
  }catch(error){
    console.error('[signup] SOOP identity lookup failed',{code:error?.code||'soop_signup_identity_unavailable'});
    return res.status(503).json({message:'SOOP 계정 연결 상태를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'});
  }
  if(!pending)return res.status(409).json({message:'먼저 본인 SOOP 계정을 연결해주세요.',code:'soop_signup_connection_required'});
  const soopId=String(pending.userId||'').trim().toLowerCase();
  if(!/^[a-z0-9_.-]{2,80}$/.test(soopId))return res.status(409).json({message:'SOOP 계정 연결을 다시 진행해주세요.',code:'soop_signup_identity_invalid'});

  try{
    let referrer=null;
    if(referrerWorkspaceSlug){
      const resolved=await sbImpl('rpc/byeollog_resolve_referrable_streamer_v1','',{
        method:'POST',body:{p_workspace_slug:referrerWorkspaceSlug}
      });
      referrer=Array.isArray(resolved)?resolved[0]:null;
      const resolvedName=String(referrer?.streamer_name||'').trim();
      if(!referrer?.workspace_id||!WORKSPACE_SLUG.test(String(referrer.workspace_slug||''))||!resolvedName||resolvedName.length>80||/[\u0000-\u001f\u007f]/.test(resolvedName)){
        return res.status(400).json({message:'추천한 스트리머를 다시 선택해주세요.'});
      }
    }

    let authUser;
    try{authUser=await createAuthUser(email,streamerName,soopId)}
    catch(error){
      if([400,409,422].includes(Number(error?.status)))return res.status(409).json({message:'이미 가입된 이메일이거나 사용할 수 없는 이메일입니다.'});
      throw error;
    }
    let completed;
    try{
      const result=await sbImpl('rpc/byeollog_complete_oauth_signup_v2','',{
        method:'POST',body:{
          p_auth_user_id:authUser.id,p_email:email,p_streamer_name:streamerName,
          p_pending_token_hash:pending.tokenHash,p_referrer_workspace_slug:referrer?.workspace_slug||null,
          p_note:note.slice(0,1000),p_consents:consents
        }
      });
      completed=Array.isArray(result)?result[0]:result;
      if(!completed?.application_id||!completed?.workspace_id)throw new Error('가입 결과가 완전하지 않습니다.');
    }catch(error){
      try{await deleteAuthUserImpl(authUser.id)}catch(compensationError){
        console.error('[signup] auth compensation failed',{code:'oauth_signup_auth_compensation_failed'});
      }
      if(['23505','409'].includes(String(error?.code||error?.status)))return res.status(409).json({message:'이미 가입된 이메일 또는 SOOP 계정입니다.'});
      throw error;
    }

    clearSoopSignupCookie(res);
    let emailSent=false,emailError='';
    try{await sendSetupEmail(email);emailSent=true}catch(error){emailError=String(error?.message||error)}
    try{await recordSetupEmailResult(completed.application_id,emailSent,emailError)}catch{}
    return res.status(201).json({
      ok:true,
      application_id:completed.application_id,
      workspace_slug:completed.workspace_slug,
      password_setup_email_sent:emailSent,
      message:emailSent
        ?'가입이 완료되었습니다. 이메일에서 비밀번호 설정 안내를 확인해주세요.'
        :'가입은 완료되었지만 비밀번호 설정 메일 발송이 지연되고 있습니다. 로그인 화면에서 비밀번호 찾기를 이용해주세요.'
    });
  }catch(e){
    console.error('[signup] automatic signup failed',{code:e?.code||'automatic_signup_failed'});
    return res.status(500).json({message:'가입 신청 처리에 실패했습니다.'});
  }
}

export async function handleSignupStatus(req,res){
  res.setHeader('Cache-Control','no-store');
  if(!['POST'].includes(req.method))return res.status(405).json({message:'Method not allowed'});
  if(await isRateLimited('signup-status:ip:'+clientIp(req),{limit:30,windowMs:10*60*1000}))return res.status(429).json({message:'상태 확인 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  const b=bodyOf(req);
  const token=String(b.token||'').trim();
  if(!/^[A-Za-z0-9_-]{40,80}$/.test(token))return res.status(400).json({message:'유효하지 않은 가입 상태 확인 링크입니다.'});
  if(await isRateLimited('signup-status:token:'+tokenHash(token),{limit:15,windowMs:10*60*1000}))return res.status(429).json({message:'이 링크의 상태 확인 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  try{
    const rows=await sb(
      'byeollog_signup_applications',
      `?select=status,streamer_name,rejection_reason,created_at,reviewed_at&status_token_hash=eq.${encodeURIComponent(tokenHash(token))}&limit=1`
    );
    const app=Array.isArray(rows)?rows[0]:null;
    // 토큰 존재 여부를 외부에 구체적으로 구분해 주지 않는다.
    if(!app)return res.status(404).json({message:'가입 신청을 찾을 수 없거나 확인 링크가 만료되었습니다.'});
    return res.status(200).json({
      ok:true,
      application:{
        status:app.status,
        streamer_name:app.streamer_name,
        rejection_reason:app.status==='rejected'?app.rejection_reason:'',
        created_at:app.created_at,
        reviewed_at:app.reviewed_at
      }
    });
  }catch(e){
    return res.status(500).json({message:'가입 상태를 확인하지 못했습니다.'});
  }
}

async function createAuthUserForSignup(email, streamerName, soopId){
  const {url,serviceRoleKey}=supabaseConfig();
  // 임시 난수 비밀번호 — 사용자는 초대/복구 링크로 재설정
  const tempPassword='Tmp_'+crypto.randomBytes(24).toString('base64url')+'!aA1';
  const authRes=await fetch(`${url}/auth/v1/admin/users`,{
    method:'POST',
    headers:{
      apikey:serviceRoleKey,
      Authorization:'Bearer '+serviceRoleKey,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({
      email,
      password:tempPassword,
      email_confirm:true,
      user_metadata:{streamer_name:streamerName,soop_id:soopId,provisioned_by:'soop_oauth_signup'}
    }),
    cache:'no-store'
  });
  const authData=await authRes.json().catch(()=>({}));
  if(!authRes.ok||!authData?.id){
    const err=new Error(authData?.msg||authData?.message||'Auth 사용자 생성 실패');
    err.status=authRes.status;
    err.detail=authData;
    throw err;
  }
  return authData;
}

async function sendPasswordSetupLink(email){
  const {url,serviceRoleKey}=supabaseConfig();
  // recovery 링크로 비밀번호 설정 유도
  const redirect=process.env.PASSWORD_RESET_REDIRECT_URL
    || (process.env.VERCEL_PROJECT_PRODUCTION_URL?`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/reset-password`:null)
    || (process.env.VERCEL_URL?`https://${process.env.VERCEL_URL}/reset-password`:'https://byeollog.com/reset-password');
  const response=await fetch(`${url}/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`,{
    method:'POST',
    headers:{
      apikey:serviceRoleKey,
      Authorization:'Bearer '+serviceRoleKey,
      'Content-Type':'application/json'
    },
    body:JSON.stringify({email}),
    cache:'no-store'
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok){
    const err=new Error(data?.msg||data?.message||'비밀번호 설정 메일 발송 실패');
    err.status=response.status;err.detail=data;throw err;
  }
  return true;
}

async function deleteAuthUser(userId){
  const {url,serviceRoleKey}=supabaseConfig();
  const response=await fetch(`${url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,{
    method:'DELETE',
    headers:{apikey:serviceRoleKey,Authorization:'Bearer '+serviceRoleKey},
    cache:'no-store'
  });
  if(!response.ok){
    const data=await response.json().catch(()=>({}));
    throw new Error(data?.msg||data?.message||'보상용 Auth 사용자 삭제 실패');
  }
}

async function recordSetupEmailResult(applicationId,ok,error=''){
  return sb('rpc/byeollog_record_setup_email','',{
    method:'POST',
    body:{p_application_id:applicationId,p_ok:!!ok,p_error:String(error||'').slice(0,500)||null}
  });
}

export async function handleSignupApplications(req,res){
  res.setHeader('Cache-Control','no-store, private');
  const cookieSession=requireSession(req,res);if(!cookieSession)return;
  const session=await revalidateMembership(cookieSession);
  if(!session){clearSessionCookie(res);return res.status(401).json({message:'세션이 만료되었거나 권한이 변경되었습니다. 다시 로그인해주세요.'})}
  const platformAdmin=isPlatformAdmin(session);
  if(req.method==='GET'&&String(req.query.capability||'')==='1'){
    return res.status(200).json({platform_admin:platformAdmin});
  }
  if(!platformAdmin)return res.status(403).json({message:'플랫폼 관리자만 사용할 수 있습니다.'});

  try{
    if(req.method==='GET'){
      const rows=await sb('byeollog_signup_applications','?select=*&order=created_at.desc&limit=500');
      return res.status(200).json({applications:Array.isArray(rows)?rows:[]});
    }

    if(req.method==='PATCH'){
      const b=bodyOf(req);
      const id=String(b.id||'').trim();
      const action=String(b.action||'').trim();
      if(!id)return res.status(400).json({message:'신청 ID가 필요합니다.'});
      if(action==='approve'||action==='reject'){
        return res.status(410).json({message:'관리자 승인 방식은 종료되었습니다. 사용자가 가입 화면에서 SOOP 계정을 연결하면 자동으로 가입됩니다.'});
      }

      if(action==='resend_setup'){
        const apps=await sb('byeollog_signup_applications',`?select=id,email,status,auth_user_id&id=eq.${encodeURIComponent(id)}&status=eq.approved&limit=1`);
        const app=Array.isArray(apps)?apps[0]:null;
        if(!app?.auth_user_id)return res.status(409).json({message:'가입 완료된 Auth 계정을 찾을 수 없습니다.'});
        let emailSent=false,emailError='';
        try{await sendPasswordSetupLink(app.email);emailSent=true}catch(mailError){emailError=String(mailError?.message||mailError)}
        let recordWarning='';
        try{await recordSetupEmailResult(id,emailSent,emailError)}catch(recordError){recordWarning=String(recordError?.message||recordError)}
        return res.status(emailSent?200:502).json({ok:emailSent,password_setup_email_sent:emailSent,message:emailSent?'계정 설정 메일을 다시 보냈습니다.':'계정 설정 메일 재발송에 실패했습니다.',detail:emailError,warning:recordWarning});
      }

      return res.status(400).json({message:'지원하지 않는 처리입니다.'});
    }

    return res.status(405).json({message:'Method not allowed'});
  }catch(e){
    return res.status(500).json({message:'가입 신청 관리에 실패했습니다.'});
  }
}
