import crypto from 'node:crypto';
import {clearSessionCookie,hasCapability,requireCapabilityLive,revalidateMembership,safeEqual} from './auth.js';
import {isJsonRequest,isTrustedMutationOrigin} from './request-origin.js';
import {sb} from './supabase-rest.js';
import {getGameLinkHandler} from './game-link-runtime.mjs';
import {hasGameLinkSessionCookie} from './game-link-service.mjs';

const SOOP_OPENAPI_ORIGIN='https://openapi.sooplive.com';
const SOOP_AUTHORIZATION_PATH='/auth/code';
const SOOP_TOKEN_PATH='/auth/token';
const DEFAULT_REDIRECT_URI='https://byeollog.com/api/auth/soop/callback';
const ATTEMPT_COOKIE='byeollog_soop_oauth_attempt';
const ATTEMPT_TTL_SECONDS=10*60;
const SIGNUP_COOKIE='byeollog_soop_signup_oauth';
const SIGNUP_TTL_SECONDS=20*60;
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
  const sessionEpoch=Number(session.session_epoch??0);
  if(!Number.isSafeInteger(sessionEpoch)||sessionEpoch<0){
    throw new SoopOAuthError('OAuth session version is invalid','soop_session_epoch_invalid',401);
  }
  const payload={
    v:1,
    exp:Math.floor(now/1000)+ATTEMPT_TTL_SECONDS,
    nonce:state,
    user_id:String(session.user_id),
    workspace_id:String(session.workspace_id),
    // Bind the attempt to the login that started it, not a later DB version.
    session_epoch:sessionEpoch
  };
  const encoded=Buffer.from(JSON.stringify(payload),'utf8').toString('base64url');
  return {state,token:`${encoded}.${signAttempt(encoded,env)}`,expiresIn:ATTEMPT_TTL_SECONDS};
}

export function createSoopSignupOAuthAttempt({env=process.env,now=Date.now(),nonce}={}){
  const state=nonce||crypto.randomBytes(32).toString('base64url');
  const payload={v:2,flow:'signup',exp:Math.floor(now/1000)+ATTEMPT_TTL_SECONDS,nonce:state};
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
    const accountAttempt=value?.v===1&&value.user_id&&value.workspace_id;
    const signupAttempt=value?.v===2&&value.flow==='signup'&&!value.user_id&&!value.workspace_id;
    if(!value?.nonce||(!accountAttempt&&!signupAttempt))return null;
    if(!Number.isSafeInteger(value.exp)||value.exp<Math.floor(now/1000))return null;
    if(accountAttempt&&Object.hasOwn(value,'session_epoch')&&(!Number.isSafeInteger(value.session_epoch)||value.session_epoch<0))return null;
    // Pre-patch attempts are valid only for accounts still at epoch zero.
    return accountAttempt?{...value,flow:'account',session_epoch:value.session_epoch??0}:value;
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
  // Keep the signed attempt available only inside the SOOP auth route family
  // so that the callback can verify the authorization it belongs to.
  appendSetCookie(res,`${ATTEMPT_COOKIE}=${encodeURIComponent(token)}; Path=/api/auth/soop; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearAttemptCookie(res){
  setAttemptCookie(res,'',0);
}

function setSignupCookie(res,token,maxAge=SIGNUP_TTL_SECONDS){
  appendSetCookie(res,`${SIGNUP_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

export function clearSoopSignupCookie(res){setSignupCookie(res,'',0)}

function pendingTokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}

export async function findRegisteredSoopWorkspace(userId,{sbImpl=sb}={}){
  const normalized=String(userId||'').trim().toLowerCase();
  if(!/^[a-z0-9_.-]{2,80}$/.test(normalized))return null;
  // The database enforces uniqueness on lower(soop_id). Match with the same
  // case-insensitive semantics so a pre-normalization legacy row cannot pass
  // the OAuth duplicate-account gate.
  const rows=await sbImpl('byeollog_workspaces',`?select=id&soop_id=ilike.${encodeURIComponent(normalized)}&limit=1`);
  const row=Array.isArray(rows)?rows[0]:null;
  return row?.id?{id:String(row.id)}:null;
}

export async function getWorkspaceSoopIdentity(workspaceId,{sbImpl=sb}={}){
  const normalizedWorkspaceId=String(workspaceId||'').trim();
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalizedWorkspaceId)){
    throw new SoopOAuthError('별록 작업공간을 확인할 수 없습니다.','soop_workspace_identity_missing',409);
  }
  const rows=await sbImpl('byeollog_workspaces',`?select=soop_id&id=eq.${encodeURIComponent(normalizedWorkspaceId)}&status=eq.active&limit=1`);
  const identity=String(Array.isArray(rows)?rows[0]?.soop_id||'':'').trim().toLowerCase();
  if(!/^[a-z0-9_.-]{2,80}$/.test(identity)){
    throw new SoopOAuthError('가입 시 확인한 SOOP 계정 정보를 찾을 수 없습니다.','soop_workspace_identity_missing',409);
  }
  return identity;
}

function oauthAttemptId(attempt){
  return attempt?.nonce?crypto.createHash('sha256').update(String(attempt.nonce)).digest('hex').slice(0,12):null;
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
    const data=await response.json().catch(error=>{
      if((signal||controller.signal).aborted)throw error;
      return {};
    });
    if(!response.ok||!data?.access_token){
      const error=new SoopOAuthError('SOOP 토큰 발급에 실패했습니다.','soop_token_exchange_failed',502);
      error.upstreamStatus=response.status;
      throw error;
    }
    return {
      accessToken:String(data.access_token),
      refreshToken:data.refresh_token?String(data.refresh_token):'',
      expiresIn:positiveExpiresIn(data.expires_in)
    };
  }catch(error){
    if(error instanceof SoopOAuthError)throw error;
    throw new SoopOAuthError('SOOP 인증 서버에 연결하지 못했습니다.','soop_token_network_failed',502);
  }finally{if(timer)clearTimeout(timer)}
}

export async function requestSoopAccountIdentity(accessToken,{fetchImpl=fetch,signal}={}){
  const controller=signal?null:new AbortController();
  const timer=controller?setTimeout(()=>controller.abort(),10_000):null;
  try{
    const response=await fetchImpl(`${SOOP_OPENAPI_ORIGIN}/validate/live/status`,{
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded;charset=utf-8'},
      body:new URLSearchParams({access_token:String(accessToken)}).toString(),
      cache:'no-store',signal:signal||controller.signal
    });
    const payload=await response.json().catch(()=>({}));
    const officialUserId=String(payload?.data?.user_id||'').trim().toLowerCase();
    const misnamedUserId=String(payload?.data?.broad_no||'').trim().toLowerCase();
    const userId=officialUserId||(!/^\d+$/.test(misnamedUserId)?misnamedUserId:'');
    if(!response.ok||!/^[a-z0-9_.-]{2,80}$/.test(userId)){
      const error=new SoopOAuthError('SOOP 계정 정보를 확인하지 못했습니다.','soop_identity_verification_failed',502);
      error.upstreamStatus=response.status;
      throw error;
    }
    return {userId};
  }catch(error){
    if(error instanceof SoopOAuthError)throw error;
    throw new SoopOAuthError('SOOP 계정 확인 서버에 연결하지 못했습니다.','soop_identity_network_failed',502);
  }finally{if(timer)clearTimeout(timer)}
}

function refreshPredicate(workspaceId,row){
  // Encrypted tokens get fresh random IVs on every write, so this also fences
  // a reconnect with the same plaintext token. Never upsert a refresh result.
  return `?workspace_id=eq.${encodeURIComponent(workspaceId)}&status=eq.connected`
    +`&refresh_token_ciphertext=eq.${encodeURIComponent(row.refresh_token_ciphertext)}`
    +`&access_token_ciphertext=eq.${encodeURIComponent(row.access_token_ciphertext)}`;
}

async function saveSoopConnection({workspaceId,userId,tokens,previousRefreshToken='',env=process.env,now=new Date(),sbImpl=sb,refreshRow=null}){
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
  if(!refreshRow)body.connected_at=timestamp;
  const rows=await sbImpl('byeollog_soop_connections',refreshRow?refreshPredicate(workspaceId,refreshRow):'?on_conflict=workspace_id',{
    method:refreshRow?'PATCH':'POST',
    body,
    prefer:refreshRow?'return=representation':'resolution=merge-duplicates,return=representation'
  });
  return Array.isArray(rows)?rows[0]||null:null;
}

export async function refreshSoopConnection(workspaceId,{env=process.env,fetchImpl=fetch,sbImpl=sb,now=new Date(),force=false,signal}={}){
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
    const tokens=await requestSoopTokens({grant_type:'refresh_token',refresh_token:refreshToken},{env,fetchImpl,signal});
    const saved=await saveSoopConnection({
      workspaceId,userId:row.connected_by_user_id,tokens,previousRefreshToken:refreshToken,env,now,sbImpl,refreshRow:row
    });
    if(!saved){
      const latest=await latestConcurrentConnection(workspaceId,row,{env,sbImpl});
      if(latest)return latest;
      throw new SoopOAuthError('SOOP 연결 상태가 변경되었습니다.','soop_connection_changed',409);
    }
    return {accessToken:tokens.accessToken,expiresAt:saved?.access_token_expires_at||null,refreshed:true};
  }catch(error){
    const upstreamStatus=Number(error?.upstreamStatus||0);
    const reauthorizationRequired=error?.code==='soop_token_exchange_failed'&&[400,401,403].includes(upstreamStatus);
    const changed=await sbImpl('byeollog_soop_connections',refreshPredicate(workspaceId,row),{
      method:'PATCH',body:{
        ...(reauthorizationRequired?{status:'reauthorization_required'}:{}),
        last_error_code:error?.code||'soop_refresh_failed',updated_at:now.toISOString()
      }
    }).catch(()=>null);
    if(Array.isArray(changed)&&changed.length===0){
      const latest=await latestConcurrentConnection(workspaceId,row,{env,sbImpl}).catch(()=>null);
      if(latest)return latest;
    }
    throw error;
  }
}

async function latestConcurrentConnection(workspaceId,previous,{env,sbImpl}){
  const rows=await sbImpl('byeollog_soop_connections',`?select=*&workspace_id=eq.${encodeURIComponent(workspaceId)}&status=eq.connected&limit=1`);
  const row=Array.isArray(rows)?rows[0]:null;
  if(!row||row.access_token_ciphertext===previous.access_token_ciphertext)return null;
  const expiresAt=Date.parse(row.access_token_expires_at||'');
  if(Number.isFinite(expiresAt)&&expiresAt<=Date.now())return null;
  return {accessToken:decryptSoopToken(row.access_token_ciphertext,{env}),expiresAt:row.access_token_expires_at||null,refreshed:false};
}

function soopTokenStatus(expiresAt,{now=Date.now()}={}){
  const instant=Date.parse(expiresAt||'');
  if(!Number.isFinite(instant))return 'unknown';
  const remaining=instant-now;
  if(remaining<=0)return 'expired';
  if(remaining<=120_000)return 'refresh_required';
  return 'valid';
}

function callbackPage(kind='ready'){
  const copy={
    ready:{title:'SOOP 연동 콜백이 준비되었습니다',message:'이 주소는 SOOP 계정 연결 후 인증 결과를 받는 별록의 공식 콜백 URL입니다.'},
    received:{title:'SOOP 인증 응답을 확인했습니다',message:'개발자 연동 승인 후 실제 계정 연결 기능이 활성화됩니다.'},
    connected:{title:'SOOP 계정 연결이 완료되었습니다',message:'이제 SOOP 후원은 풍벽지와 업보에 자동으로 반영됩니다.'},
    denied:{title:'SOOP 계정 연결이 완료되지 않았습니다',message:'SOOP 인증 화면에서 계정 연결을 다시 진행해주세요.'},
    invalid:{title:'SOOP 인증 요청을 확인할 수 없습니다',message:'별록 대시보드에서 SOOP 연결을 처음부터 다시 시작해주세요.'},
    temporary:{title:'로그인 상태 확인이 잠시 지연되고 있습니다',message:'별록 로그인은 유지되어 있습니다. 잠시 후 대시보드에서 SOOP 계정 연결을 다시 눌러주세요.'},
    failed:{title:'SOOP 계정 연결 중 오류가 발생했습니다',message:'잠시 후 별록 대시보드에서 다시 시도해주세요.'},
    identityMismatch:{title:'다른 SOOP 계정은 연결할 수 없습니다',message:'이 별록 계정에 가입할 때 확인한 SOOP 계정으로 다시 로그인해주세요.'}
  }[kind]||null;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>별록 | SOOP 인증 연결</title><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 24px 76px;background:#071a38;color:#f7f9ff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}.card{width:min(560px,100%);padding:34px;border:1px solid #29456d;border-radius:24px;background:#0b2144;box-shadow:0 20px 60px #0005}.eyebrow{margin:0 0 12px;color:#ffc44d;font-size:14px;font-weight:800;letter-spacing:.08em}.title{margin:0;font-size:clamp(26px,6vw,38px);line-height:1.2}.message{margin:18px 0 0;color:#c8d5eb;font-size:17px;line-height:1.7}.home{display:inline-block;margin-top:26px;color:#071a38;background:#ffc44d;padding:12px 18px;border-radius:12px;font-weight:800;text-decoration:none}.byeollogSiteFooter{position:fixed;left:0;bottom:0;width:100%;padding:22px 16px;border-top:1px solid #29456d;color:#7890ae;font-size:12px;font-weight:700;letter-spacing:.02em;text-align:center}</style></head><body><main class="card"><p class="eyebrow">BYEOLLOG × SOOP</p><h1 class="title">${copy.title}</h1><p class="message">${copy.message}</p><a class="home" href="/dashboard/signatures">별록으로 돌아가기</a></main><footer class="byeollogSiteFooter">© 2026 BYEOLLOG</footer></body></html>`;
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
  const session=await resolveSession(req,res,'data:write',{
    navigation:true,
    loginPath:'/login?expired=1',
    retryPath:'/dashboard?soop=retry'
  });
  if(!session)return;
  const attempt=createSoopOAuthAttempt(session,{env});
  setAttemptCookie(res,attempt.token,attempt.expiresIn);
  const url=new URL(config.authorizationUrl);
  url.searchParams.set('client_id',config.clientId);
  url.searchParams.set('response_type','code');
  // Current SOOP SDK docs do not guarantee state echoing. The signed Lax cookie
  // remains authoritative; state is validated when SOOP returns it.
  url.searchParams.set('state',attempt.state);
  console.info('[soop-oauth] authorization redirect issued',{
    attempt_id:oauthAttemptId({nonce:attempt.state}),
    mode:session.mode||'beta'
  });
  res.setHeader('Location',url.toString());
  return res.status(302).end();
}

export async function handleSoopSignupOAuthStart(req,res,{env=process.env}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  if(envText(env,'SOOP_OAUTH_ENABLED')!=='true')return res.status(503).json({message:'SOOP 계정 연결은 아직 활성화되지 않았습니다.',code:'soop_oauth_disabled'});
  const fetchSite=String(req.headers?.['sec-fetch-site']||'').toLowerCase();
  let config;
  try{config=getSoopOAuthConfig(env)}catch(error){
    return res.status(error?.status||503).json({message:'SOOP 계정 연결 설정이 아직 완료되지 않았습니다.',code:error?.code||'soop_oauth_config_invalid'});
  }
  if(fetchSite==='cross-site')return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  const switchStep=String(req.query?.switch||'').trim().toLowerCase();
  if(switchStep)return res.status(403).json({message:'SOOP 계정 전환은 허용되지 않습니다.',code:'soop_account_switch_disabled'});
  const attempt=createSoopSignupOAuthAttempt({env});
  setAttemptCookie(res,attempt.token,attempt.expiresIn);
  const authorizationState=attempt.state;
  const url=new URL(config.authorizationUrl);
  url.searchParams.set('client_id',config.clientId);
  url.searchParams.set('response_type','code');
  url.searchParams.set('state',authorizationState);
  console.info('[soop-oauth] signup authorization redirect issued',{attempt_id:oauthAttemptId({nonce:authorizationState})});
  res.setHeader('Location',url.toString());
  return res.status(302).end();
}

async function storePendingSoopSignup({tokens,userId,env=process.env,sbImpl=sb,now=new Date()}){
  const refreshToken=String(tokens.refreshToken||'');
  if(!refreshToken)throw new SoopOAuthError('SOOP 갱신 토큰이 응답에 없습니다.','soop_refresh_token_missing',502);
  const token=crypto.randomBytes(32).toString('base64url');
  const expiresAt=new Date(now.getTime()+SIGNUP_TTL_SECONDS*1000).toISOString();
  const accessTokenExpiresAt=tokens.expiresIn?new Date(now.getTime()+tokens.expiresIn*1000).toISOString():null;
  await sbImpl('byeollog_soop_signup_oauth_pending',`?expires_at=lt.${encodeURIComponent(now.toISOString())}`,{method:'DELETE'}).catch(()=>{});
  await sbImpl('byeollog_soop_signup_oauth_pending','',{
    method:'POST',prefer:'return=minimal',body:{
      token_hash:pendingTokenHash(token),provider_user_id:userId,
      access_token_ciphertext:encryptSoopToken(tokens.accessToken,{env}),
      refresh_token_ciphertext:encryptSoopToken(refreshToken,{env}),
      access_token_expires_at:accessTokenExpiresAt,expires_at:expiresAt
    }
  });
  return {token,expiresAt};
}

export async function getPendingSoopSignup(req,{sbImpl=sb,now=new Date()}={}){
  const token=String(cookiesOf(req)[SIGNUP_COOKIE]||'');
  if(!/^[A-Za-z0-9_-]{43}$/.test(token))return null;
  const rows=await sbImpl('byeollog_soop_signup_oauth_pending',
    `?select=token_hash,provider_user_id,expires_at&token_hash=eq.${encodeURIComponent(pendingTokenHash(token))}&consumed_at=is.null&expires_at=gt.${encodeURIComponent(now.toISOString())}&limit=1`);
  const row=Array.isArray(rows)?rows[0]:null;
  if(!row||!/^[a-z0-9_.-]{2,80}$/.test(String(row.provider_user_id||'')))return null;
  return {tokenHash:String(row.token_hash),userId:String(row.provider_user_id).toLowerCase(),expiresAt:row.expires_at};
}

export async function handleSoopSignupOAuthStatus(req,res,{sbImpl=sb,now=new Date()}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  try{
    const pending=await getPendingSoopSignup(req,{sbImpl,now});
    if(!pending){clearSoopSignupCookie(res);return res.status(200).json({connected:false})}
    const registered=await findRegisteredSoopWorkspace(pending.userId,{sbImpl});
    if(registered){
      clearSoopSignupCookie(res);
      return res.status(200).json({connected:false,registered:true,code:'soop_account_already_registered'});
    }
    return res.status(200).json({connected:true,soopId:pending.userId,expiresAt:pending.expiresAt});
  }catch(error){
    console.error('[soop-oauth] signup status lookup failed',{code:error?.code||'soop_signup_status_failed'});
    return res.status(503).json({message:'SOOP 계정 연결 상태를 확인하지 못했습니다.',code:'soop_signup_status_failed'});
  }
}

export async function handleSoopOAuthCallback(req,res,{
  env=process.env,fetchImpl=fetch,sbImpl=sb,revalidateSession=revalidateMembership,gameLinkHandler,
  resolveAccountIdentity=requestSoopAccountIdentity,resolveWorkspaceIdentity=getWorkspaceSoopIdentity
}={}){
  setCallbackHeaders(res);
  if(!['GET','HEAD'].includes(req.method)){
    res.setHeader('Allow','GET, HEAD');
    return res.status(405).send('Method not allowed');
  }
  if(req.method==='GET'&&hasGameLinkSessionCookie(req)){
    req.query={...(req.query||{}),operation:'soop-callback'};
    return (gameLinkHandler||getGameLinkHandler(env))(req,res);
  }
  const denied=Boolean(String(req.query?.error||'').trim());
  const documentedAuthCode=String(req.query?.authCode||'').trim();
  const exampleCode=String(req.query?.code||'').trim();
  if(documentedAuthCode&&exampleCode&&!safeEqual(documentedAuthCode,exampleCode)){
    clearAttemptCookie(res);
    return res.status(400).send(callbackPage('invalid'));
  }
  const authCode=documentedAuthCode||exampleCode;
  const codeParameter=documentedAuthCode?'authCode':exampleCode?'code':'none';
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
  console.info('[soop-oauth] callback received',{
    attempt_id:oauthAttemptId(attempt),
    attempt_valid:Boolean(attempt),
    code_parameter:codeParameter,
    state_present:Boolean(String(req.query?.state||'').trim()),
    denied
  });
  if(!attempt){clearAttemptCookie(res);return res.status(400).send(callbackPage('invalid'))}
  const returnedState=String(req.query?.state||'').trim();
  if(returnedState&&!safeEqual(returnedState,attempt.nonce)){
    clearAttemptCookie(res);
    return res.status(400).send(callbackPage('invalid'));
  }
  if(attempt.flow==='signup'){
    try{
      const tokens=await requestSoopTokens({grant_type:'authorization_code',code:authCode},{env,fetchImpl});
      const identity=await requestSoopAccountIdentity(tokens.accessToken,{fetchImpl});
      const registered=await findRegisteredSoopWorkspace(identity.userId,{sbImpl});
      if(registered){
        clearAttemptCookie(res);
        clearSoopSignupCookie(res);
        console.info('[soop-oauth] registered signup identity rejected',{attempt_id:oauthAttemptId(attempt)});
        res.setHeader('Location','/signup?soop=already-registered');
        return res.status(303).end();
      }
      const pending=await storePendingSoopSignup({tokens,userId:identity.userId,env,sbImpl});
      clearAttemptCookie(res);
      setSignupCookie(res,pending.token,SIGNUP_TTL_SECONDS);
      console.info('[soop-oauth] verified signup identity stored',{attempt_id:oauthAttemptId(attempt)});
      res.setHeader('Location','/signup?soop=connected');
      return res.status(303).end();
    }catch(error){
      console.error('[soop-oauth] signup identity verification failed',{
        attempt_id:oauthAttemptId(attempt),code:error?.code||'soop_signup_verification_failed',upstream_status:error?.upstreamStatus||null
      });
      clearAttemptCookie(res);
      clearSoopSignupCookie(res);
      return res.status(error?.status||502).send(callbackPage('failed'));
    }
  }
  let session;
  try{session=await revalidateSession({mode:'beta',user_id:attempt.user_id,workspace_id:attempt.workspace_id,session_epoch:attempt.session_epoch,role:'viewer'})}
  catch(error){
    console.error('[soop-oauth] callback membership revalidation unavailable',{
      code:error?.code||'session_revalidation_unavailable',
      upstream_status:error?.cause?.status||null
    });
    clearAttemptCookie(res);
    return res.status(503).send(callbackPage('temporary'));
  }
  if(!session||session.user_id!==attempt.user_id||session.workspace_id!==attempt.workspace_id){
    console.warn('[soop-oauth] callback session rejected',{attempt_id:oauthAttemptId(attempt),reason:'membership_or_session_invalid'});
    clearAttemptCookie(res);
    clearSessionCookie(res);
    return res.status(401).send(callbackPage('invalid'));
  }
  if(!hasCapability(session,'data:write')){
    clearAttemptCookie(res);
    return res.status(403).send(callbackPage('denied'));
  }
  let tokens;
  try{
    tokens=await requestSoopTokens({grant_type:'authorization_code',code:authCode},{env,fetchImpl});
  }catch(error){
    console.error('[soop-oauth] token exchange failed',{
      attempt_id:oauthAttemptId(attempt),
      code:error?.code||'soop_token_exchange_failed',
      upstream_status:error?.upstreamStatus||null
    });
    clearAttemptCookie(res);
    return res.status(502).send(callbackPage('failed'));
  }
  try{
    const [providerIdentity,workspaceIdentity]=await Promise.all([
      resolveAccountIdentity(tokens.accessToken,{fetchImpl}),
      resolveWorkspaceIdentity(attempt.workspace_id,{sbImpl})
    ]);
    if(providerIdentity?.userId!==workspaceIdentity){
      console.warn('[soop-oauth] workspace identity mismatch rejected',{attempt_id:oauthAttemptId(attempt)});
      clearAttemptCookie(res);
      return res.status(409).send(callbackPage('identityMismatch'));
    }
  }catch(error){
    console.error('[soop-oauth] workspace identity verification failed',{
      attempt_id:oauthAttemptId(attempt),code:error?.code||'soop_workspace_identity_verification_failed',
      upstream_status:error?.upstreamStatus||error?.status||null
    });
    clearAttemptCookie(res);
    if(error?.code==='soop_workspace_identity_missing')return res.status(409).send(callbackPage('identityMismatch'));
    return res.status(502).send(callbackPage('failed'));
  }
  try{
    await saveSoopConnection({workspaceId:attempt.workspace_id,userId:attempt.user_id,tokens,env,sbImpl});
    await sbImpl('byeollog_soop_runtime_controls','?on_conflict=workspace_id',{
      method:'POST',prefer:'resolution=merge-duplicates,return=minimal',body:{
        workspace_id:attempt.workspace_id,gateway_enabled:true,core_collection_enabled:true,
        native_roulette_enabled:false,overlay_experiment_enabled:false,
        overlay_experiment_draft_id:null,overlay_experiment_expires_at:null,
        updated_by_user_id:attempt.user_id,updated_at:new Date().toISOString()
      }
    });
    console.info('[soop-oauth] connection stored',{
      attempt_id:oauthAttemptId(attempt),
      expires_in:tokens.expiresIn||null,
      refresh_token_present:Boolean(tokens.refreshToken)
    });
    clearAttemptCookie(res);
    return res.status(200).send(callbackPage('connected'));
  }catch(error){
    console.error('[soop-oauth] connection storage failed',{
      attempt_id:oauthAttemptId(attempt),
      code:error?.code||'soop_connection_storage_failed',
      upstream_status:error?.status||null
    });
    clearAttemptCookie(res);
    return res.status(502).send(callbackPage('failed'));
  }
}

export async function handleSoopOAuthStatus(req,res,{env=process.env,resolveSession=requireCapabilityLive,sbImpl=sb}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const session=await resolveSession(req,res,'data:read');
  if(!session)return;
  const readiness=getSoopOAuthReadiness(env);
  if(!readiness.enabled)return res.status(200).json({...readiness,connected:false});
  if(!readiness.configured)return res.status(503).json({...readiness,connected:false,status:'configuration_required'});
  let rows;
  try{rows=await sbImpl('byeollog_soop_connections',`?select=status,connected_at,refreshed_at,access_token_expires_at,last_error_code&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&limit=1`)}
  catch(error){
    console.error('[soop-oauth] connection status lookup failed',{upstream_status:error?.status||null});
    return res.status(502).json({message:'SOOP 연결 상태를 잠시 확인하지 못했습니다.',code:'soop_status_lookup_failed',retryable:true});
  }
  const row=Array.isArray(rows)?rows[0]:null;
  const connected=row?.status==='connected';
  return res.status(200).json({
    ...readiness,
    connected,
    status:row?.status||'not_connected',
    connectedAt:row?.connected_at||null,
    refreshedAt:row?.refreshed_at||null,
    expiresAt:row?.access_token_expires_at||null,
    errorCode:row?.last_error_code||null,
    tokenStatus:connected?soopTokenStatus(row?.access_token_expires_at):'not_connected',
    chatStatus:connected?'waiting_for_live_verification':'not_ready',
    liveVerificationRequired:connected
  });
}

export async function handleSoopOAuthDiagnose(req,res,{
  env=process.env,resolveSession=requireCapabilityLive,refreshConnection=refreshSoopConnection
}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const readiness=getSoopOAuthReadiness(env);
  if(!readiness.enabled||!readiness.configured){
    return res.status(503).json({...readiness,connected:false,status:'configuration_required'});
  }
  const session=await resolveSession(req,res,'data:write');
  if(!session)return;
  const checkedAt=new Date().toISOString();
  try{
    const result=await refreshConnection(session.workspace_id,{env});
    console.info('[soop-oauth] connection self-check completed',{
      refreshed:result?.refreshed===true,
      expires_at_present:Boolean(result?.expiresAt)
    });
    return res.status(200).json({
      ok:true,connected:true,status:'connected',
      tokenStatus:result?.refreshed?'refreshed':'valid',
      refreshed:result?.refreshed===true,
      expiresAt:result?.expiresAt||null,
      chatStatus:'waiting_for_live_verification',
      liveVerificationRequired:true,
      checkedAt
    });
  }catch(error){
    const missing=error?.code==='soop_connection_missing';
    const reauthorization=error?.code==='soop_token_exchange_failed'&&[400,401,403].includes(Number(error?.upstreamStatus||0));
    console.error('[soop-oauth] connection self-check failed',{
      code:error?.code||'soop_diagnose_failed',
      upstream_status:error?.upstreamStatus||null,
      retryable:!missing&&!reauthorization
    });
    if(missing)return res.status(404).json({ok:false,connected:false,status:'not_connected',tokenStatus:'not_connected',chatStatus:'not_ready'});
    if(reauthorization)return res.status(409).json({ok:false,connected:false,status:'reauthorization_required',tokenStatus:'reauthorization_required',chatStatus:'not_ready',message:'SOOP 계정을 다시 연결해주세요.'});
    return res.status(503).json({
      ok:false,connected:true,status:'temporarily_unavailable',tokenStatus:'check_failed',
      chatStatus:'waiting_for_live_verification',liveVerificationRequired:true,retryable:true,
      message:'SOOP 인증 서버 상태를 잠시 확인하지 못했습니다. 기존 연결은 유지됩니다.'
    });
  }
}

export async function handleSoopOAuthDisconnect(req,res,{resolveSession=requireCapabilityLive,sbImpl=sb}={}){
  res.setHeader('Cache-Control','no-store, private');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  const session=await resolveSession(req,res,'data:write');
  if(!session)return;
  await sbImpl('byeollog_soop_connections',`?workspace_id=eq.${encodeURIComponent(session.workspace_id)}`,{method:'DELETE'});
  await sbImpl('byeollog_soop_runtime_controls',`?workspace_id=eq.${encodeURIComponent(session.workspace_id)}`,{
    method:'PATCH',body:{gateway_enabled:false,core_collection_enabled:false,native_roulette_enabled:false,
      overlay_experiment_enabled:false,overlay_experiment_draft_id:null,overlay_experiment_expires_at:null,
      updated_by_user_id:session.user_id,updated_at:new Date().toISOString()}
  });
  return res.status(200).json({ok:true,connected:false,status:'not_connected'});
}

export {ATTEMPT_COOKIE,SIGNUP_COOKIE,DEFAULT_REDIRECT_URI};
