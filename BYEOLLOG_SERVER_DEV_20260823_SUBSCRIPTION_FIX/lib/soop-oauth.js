import crypto from 'node:crypto';
import {clearSessionCookie,requireCapabilityLive,revalidateMembership,safeEqual} from './auth.js';
import {sb} from './supabase-rest.js';

const SOOP_OPENAPI_ORIGIN='https://openapi.sooplive.com';
const SOOP_AUTHORIZATION_PATH='/auth/code';
const SOOP_TOKEN_PATH='/auth/token';
const DEFAULT_REDIRECT_URI='https://byeollog.com/api/auth/soop/callback';
const ATTEMPT_COOKIE='byeollog_soop_oauth_attempt';
const ATTEMPT_TTL_SECONDS=10*60;
const TOKEN_AAD=Buffer.from('byeollog:soop-oauth-token:v1','utf8');

export class SoopOAuthError extends Error{
  constructor(message,code='soop_oauth_failed',status=500){
    super(message);
    this.name='SoopOAuthError';
    this.code=code;
    this.status=status;
  }
}

function envText(env,name){return String(env?.[name]||'').trim()}

function parseEncryptionKey(env=process.env){
  const raw=envText(env,'SOOP_TOKEN_ENCRYPTION_KEY');
  let key;
  if(/^[0-9a-f]{64}$/i.test(raw))key=Buffer.from(raw,'hex');
  else{
    try{key=Buffer.from(raw,'base64url')}catch{key=Buffer.alloc(0)}
  }
  if(key.length!==32){
    throw new SoopOAuthError('SOOP_TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes','soop_encryption_key_invalid',503);
  }
  return key;
}

export function getSoopOAuthConfig(env=process.env){
  const clientId=envText(env,'SOOP_CLIENT_ID');
  const clientSecret=envText(env,'SOOP_CLIENT_SECRET');
  const redirectUri=envText(env,'SOOP_REDIRECT_URI')||DEFAULT_REDIRECT_URI;
  if(!/^[A-Za-z0-9._-]{16,200}$/.test(clientId)){
    throw new SoopOAuthError('SOOP_CLIENT_ID is not configured','soop_client_id_missing',503);
  }
  if(clientSecret.length<24||clientSecret.length>500){
    throw new SoopOAuthError('SOOP_CLIENT_SECRET is not configured','soop_client_secret_missing',503);
  }
  let parsedRedirect;
  try{parsedRedirect=new URL(redirectUri)}catch{
    throw new SoopOAuthError('SOOP_REDIRECT_URI is invalid','soop_redirect_uri_invalid',503);
  }
  if(parsedRedirect.href!==DEFAULT_REDIRECT_URI){
    throw new SoopOAuthError('SOOP_REDIRECT_URI must match the registered production callback','soop_redirect_uri_invalid',503);
  }
  parseEncryptionKey(env);
  return {
    clientId,clientSecret,redirectUri,
    authorizationUrl:`${SOOP_OPENAPI_ORIGIN}${SOOP_AUTHORIZATION_PATH}`,
    tokenUrl:`${SOOP_OPENAPI_ORIGIN}${SOOP_TOKEN_PATH}`
  };
}

export function getSoopOAuthReadiness(env=process.env){
  const enabled=envText(env,'SOOP_OAUTH_ENABLED')==='true';
  try{
    getSoopOAuthConfig(env);
    return {enabled,configured:true};
  }catch(error){
    return {enabled,configured:false,code:error?.code||'soop_oauth_config_invalid'};
  }
}

function attemptSecret(env=process.env){
  const value=envText(env,'SESSION_SECRET');
  if(value.length<32)throw new SoopOAuthError('OAuth attempt signing is unavailable','soop_attempt_secret_missing',503);
  return value;
}

function signAttempt(encoded,env=process.env){
  return crypto.createHmac('sha256',attemptSecret(env)).update(encoded).digest('hex');
}

export function createSoopOAuthAttempt(session,{env=process.env,now=Date.now(),nonce}={}){
  if(!session?.user_id||!session?.workspace_id){
    throw new SoopOAuthError('SOOP 연결은 별록 계정으로 로그인한 스트리머만 시작할 수 있습니다.','soop_user_session_required',403);
  }
  const state=nonce||crypto.randomBytes(32).toString('base64url');
  const payload={
    v:1,
    exp:Math.floor(now/1000)+ATTEMPT_TTL_SECONDS,
    nonce:state,
    user_id:String(session.user_id),
    workspace_id:String(session.workspace_id)
  };
  const encoded=Buffer.from(JSON.stringify(payload),'utf8').toString('base64url');
  return {state,token:`${encoded}.${signAttempt(encoded,env)}`,expiresIn:ATTEMPT_TTL_SECONDS};
}

export function verifySoopOAuthAttempt(token,{env=process.env,now=Date.now()}={}){
  const [encoded,signature,extra]=String(token||'').split('.');
  if(!encoded||!signature||extra!==undefined)return null;
  const expected=signAttempt(encoded,env);
  if(!safeEqual(signature,expected))return null;
  try{
    const value=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
    if(value?.v!==1||!value.nonce||!value.user_id||!value.workspace_id)return null;
    if(!Number.isSafeInteger(value.exp)||value.exp<Math.floor(now/1000))return null;
    return value;
  }catch{return null}
}

function cookiesOf(req){
  const raw=String(req?.headers?.cookie||'');
  return Object.fromEntries(raw.split(';').map(value=>value.trim()).filter(Boolean).map(value=>{
    const index=value.indexOf('=');
    const key=index<0?value:value.slice(0,index);
    const item=index<0?'':value.slice(index+1);
    try{return [decodeURIComponent(key),decodeURIComponent(item)]}catch{return [key,item]}
  }));
}

function appendSetCookie(res,value){
  const current=typeof res.getHeader==='function'?res.getHeader('Set-Cookie'):undefined;
  if(Array.isArray(current))res.setHeader('Set-Cookie',[...current,value]);
  else if(current)res.setHeader('Set-Cookie',[String(current),value]);
  else res.setHeader('Set-Cookie',value);
}

function setAttemptCookie(res,token,maxAge=ATTEMPT_TTL_SECONDS){
  appendSetCookie(res,`${ATTEMPT_COOKIE}=${encodeURIComponent(token)}; Path=/api/auth/soop/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearAttemptCookie(res){
  setAttemptCookie(res,'',0);
}

export function encryptSoopToken(value,{env=process.env,key}={}){
  const secret=key||parseEncryptionKey(env);
  if(!Buffer.isBuffer(secret)||secret.length!==32)throw new SoopOAuthError('Invalid SOOP token encryption key','soop_encryption_key_invalid',503);
  const iv=crypto.randomBytes(12);
  const cipher=crypto.createCipheriv('aes-256-gcm',secret,iv);
  cipher.setAAD(TOKEN_AAD);
  const encrypted=Buffer.concat([cipher.update(String(value),'utf8'),cipher.final()]);
  const tag=cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${encrypted.toString('base64url')}`;
}

export function decryptSoopToken(value,{env=process.env,key}={}){
  const secret=key||parseEncryptionKey(env);
  const [version,ivText,tagText,cipherText,extra]=String(value||'').split('.');
  if(version!=='v1'||!ivText||!tagText||!cipherText||extra!==undefined){
    throw new SoopOAuthError('Stored SOOP token is invalid','soop_token_ciphertext_invalid',500);
  }
  try{
    const decipher=crypto.createDecipheriv('aes-256-gcm',secret,Buffer.from(ivText,'base64url'));
    decipher.setAAD(TOKEN_AAD);
    decipher.setAuthTag(Buffer.from(tagText,'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(cipherText,'base64url')),decipher.final()]).toString('utf8');
  }catch{
    throw new SoopOAuthError('Stored SOOP token could not be decrypted','soop_token_decryption_failed',500);
  }
}

function positiveExpiresIn(value){
  const number=Number(value);
  return Number.isFinite(number)&&number>0?Math.min(Math.trunc(number),31_536_000):null;
}

export async function requestSoopTokens(parameters,{env=process.env,fetchImpl=fetch,signal}={}){
  const config=getSoopOAuthConfig(env);
  const controller=signal?null:new AbortController();
  const timer=controller?setTimeout(()=>controller.abort(),10_000):null;
  let response;
  try{
    response=await fetchImpl(config.tokenUrl,{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded;charset=utf-8'},
      body:new URLSearchParams({
        ...parameters,
        client_id:config.clientId,
        client_secret:config.clientSecret
      }).toString(),
      cache:'no-store',
      signal:signal||controller.signal
    });
  }catch{
    throw new SoopOAuthError('SOOP 인증 서버에 연결하지 못했습니다.','soop_token_network_failed',502);
  }finally{if(timer)clearTimeout(timer)}
  const data=await response.json().catch(()=>({}));
  if(!response.ok||!data?.access_token){
    throw new SoopOAuthError('SOOP 토큰 발급에 실패했습니다.','soop_token_exchange_failed',502);
  }
  return {
    accessToken:String(data.access_token),
    refreshToken:data.refresh_token?String(data.refresh_token):'',
    expiresIn:positiveExpiresIn(data.expires_in)
  };
}

async function saveSoopConnection({workspaceId,userId,tokens,previousRefreshToken='',env=process.env,now=new Date(),sbImpl=sb,isRefresh=false}){
  const refreshToken=tokens.refreshToken||previousRefreshToken;
  if(!refreshToken)throw new SoopOAuthError('SOOP 갱신 토큰이 응답에 없습니다.','soop_refresh_token_missing',502);
  const timestamp=now.toISOString();
  const expiresAt=tokens.expiresIn?new Date(now.getTime()+tokens.expiresIn*1000).toISOString():null;
  const body={
    workspace_id:workspaceId,
    connected_by_user_id:userId,
    status:'connected',
    access_token_ciphertext:encryptSoopToken(tokens.accessToken,{env}),
    refresh_token_ciphertext:encryptSoopToken(refreshToken,{env}),
    access_token_expires_at:expiresAt,
    refreshed_at:timestamp,
    revoked_at:null,
    last_error_code:null,
    updated_at:timestamp
  };
  if(!isRefresh)body.connected_at=timestamp;
  const rows=await sbImpl('byeollog_soop_connections','?on_conflict=workspace_id',{
    method:'POST',
    body,
    prefer:'resolution=merge-duplicates,return=representation'
  });
  return Array.isArray(rows)?rows[0]||null:null;
}

export async function refreshSoopConnection(workspaceId,{env=process.env,fetchImpl=fetch,sbImpl=sb,now=new Date(),force=false}={}){
  const rows=await sbImpl('byeollog_soop_connections',`?select=*&workspace_id=eq.${encodeURIComponent(workspaceId)}&status=eq.connected&limit=1`);
  const row=Array.isArray(rows)?rows[0]:null;
  if(!row)throw new SoopOAuthError('연결된 SOOP 계정이 없습니다.','soop_connection_missing',404);
  const accessToken=decryptSoopToken(row.access_token_ciphertext,{env});
  const expiresAt=Date.parse(row.access_token_expires_at||'');
  if(!force&&Number.isFinite(expiresAt)&&expiresAt-now.getTime()>120_000){
    return {accessToken,expiresAt:new Date(expiresAt).toISOString(),refreshed:false};
  }
  const refreshToken=decryptSoopToken(row.refresh_token_ciphertext,{env});
  try{
    const tokens=await requestSoopTokens({grant_type:'refresh_token',refresh_token:refreshToken},{env,fetchImpl});
    const saved=await saveSoopConnection({
      workspaceId,userId:row.connected_by_user_id,tokens,previousRefreshToken:refreshToken,env,now,sbImpl,isRefresh:true
    });
    return {accessToken:tokens.accessToken,expiresAt:saved?.access_token_expires_at||null,refreshed:true};
  }catch(error){
    await sbImpl('byeollog_soop_connections',`?workspace_id=eq.${encodeURIComponent(workspaceId)}`,{
      method:'PATCH',body:{status:'reauthorization_required',last_error_code:error?.code||'soop_refresh_failed',updated_at:now.toISOString()}
    }).catch(()=>{});
    throw error;
  }
}

function callbackPage(kind='ready'){
  const copy={
    ready:{title:'SOOP 연동 콜백이 준비되었습니다',message:'이 주소는 SOOP 계정 연결 후 인증 결과를 받는 별록의 공식 콜백 URL입니다.'},
    received:{title:'SOOP 인증 응답을 확인했습니다',message:'개발자 연동 승인 후 실제 계정 연결 기능이 활성화됩니다.'},
    connected:{title:'SOOP 계정 연결이 완료되었습니다',message:'별록 룰렛 설정 화면으로 돌아가 연결 상태를 확인해주세요.'},
    denied:{title:'SOOP 계정 연결이 완료되지 않았습니다',message:'SOOP 인증 화면에서 계정 연결을 다시 진행해주세요.'},
    invalid:{title:'SOOP 인증 요청을 확인할 수 없습니다',message:'별록 대시보드에서 SOOP 연결을 처음부터 다시 시작해주세요.'},
    failed:{title:'SOOP 계정 연결 중 오류가 발생했습니다',message:'잠시 후 별록 대시보드에서 다시 시도해주세요.'}
  }[kind]||null;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>별록 | SOOP 인증 연결</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:#071a38;color:#f7f9ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(560px,100%);padding:34px;border:1px solid #29456d;border-radius:24px;background:#0b2144;box-shadow:0 20px 60px #0005}.eyebrow{margin:0 0 12px;color:#ffc44d;font-size:14px;font-weight:800;letter-spacing:.08em}.title{margin:0;font-size:clamp(26px,6vw,38px);line-height:1.2}.message{margin:18px 0 0;color:#c8d5eb;font-size:17px;line-height:1.7}.home{display:inline-block;margin-top:26px;color:#071a38;background:#ffc44d;padding:12px 18px;border-radius:12px;font-weight:800;text-decoration:none}</style></head><body><main class="card"><p class="eyebrow">BYEOLLOG × SOOP</p><h1 class="title">${copy.title}</h1><p class="message">${copy.message}</p><a class="home" href="/dashboard/roulette">룰렛 설정으로 돌아가기</a></main></body></html>`;
}

function setCallbackHeaders(res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('X-Robots-Tag','noindex, noarchive');
}

export async function handleSoopOAuthStart(req,res,{env=process.env,resolveSession=requireCapabilityLive}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  if(envText(env,'SOOP_OAUTH_ENABLED')!=='true')return res.status(503).json({message:'SOOP 계정 연결은 아직 활성화되지 않았습니다.',code:'soop_oauth_disabled'});
  if(String(req.headers?.['sec-fetch-site']||'').toLowerCase()==='cross-site')return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  let config;
  try{config=getSoopOAuthConfig(env)}catch(error){
    return res.status(error?.status||503).json({message:'SOOP 계정 연결 설정이 아직 완료되지 않았습니다.',code:error?.code||'soop_oauth_config_invalid'});
  }
  const session=await resolveSession(req,res,'roulette:configure');
  if(!session)return;
  const attempt=createSoopOAuthAttempt(session,{env});
  setAttemptCookie(res,attempt.token,attempt.expiresIn);
  const url=new URL(config.authorizationUrl);
  url.searchParams.set('client_id',config.clientId);
  url.searchParams.set('response_type','code');
  // Current SOOP SDK docs do not guarantee state echoing. The signed Lax cookie
  // remains authoritative; state is validated when SOOP returns it.
  url.searchParams.set('state',attempt.state);
  res.setHeader('Location',url.toString());
  return res.status(302).end();
}

export async function handleSoopOAuthCallback(req,res,{env=process.env,fetchImpl=fetch,sbImpl=sb,revalidateSession=revalidateMembership}={}){
  setCallbackHeaders(res);
  if(!['GET','HEAD'].includes(req.method)){
    res.setHeader('Allow','GET, HEAD');
    return res.status(405).send('Method not allowed');
  }
  const denied=Boolean(String(req.query?.error||'').trim());
  const authCode=String(req.query?.authCode||'').trim();
  const enabled=envText(env,'SOOP_OAUTH_ENABLED')==='true';
  if(!enabled){
    const status=denied?400:200;
    if(req.method==='HEAD')return res.status(status).end();
    return res.status(status).send(callbackPage(denied?'denied':authCode?'received':'ready'));
  }
  if(req.method==='HEAD')return res.status(200).end();
  if(denied){clearAttemptCookie(res);return res.status(400).send(callbackPage('denied'))}
  if(!authCode)return res.status(200).send(callbackPage('ready'));

  let attempt;
  try{attempt=verifySoopOAuthAttempt(cookiesOf(req)[ATTEMPT_COOKIE],{env})}catch{attempt=null}
  if(!attempt){clearAttemptCookie(res);return res.status(400).send(callbackPage('invalid'))}
  const returnedState=String(req.query?.state||'').trim();
  if(returnedState&&!safeEqual(returnedState,attempt.nonce)){
    clearAttemptCookie(res);
    return res.status(400).send(callbackPage('invalid'));
  }
  const session=await revalidateSession({mode:'beta',user_id:attempt.user_id,workspace_id:attempt.workspace_id,role:'viewer'});
  if(!session||session.user_id!==attempt.user_id||session.workspace_id!==attempt.workspace_id){
    clearAttemptCookie(res);
    clearSessionCookie(res);
    return res.status(401).send(callbackPage('invalid'));
  }
  try{
    const tokens=await requestSoopTokens({grant_type:'authorization_code',code:authCode},{env,fetchImpl});
    await saveSoopConnection({workspaceId:attempt.workspace_id,userId:attempt.user_id,tokens,env,sbImpl});
    clearAttemptCookie(res);
    return res.status(200).send(callbackPage('connected'));
  }catch{
    clearAttemptCookie(res);
    return res.status(502).send(callbackPage('failed'));
  }
}

export async function handleSoopOAuthStatus(req,res,{env=process.env,resolveSession=requireCapabilityLive,sbImpl=sb}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const session=await resolveSession(req,res,'roulette:read');
  if(!session)return;
  const readiness=getSoopOAuthReadiness(env);
  if(!readiness.enabled)return res.status(200).json({...readiness,connected:false});
  if(!readiness.configured)return res.status(503).json({...readiness,connected:false,status:'configuration_required'});
  const rows=await sbImpl('byeollog_soop_connections',`?select=status,connected_at,refreshed_at,access_token_expires_at,last_error_code&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&limit=1`);
  const row=Array.isArray(rows)?rows[0]:null;
  return res.status(200).json({
    ...readiness,
    connected:row?.status==='connected',
    status:row?.status||'not_connected',
    connectedAt:row?.connected_at||null,
    refreshedAt:row?.refreshed_at||null,
    expiresAt:row?.access_token_expires_at||null,
    errorCode:row?.last_error_code||null
  });
}

export {ATTEMPT_COOKIE,DEFAULT_REDIRECT_URI};
