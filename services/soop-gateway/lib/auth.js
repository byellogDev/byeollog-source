import crypto from 'node:crypto';
import {sb} from './supabase-rest.js';

const COOKIE_NAME = 'bangsel_admin_session';
const MAX_AGE = 60 * 60 * 12; // 12시간

const ROLE_RANK = {
  viewer: 10,
  editor: 20,
  owner: 30,
};

const CAPABILITIES = {
  'data:read': 'viewer',
  'data:write': 'editor',
  'data:delete': 'owner',
  'collector:process': 'editor',
  'roulette:void': 'editor',
  'roulette:read': 'viewer',
  'roulette:configure': 'editor',
  'backup:list': 'editor',
  'backup:create': 'owner',
  'backup:restore': 'owner',
  'device:list': 'editor',
  'device:manage': 'owner',
  'signup:review': 'owner',
};

function secret(){
  const s = process.env.SESSION_SECRET || '';
  if(s.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  return s;
}
function b64url(value){return Buffer.from(value).toString('base64url')}
function unb64url(value){return Buffer.from(value,'base64url').toString('utf8')}
function hmac(value){return crypto.createHmac('sha256', secret()).update(value).digest('hex')}
function normalizeSessionEpoch(value){
  const epoch=Number(value);
  return Number.isSafeInteger(epoch)&&epoch>=0?epoch:0;
}
function sessionEpochMatches(session,membership){
  return normalizeSessionEpoch(session?.session_epoch)===normalizeSessionEpoch(membership?.web_session_epoch);
}

export function safeEqual(a,b){
  const ah=crypto.createHash('sha256').update(String(a)).digest();
  const bh=crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ah,bh);
}

export function createSessionToken(ctx={}){
  const payload={
    exp:Math.floor(Date.now()/1000)+MAX_AGE,
    mode:ctx.mode||'beta',
    user_id:ctx.user_id||null,
    workspace_id:ctx.workspace_id||null,
    workspace_slug:ctx.workspace_slug||null,
    role:normalizeRole(ctx.role),
    email:ctx.email||null,
    collector_device_id:ctx.collector_device_id||null,
    session_epoch:normalizeSessionEpoch(ctx.session_epoch),
  };
  const encoded=b64url(JSON.stringify(payload));
  return encoded+'.'+hmac(encoded);
}

export function verifySessionToken(token){
  if(!token || !token.includes('.')) return null;
  const [payload,sig]=token.split('.',2);
  const expected=hmac(payload);
  const a=Buffer.from(sig),b=Buffer.from(expected);
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  try{
    const parsed=JSON.parse(unb64url(payload));
    if(!parsed?.exp || Number(parsed.exp)<Math.floor(Date.now()/1000))return null;
    parsed.role = normalizeRole(parsed.role);
    parsed.session_epoch = normalizeSessionEpoch(parsed.session_epoch);
    return parsed;
  }catch{return null}
}

export function getSession(req){
  const raw=req.headers.cookie||'';
  const cookies=Object.fromEntries(raw.split(';').map(v=>v.trim()).filter(Boolean).map(v=>{
    const i=v.indexOf('=');
    return [decodeURIComponent(i<0?v:v.slice(0,i)),decodeURIComponent(i<0?'':v.slice(i+1))];
  }));
  return verifySessionToken(cookies[COOKIE_NAME]);
}

export function setSessionCookie(res,token){
  res.setHeader('Set-Cookie',`${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${MAX_AGE}`);
}
export function clearSessionCookie(res){
  res.setHeader('Set-Cookie',`${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
}

export function isPlatformAdmin(session){
  if(!session)return false;
  if(session.mode!=='beta')return false;
  const allowed=String(process.env.PLATFORM_ADMIN_EMAILS||'')
    .split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
  return !!session.email&&allowed.includes(String(session.email).toLowerCase());
}

export function requireSession(req,res){
  const session=getSession(req);
  if(session)return session;
  res.status(401).json({message:'Unauthorized'});
  return null;
}

export function normalizeRole(role){
  const r = String(role||'').toLowerCase().trim();
  if(r === 'manager' || r === 'editor') return 'editor';
  if(r === 'owner' || r === 'viewer') return r;
  if(!r) return 'viewer';
  return 'viewer';
}

export function roleRank(role){
  return ROLE_RANK[normalizeRole(role)] || 0;
}

export function hasMinRole(session, minRole){
  if(!session) return false;
  if(isPlatformAdmin(session)) return true;
  return roleRank(session.role) >= roleRank(minRole);
}

export function hasCapability(session, capability){
  const minRole = CAPABILITIES[capability];
  if(!minRole) return false;
  return hasMinRole(session, minRole);
}

export function requireRole(req, res, minRole){
  const session = requireSession(req, res);
  if(!session) return null;
  if(hasMinRole(session, minRole)) return session;
  res.status(403).json({
    message: '권한이 부족합니다.',
    required_role: normalizeRole(minRole),
    current_role: normalizeRole(session.role),
  });
  return null;
}

export function requireCapability(req, res, capability){
  const session = requireSession(req, res);
  if(!session) return null;
  if(hasCapability(session, capability)) return session;
  res.status(403).json({
    message: '권한이 부족합니다.',
    required_capability: capability,
    current_role: normalizeRole(session.role),
  });
  return null;
}

export class MembershipRevalidationUnavailableError extends Error{
  constructor(cause){
    super('Membership revalidation is temporarily unavailable',{cause});
    this.name='MembershipRevalidationUnavailableError';
    this.code='session_revalidation_unavailable';
    this.status=503;
  }
}

function isRetryableMembershipError(error){
  const status=Number(error?.status||0);
  return !status||status===408||status===429||status>=500;
}

async function membershipQuery(sbImpl,table,path,retryDelayMs){
  let lastError;
  for(let attempt=0;attempt<2;attempt++){
    try{return await sbImpl(table,path)}
    catch(error){
      lastError=error;
      if(attempt===1||!isRetryableMembershipError(error))break;
      if(retryDelayMs>0)await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
    }
  }
  throw new MembershipRevalidationUnavailableError(lastError);
}

/** H-05: 쿠키 세션의 멤버십/기기 상태를 DB에서 재확인 */
export async function revalidateMembership(session,{sbImpl=sb,retryDelayMs=40}={}){
  if(!session) return null;
  if(session.mode==='collector_handoff'){
    if(!session.collector_device_id || !session.workspace_id) return null;
    const rows=await membershipQuery(
      sbImpl,'byeollog_collector_devices',
      `?select=id,workspace_id,status,created_by_user_id&id=eq.${encodeURIComponent(session.collector_device_id)}`+
      `&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&status=eq.active&limit=1`,retryDelayMs
    );
    const device=Array.isArray(rows)?rows[0]:null;
    if(!device || device.workspace_id!==session.workspace_id || !device.created_by_user_id) return null;
    const memberships=await membershipQuery(
      sbImpl,'byeollog_workspace_members',
      `?select=role,workspace_id,web_session_epoch&user_id=eq.${encodeURIComponent(device.created_by_user_id)}`+
      `&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&limit=1`,retryDelayMs
    );
    const membership=Array.isArray(memberships)?memberships[0]:null;
    if(!membership || membership.workspace_id!==session.workspace_id || !sessionEpochMatches(session,membership)) return null;
    const workspaces=await membershipQuery(
      sbImpl,'byeollog_workspaces',
      `?select=id,status&id=eq.${encodeURIComponent(session.workspace_id)}&status=eq.active&limit=1`,retryDelayMs
    );
    if(!Array.isArray(workspaces)||workspaces[0]?.id!==session.workspace_id) return null;
    return {
      ...session,
      user_id:device.created_by_user_id,
      role:normalizeRole(membership.role),
    };
  }

  if(!session.user_id || !session.workspace_id) return null;
  const rows=await membershipQuery(
    sbImpl,'byeollog_workspace_members',
    `?select=role,workspace_id,web_session_epoch&user_id=eq.${encodeURIComponent(session.user_id)}&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&limit=1`,retryDelayMs
  );
  const m=Array.isArray(rows)?rows[0]:null;
  if(!m || !sessionEpochMatches(session,m)) return null;
  const ws=await membershipQuery(
    sbImpl,'byeollog_workspaces',
    `?select=id,status&id=eq.${encodeURIComponent(session.workspace_id)}&status=eq.active&limit=1`,retryDelayMs
  );
  if(!Array.isArray(ws)||!ws[0]) return null;
  return {...session, role:normalizeRole(m.role)};
}

/** H-05: capability + 멤버십 재검증 */
export async function requireCapabilityLive(req, res, capability, options={}){
  const session = getSession(req);
  if(!session){
    if(options.navigation){
      res.setHeader('Cache-Control','no-store, private');
      res.setHeader('Location',options.loginPath||'/login?expired=1');
      res.status(303).end();
    }else res.status(401).json({message:'Unauthorized'});
    return null;
  }
  let live;
  try{live=await (options.revalidateSession||revalidateMembership)(session)}
  catch(error){
    console.error('[auth-live] membership revalidation unavailable',{
      code:error?.code||'session_revalidation_unavailable',
      upstream_status:error?.cause?.status||null,
      capability,
      mode:session.mode||'unknown'
    });
    if(options.navigation){
      res.setHeader('Cache-Control','no-store, private');
      res.setHeader('Location',options.retryPath||'/dashboard?soop=retry');
      res.status(303).end();
    }else{
      res.status(503).json({
        message:'로그인 상태 확인이 일시적으로 지연되고 있습니다. 잠시 후 다시 시도해주세요.',
        code:'session_revalidation_unavailable',
        retryable:true
      });
    }
    return null;
  }
  if(!live){
    clearSessionCookie(res);
    if(options.navigation){
      res.setHeader('Location',options.loginPath||'/login?expired=1');
      res.status(303).end();
    }else res.status(401).json({message:'세션이 만료되었거나 권한이 변경되었습니다. 다시 로그인해주세요.'});
    return null;
  }
  if(!hasCapability(live, capability)){
    res.status(403).json({
      message:'권한이 부족합니다.',
      required_capability:capability,
      current_role:normalizeRole(live.role),
    });
    return null;
  }
  return live;
}

export { CAPABILITIES, ROLE_RANK };
