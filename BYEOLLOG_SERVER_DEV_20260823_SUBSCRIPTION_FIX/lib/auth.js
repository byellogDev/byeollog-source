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

/** H-05: 쿠키 세션의 멤버십/기기 상태를 DB에서 재확인 */
export async function revalidateMembership(session){
  if(!session) return null;
  if(session.mode==='collector_handoff'){
    if(!session.collector_device_id || !session.workspace_id) return null;
    try{
      const rows=await sb(
        'byeollog_collector_devices',
        `?select=id,workspace_id,status&id=eq.${encodeURIComponent(session.collector_device_id)}`+
        `&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&status=eq.active&limit=1`
      );
      const device=Array.isArray(rows)?rows[0]:null;
      if(!device || device.workspace_id!==session.workspace_id) return null;
      const workspaces=await sb(
        'byeollog_workspaces',
        `?select=id,status&id=eq.${encodeURIComponent(session.workspace_id)}&status=eq.active&limit=1`
      );
      if(!Array.isArray(workspaces)||workspaces[0]?.id!==session.workspace_id) return null;
      return session;
    }catch{ return null; }
  }

  if(!session.user_id || !session.workspace_id) return null;
  try{
    const rows=await sb(
      'byeollog_workspace_members',
      `?select=role,workspace_id&user_id=eq.${encodeURIComponent(session.user_id)}&workspace_id=eq.${encodeURIComponent(session.workspace_id)}&limit=1`
    );
    const m=Array.isArray(rows)?rows[0]:null;
    if(!m) return null;
    const ws=await sb(
      'byeollog_workspaces',
      `?select=id,status&id=eq.${encodeURIComponent(session.workspace_id)}&status=eq.active&limit=1`
    );
    if(!Array.isArray(ws)||!ws[0]) return null;
    return {...session, role:normalizeRole(m.role)};
  }catch{
    return null;
  }
}

/** H-05: capability + 멤버십 재검증 */
export async function requireCapabilityLive(req, res, capability){
  const session = requireSession(req, res);
  if(!session) return null;
  const live = await revalidateMembership(session);
  if(!live){
    clearSessionCookie(res);
    res.status(401).json({message:'세션이 만료되었거나 권한이 변경되었습니다. 다시 로그인해주세요.'});
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
