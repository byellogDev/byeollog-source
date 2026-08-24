import crypto from 'node:crypto';
import {requireSession,isPlatformAdmin,revalidateMembership,clearSessionCookie} from './auth.js';
import {sb,supabaseConfig} from './supabase-rest.js';
import {isRateLimited,clientIp} from './rate-limit.js';

function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}
function stationUrl(id){return id?`https://ch.sooplive.co.kr/${encodeURIComponent(id)}`:''}
function signupStatusToken(){return crypto.randomBytes(32).toString('base64url')}
function tokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}

/**
 * H-04: 가입 신청 단계에서는 Auth 사용자를 만들지 않는다.
 * 비밀번호는 받지 않으며, 승인 시 초대 링크/임시 비밀번호로 계정을 완성한다.
 */
export async function handleSignup(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(await isRateLimited('signup:ip:'+clientIp(req),{limit:5,windowMs:10*60*1000}))return res.status(429).json({message:'가입 신청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});

  const b=bodyOf(req);
  const email=String(b.email||'').trim().toLowerCase();
  const streamerName=String(b.streamer_name||'').trim();
  const soopId=String(b.soop_id||'').trim().toLowerCase();
  const verificationChannel=String(b.verification_channel||'').trim();
  const verificationAccount=String(b.verification_account||'').trim();
  const note=String(b.note||'').trim();

  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({message:'올바른 이메일을 입력해주세요.'});
  if(await isRateLimited('signup:email:'+email,{limit:3,windowMs:10*60*1000}))return res.status(429).json({message:'이 이메일의 가입 신청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
  if(!streamerName||streamerName.length>80)return res.status(400).json({message:'스트리머명을 입력해주세요.'});
  if(!soopId||!/^[a-z0-9_-]{2,40}$/.test(soopId))return res.status(400).json({message:'올바른 SOOP ID를 입력해주세요.'});
  // 인증 채널/계정 폼 제거 — 선택값 없으면 빈 문자열 저장

  try{
    const existing=await sb('byeollog_signup_applications',`?select=id,status,soop_id,status_token_hash&email=eq.${encodeURIComponent(email)}&limit=1`);
    if(Array.isArray(existing)&&existing.length){
      const old=existing[0];
      // Stage 6N6 이전 신청은 원문 토큰이 없으므로, 동일 이메일+SOOP ID 재입력 시 한 번만 링크를 발급한다.
      if(!old.status_token_hash&&String(old.soop_id||'').toLowerCase()===soopId){
        const recoveredToken=signupStatusToken();
        const patched=await sb(
          'byeollog_signup_applications',
          `?id=eq.${encodeURIComponent(old.id)}&status_token_hash=is.null`,
          {method:'PATCH',body:{status_token_hash:tokenHash(recoveredToken),status_token_issued_at:new Date().toISOString()}}
        );
        if(Array.isArray(patched)&&patched.length){
          return res.status(200).json({
            ok:true,
            recovered_status_link:true,
            status_token:recoveredToken,
            status_url:`/signup-status#${recoveredToken}`,
            message:'기존 가입 신청의 상태 확인 링크를 발급했습니다.'
          });
        }
      }
      return res.status(409).json({
        message:old.status==='pending'
          ?'이미 승인 대기 중인 신청이 있습니다.'
          :'이미 가입 신청 이력이 있는 이메일입니다.'
      });
    }

    // 조회 토큰 원문은 사용자에게 한 번만 전달하고 DB에는 SHA-256 해시만 저장한다.
    const statusToken=signupStatusToken();
    const inserted=await sb('byeollog_signup_applications','',{
      method:'POST',
      prefer:'return=representation',
      body:{
        auth_user_id:null,
        email,
        streamer_name:streamerName,
        soop_id:soopId,
        station_url:stationUrl(soopId),
        verification_channel:verificationChannel,
        verification_account:verificationAccount,
        note:note.slice(0,1000),
        status:'pending',
        status_token_hash:tokenHash(statusToken),
        status_token_issued_at:new Date().toISOString(),
        provisioning_state:'pending'
      }
    });

    return res.status(201).json({
      ok:true,
      application_id:Array.isArray(inserted)?inserted[0]?.id:null,
      status_token:statusToken,
      status_url:`/signup-status#${statusToken}`,
      message:'가입 신청이 접수되었습니다. 본인 확인과 관리자 승인 후 이메일로 계정 설정 안내가 발송됩니다.'
    });
  }catch(e){
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

async function createAuthUserForApproval(email, streamerName, soopId){
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
      user_metadata:{streamer_name:streamerName,soop_id:soopId,provisioned_by:'signup_approval'}
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

      if(action==='approve'){
        // 1) 신청 조회
        const apps=await sb('byeollog_signup_applications',`?select=*&id=eq.${encodeURIComponent(id)}&status=eq.pending&limit=1`);
        const app=Array.isArray(apps)?apps[0]:null;
        if(!app)return res.status(409).json({message:'이미 처리되었거나 존재하지 않는 신청입니다.'});

        let authUserId=app.auth_user_id,createdHere=false,approved=false;
        try{
          // 2) Auth 계정을 먼저 만들고 신청서에 연결한다.
          if(!authUserId){
            const authUser=await createAuthUserForApproval(app.email,app.streamer_name,app.soop_id);
            authUserId=authUser.id;createdHere=true;
            const linked=await sb(
              'byeollog_signup_applications',
              `?id=eq.${encodeURIComponent(id)}&status=eq.pending&auth_user_id=is.null`,
              {method:'PATCH',body:{auth_user_id:authUserId,provisioning_state:'auth_created',updated_at:new Date().toISOString()}}
            );
            if(!Array.isArray(linked)||!linked.length)throw new Error('신청서 Auth 연결이 경합으로 취소되었습니다.');
          }

          // 3) 워크스페이스·멤버십·승인 상태는 DB 트랜잭션 RPC에서 확정한다.
          const out=await sb('rpc/byeollog_approve_signup_application','',{
            method:'POST',
            body:{p_application_id:id,p_reviewer:session.user_id||null}
          });
          approved=true;
          let stateWarning='';
          try{await sb('byeollog_signup_applications',`?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:{provisioning_state:'approved'}})}
          catch(stateError){stateWarning=String(stateError?.message||stateError)}

          // 4) 승인 확정 후에만 설정 메일을 보낸다. 실패는 승인과 분리해 재발송 가능하게 기록한다.
          let emailSent=false,emailError='';
          try{await sendPasswordSetupLink(app.email);emailSent=true}
          catch(mailError){emailError=String(mailError?.message||mailError)}
          let recordWarning='';
          try{await recordSetupEmailResult(id,emailSent,emailError)}
          catch(recordError){recordWarning=String(recordError?.message||recordError)}
          const warnings=[stateWarning&&`상태 기록: ${stateWarning}`,recordWarning&&`메일 결과 기록: ${recordWarning}`].filter(Boolean);
          return res.status(200).json({
            ok:true,
            result:Array.isArray(out)?out[0]:out,
            password_setup_email_sent:emailSent,
            email_error:emailSent?'':emailError,
            warnings,
            message:emailSent?'가입 승인과 계정 설정 메일 발송이 완료되었습니다.':'가입은 승인됐지만 계정 설정 메일 발송에 실패했습니다. 재발송을 눌러주세요.'
          });
        }catch(provisionError){
          // 이번 요청에서 만든 Auth만 보상 삭제한다. DB FK는 SET NULL이므로 신청서는 보존된다.
          if(createdHere&&!approved&&authUserId){
            try{await deleteAuthUser(authUserId)}catch(compensationError){
              await sb('byeollog_signup_applications',`?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:{provisioning_state:'auth_created',setup_email_last_error:`승인 실패 및 보상 실패: ${String(compensationError?.message||compensationError).slice(0,400)}`}}).catch(()=>{});
              throw new Error(`${String(provisionError?.message||provisionError)} / Auth 보상 삭제도 실패했습니다.`);
            }
            await sb('byeollog_signup_applications',`?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:{auth_user_id:null,provisioning_state:'pending'}}).catch(()=>{});
          }
          throw provisionError;
        }
      }

      if(action==='resend_setup'){
        const apps=await sb('byeollog_signup_applications',`?select=id,email,status,auth_user_id&id=eq.${encodeURIComponent(id)}&status=eq.approved&limit=1`);
        const app=Array.isArray(apps)?apps[0]:null;
        if(!app?.auth_user_id)return res.status(409).json({message:'승인된 Auth 계정을 찾을 수 없습니다.'});
        let emailSent=false,emailError='';
        try{await sendPasswordSetupLink(app.email);emailSent=true}catch(mailError){emailError=String(mailError?.message||mailError)}
        let recordWarning='';
        try{await recordSetupEmailResult(id,emailSent,emailError)}catch(recordError){recordWarning=String(recordError?.message||recordError)}
        return res.status(emailSent?200:502).json({ok:emailSent,password_setup_email_sent:emailSent,message:emailSent?'계정 설정 메일을 다시 보냈습니다.':'계정 설정 메일 재발송에 실패했습니다.',detail:emailError,warning:recordWarning});
      }

      if(action==='reject'){
        const reason=String(b.reason||'').trim().slice(0,500);
        if(!reason)return res.status(400).json({message:'거절 사유를 입력해주세요.'});
        const rows=await sb(
          'byeollog_signup_applications',
          `?id=eq.${encodeURIComponent(id)}&status=eq.pending`,
          {
            method:'PATCH',
            body:{
              status:'rejected',
              rejection_reason:reason,
              reviewed_at:new Date().toISOString(),
              reviewed_by:session.user_id||null
            }
          }
        );
        if(!Array.isArray(rows)||!rows.length){
          return res.status(409).json({message:'이미 처리되었거나 존재하지 않는 신청입니다.'});
        }
        return res.status(200).json({ok:true});
      }

      return res.status(400).json({message:'지원하지 않는 처리입니다.'});
    }

    return res.status(405).json({message:'Method not allowed'});
  }catch(e){
    return res.status(500).json({message:'가입 신청 관리에 실패했습니다.'});
  }
}
