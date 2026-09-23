import crypto from 'node:crypto';

export const RUNTIME_HEADER='x-byeollog-runtime-token';
export const PUBLIC_DATA_OPERATIONS=new Set([
  'deployment-asset','public-workspace','public-bangsel','public-upbo-page','public-viewer','public-roulette'
]);
export const ADMIN_SOOP_KINDS=new Set(['reconcile','lease']);
export const COLLECTOR_SOOP_KINDS=new Set(['heartbeat','event']);

const SENSITIVE_FRONTEND_ENV=[
  'SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY',
  'SESSION_SECRET','PLATFORM_ADMIN_EMAILS','COLLECTOR_TOKEN','CRON_SECRET',
  'ADMIN_PAGE_ID','ADMIN_PAGE_PASSWORD','PASSWORD_RESET_REDIRECT_URL',
  'SOOP_CLIENT_ID','SOOP_CLIENT_SECRET','SOOP_TOKEN_ENCRYPTION_KEY',
  'SOOP_GATEWAY_INGRESS_SECRET','SOOP_GATEWAY_LEASE_SECRET',
  'DISCORD_OPS_PUBLIC_KEY','DISCORD_OPS_APPLICATION_ID',
  'CARTESIA_API_KEY','GOOGLE_APPLICATION_CREDENTIALS_JSON',
  'BYEOLLOG_PUBLIC_READ_TOKEN','BYEOLLOG_BACKUP_RUNNER_SECRET',
  'BYEOLLOG_BACKUP_WORKER_SECRET','BYEOLLOG_BACKUP_WORKER_URL',
  'BYEOLLOG_MANAGED_TTS_BRIDGE_SECRET','BYEOLLOG_UPBO_RETRY_SECRET'
];
const FORBIDDEN_BY_RUNTIME={
  frontend:SENSITIVE_FRONTEND_ENV,
  collector:[
    'SESSION_SECRET','PLATFORM_ADMIN_EMAILS','SOOP_CLIENT_ID','SOOP_CLIENT_SECRET',
    'SOOP_TOKEN_ENCRYPTION_KEY','DISCORD_OPS_PUBLIC_KEY','DISCORD_OPS_APPLICATION_ID',
    'CARTESIA_API_KEY','GOOGLE_APPLICATION_CREDENTIALS_JSON','BYEOLLOG_PUBLIC_READ_TOKEN',
    'BYEOLLOG_BACKUP_RUNNER_SECRET','BYEOLLOG_BACKUP_WORKER_SECRET'
  ],
  public:[
    'SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET','PLATFORM_ADMIN_EMAILS',
    'COLLECTOR_TOKEN','CRON_SECRET','SOOP_CLIENT_ID','SOOP_CLIENT_SECRET',
    'SOOP_TOKEN_ENCRYPTION_KEY','SOOP_GATEWAY_INGRESS_SECRET','SOOP_GATEWAY_LEASE_SECRET',
    'DISCORD_OPS_PUBLIC_KEY','DISCORD_OPS_APPLICATION_ID','CARTESIA_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS_JSON','BYEOLLOG_BACKUP_RUNNER_SECRET','BYEOLLOG_BACKUP_WORKER_SECRET'
  ],
  admin:[]
};
const REQUIRED_BY_RUNTIME={
  frontend:['BYEOLLOG_ADMIN_RUNTIME_URL','BYEOLLOG_ADMIN_RUNTIME_TOKEN','BYEOLLOG_COLLECTOR_RUNTIME_URL','BYEOLLOG_COLLECTOR_RUNTIME_TOKEN','BYEOLLOG_PUBLIC_RUNTIME_URL','BYEOLLOG_PUBLIC_RUNTIME_TOKEN'],
  collector:['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SOOP_GATEWAY_INGRESS_SECRET'],
  public:['SUPABASE_URL','SUPABASE_ANON_KEY','BYEOLLOG_PUBLIC_READ_TOKEN'],
  admin:['SUPABASE_URL','SUPABASE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','SESSION_SECRET']
};

const present=value=>typeof value==='string'&&value.trim()!=='';
const exactSecret=(left,right)=>{
  if(!present(left)||!present(right))return false;
  const a=Buffer.from(left),b=Buffer.from(right);
  return a.length===b.length&&a.length>=32&&crypto.timingSafeEqual(a,b);
};

export function runtimeConfigProblems(runtime,env=process.env){
  if(!Object.hasOwn(FORBIDDEN_BY_RUNTIME,runtime))return ['unknown runtime'];
  const problems=[];
  if(env.BYEOLLOG_RUNTIME!==runtime)problems.push('runtime marker mismatch');
  for(const name of REQUIRED_BY_RUNTIME[runtime])if(!present(env[name]))problems.push(`missing ${name}`);
  for(const name of FORBIDDEN_BY_RUNTIME[runtime])if(present(env[name]))problems.push(`forbidden ${name}`);
  return problems;
}

function normalizeInternalRequest(req){
  if(!req.headers)req.headers={};
  delete req.headers[RUNTIME_HEADER];
  req.headers.host='byeollog.com';
  req.headers['x-forwarded-host']='byeollog.com';
  req.headers['x-forwarded-proto']='https';
}

export function createInternalRuntimeHandler(handler,{runtime,allowRequest=()=>true,env=process.env}={}){
  if(typeof handler!=='function')throw new TypeError('handler is required');
  return async function isolatedHandler(req,res){
    res.setHeader('Cache-Control','no-store, private');
    res.setHeader('X-Vercel-Enable-Rewrite-Caching','0');
    const supplied=String(req.headers?.[RUNTIME_HEADER]||'');
    if(!exactSecret(String(env.BYEOLLOG_RUNTIME_TOKEN||''),supplied))return res.status(404).json({message:'Not found'});
    const problems=runtimeConfigProblems(runtime,env);
    if(problems.length){
      console.error('[runtime-isolation] invalid runtime configuration',{runtime,problems});
      return res.status(503).json({message:'Runtime unavailable'});
    }
    if(!allowRequest(req))return res.status(404).json({message:'Not found'});
    normalizeInternalRequest(req);
    return handler(req,res);
  };
}

export function bodyObject(req){
  if(req?.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body)&&!Array.isArray(req.body))return req.body;
  if(typeof req?.body==='string'){try{const value=JSON.parse(req.body);return value&&typeof value==='object'&&!Array.isArray(value)?value:null}catch{return null}}
  return null;
}

export function allowPublicData(req){return PUBLIC_DATA_OPERATIONS.has(String(req.query?.operation||''))}
export function allowAdminData(req){return !PUBLIC_DATA_OPERATIONS.has(String(req.query?.operation||''))}
export function allowAdminLogin(req){
  if(String(req.query?.operation||'')!=='soop-gateway')return true;
  return ADMIN_SOOP_KINDS.has(String(bodyObject(req)?.kind||''));
}
export function allowCollectorLogin(req){
  return String(req.query?.operation||'')==='soop-gateway'&&COLLECTOR_SOOP_KINDS.has(String(bodyObject(req)?.kind||''));
}

export function selectDataRuntime(req){return allowPublicData(req)?'public':'admin'}
export function selectLoginRuntime(req){
  if(String(req.query?.operation||'')!=='soop-gateway')return 'admin';
  const kind=String(bodyObject(req)?.kind||'');
  if(COLLECTOR_SOOP_KINDS.has(kind))return 'collector';
  return 'admin';
}

export function allowAdminNativeRoulette(req){
  return !['soop-donation','soop-chat'].includes(String(req.query?.operation||''));
}
export function allowCollectorNativeRoulette(req){
  return ['soop-donation','soop-chat'].includes(String(req.query?.operation||''));
}
export function selectNativeRouletteRuntime(req){return allowCollectorNativeRoulette(req)?'collector':'admin'}

export function ensureFrontendRuntime(env=process.env){return runtimeConfigProblems('frontend',env)}
