import {clearSessionCookie,getSession} from './auth.js';
import {isRateLimited,clientIp} from './rate-limit.js';
import crypto from 'node:crypto';

function bodyOf(req){if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}}
function passwordRateLimited(req,operation,limit=5){return isRateLimited(`password:${operation}:ip:${clientIp(req)}`,{limit,windowMs:10*60*1000})}
function config(){
  const url=String(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const anon=process.env.SUPABASE_ANON_KEY||'';
  if(!url||!anon)throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY is not configured');
  return {url,anon};
}
function resetRedirect(){
  const explicit=String(process.env.PASSWORD_RESET_REDIRECT_URL||'').trim();
  if(explicit){
    const parsed=new URL(explicit);
    if(parsed.protocol!=='https:'&&parsed.hostname!=='localhost')throw new Error('PASSWORD_RESET_REDIRECT_URL must use HTTPS');
    return parsed.toString();
  }
  const host=process.env.VERCEL_PROJECT_PRODUCTION_URL||process.env.VERCEL_URL;
  if(!host)throw new Error('PASSWORD_RESET_REDIRECT_URL is not configured');
  return `https://${host}/reset-password`;
}
function validateNewPassword(password){
  if(password.length<10)throw new Error('새 비밀번호는 10자 이상이어야 합니다.');
  if(password.length>128)throw new Error('새 비밀번호는 128자 이하여야 합니다.');
  if(!/[a-z]/.test(password)||!/[A-Z]/.test(password)||!/[0-9]/.test(password)||!/[!@#$%^&*()_+\-=\[\]{};':"|,.<>/?`~\\]/.test(password))
    throw new Error('새 비밀번호에는 영문 대문자·소문자·숫자·특수문자를 각각 포함해주세요.');
}
async function assertPasswordNotLeaked(password){
  const hash=crypto.createHash('sha1').update(password,'utf8').digest('hex').toUpperCase();
  const prefix=hash.slice(0,5),suffix=hash.slice(5);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),5000);
  try{
    const response=await fetch(`https://api.pwnedpasswords.com/range/${prefix}`,{
      headers:{'Add-Padding':'true','User-Agent':'Byeollog-Password-Security/Stage6N8'},
      cache:'no-store',signal:controller.signal
    });
    if(!response.ok){const error=new Error('유출 비밀번호 확인 서비스에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.');error.status=503;throw error}
    const body=await response.text();
    const leaked=body.split(/\r?\n/).some(line=>{const [candidate,count]=line.split(':');return candidate===suffix&&Number(count)>0});
    if(leaked)throw new Error('유출 이력이 있는 비밀번호입니다. 다른 비밀번호를 사용해주세요.');
  }catch(e){
    if(e?.name==='AbortError'){const error=new Error('유출 비밀번호 확인 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.');error.status=503;throw error}
    throw e;
  }finally{clearTimeout(timeout)}
}
async function signIn(email,password){
  const {url,anon}=config();
  const response=await fetch(`${url}/auth/v1/token?grant_type=password`,{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email,password}),cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  return response.ok&&data?.access_token?data:null;
}
async function updatePassword(accessToken,password){
  const {url,anon}=config();
  const response=await fetch(`${url}/auth/v1/user`,{method:'PUT',headers:{apikey:anon,Authorization:'Bearer '+accessToken,'Content-Type':'application/json'},body:JSON.stringify({password}),cache:'no-store'});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw new Error(data?.msg||data?.message||'비밀번호를 변경하지 못했습니다.');
}

export default async function handlePassword(req,res){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const operation=String(req.query?.operation||''),body=bodyOf(req);
  try{
    if(operation==='request-reset'){
      if(await passwordRateLimited(req,operation))return res.status(429).json({message:'요청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
      const email=String(body.email||'').trim().toLowerCase();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return res.status(400).json({message:'올바른 이메일을 입력해주세요.'});
      if(await isRateLimited('password:request-reset:email:'+email,{limit:3,windowMs:10*60*1000}))return res.status(429).json({message:'이 이메일의 요청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
      const {url,anon}=config();
      const recovery=await fetch(`${url}/auth/v1/recover?redirect_to=${encodeURIComponent(resetRedirect())}`,{method:'POST',headers:{apikey:anon,'Content-Type':'application/json'},body:JSON.stringify({email}),cache:'no-store'});
      if(!recovery.ok){const data=await recovery.json().catch(()=>({}));throw new Error(data?.msg||data?.message||'비밀번호 변경 메일을 전송하지 못했습니다.')}
      return res.status(200).json({ok:true,message:'이메일로 비밀번호 변경 링크를 전송하였습니다.'});
    }
    if(operation==='confirm-reset'){
      if(await passwordRateLimited(req,operation,10))return res.status(429).json({message:'요청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
      const accessToken=String(body.access_token||''),password=String(body.password||'');
      if(!accessToken)return res.status(400).json({message:'재설정 링크가 없거나 만료되었습니다.'});
      try{validateNewPassword(password);await assertPasswordNotLeaked(password)}catch(passwordError){return res.status(Number(passwordError?.status)||400).json({message:String(passwordError?.message||passwordError)})}
      await updatePassword(accessToken,password);
      clearSessionCookie(res);
      return res.status(200).json({ok:true,message:'비밀번호가 변경되었습니다. 새 비밀번호로 로그인해주세요.'});
    }
    if(operation==='change'){
      const session=getSession(req);
      if(!session)return res.status(401).json({message:'관리자 세션이 만료되었습니다.'});
      if(session.mode!=='beta'||!session.email)return res.status(403).json({message:'베타 계정에서만 비밀번호를 변경할 수 있습니다.'});
      if(await passwordRateLimited(req,operation))return res.status(429).json({message:'요청 횟수를 초과했습니다. 잠시 후 다시 시도해주세요.'});
      const currentPassword=String(body.current_password||''),password=String(body.password||'');
      try{validateNewPassword(password);await assertPasswordNotLeaked(password)}catch(passwordError){return res.status(Number(passwordError?.status)||400).json({message:String(passwordError?.message||passwordError)})}
      if(currentPassword===password)return res.status(400).json({message:'현재 비밀번호와 다른 비밀번호를 입력해주세요.'});
      const auth=await signIn(session.email,currentPassword);
      if(!auth)return res.status(401).json({message:'현재 비밀번호가 올바르지 않습니다.'});
      await updatePassword(auth.access_token,password);
      clearSessionCookie(res);
      return res.status(200).json({ok:true,message:'비밀번호가 변경되었습니다. 새 비밀번호로 다시 로그인해주세요.'});
    }
    return res.status(400).json({message:'지원하지 않는 처리입니다.'});
  }catch(e){
    return res.status(500).json({message:'비밀번호 처리에 실패했습니다.'});
  }
}
