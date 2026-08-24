import {createHash} from 'node:crypto';
import {requireCapabilityLive} from '../lib/auth.js';
import {DEPLOYMENT_ASSETS} from '../lib/deployment-assets.js';
import {workspaceForSession,addWorkspaceFilter,withWorkspaceBody,WORKSPACE_TABLES} from '../lib/workspace.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';

const TABLES=new Set([...WORKSPACE_TABLES]);
const METHODS=new Set(['GET','POST','PATCH','DELETE']);
const PUBLIC_RPC_OPERATIONS=Object.freeze({
  'public-workspace':'get_public_workspace',
  'public-bangsel':'get_public_bangsel'
});
const VERIFIED_DEPLOYMENT_ASSETS=Object.freeze(Object.fromEntries(
  Object.entries(DEPLOYMENT_ASSETS).map(([name,asset])=>{
    const bytes=Buffer.from(asset.data.replace(/\s+/g,''),'base64');
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(bytes.length!==asset.size||digest!==asset.sha256){
      throw new Error(`Deployment asset integrity check failed: ${name}`);
    }
    return [name,bytes];
  })
));

function serveDeploymentAsset(req,res){
  if(req.method!=='GET'&&req.method!=='HEAD')return res.status(405).json({message:'Method not allowed'});
  const name=Array.isArray(req.query?.name)?req.query.name[0]:String(req.query?.name||'');
  const bytes=VERIFIED_DEPLOYMENT_ASSETS[name];
  if(!bytes)return res.status(404).json({message:'Asset not found'});
  res.setHeader('Content-Type','image/png');
  res.setHeader('Cache-Control','public, max-age=31536000, immutable');
  res.setHeader('Content-Length',String(bytes.length));
  if(req.method==='HEAD')return res.status(200).end();
  return res.status(200).send(bytes);
}

function parseJsonBody(body){
  if(body===undefined||body===null)return {};
  if(typeof body==='string'){
    try{return JSON.parse(body)}catch{return null}
  }
  return body&&typeof body==='object'&&!Array.isArray(body)?body:null;
}

async function servePublicRpc(req,res,operation){
  res.setHeader('Cache-Control','no-store');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});

  const parsed=parseJsonBody(req.body);
  if(!parsed)return res.status(400).json({message:'Invalid JSON body'});
  const workspace=String(parsed.p_workspace_slug||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(workspace)){
    return res.status(400).json({message:'Invalid workspace'});
  }

  let search=null;
  if(operation==='public-bangsel'&&parsed.p_search!==undefined&&parsed.p_search!==null){
    if(typeof parsed.p_search!=='string')return res.status(400).json({message:'Invalid search'});
    search=parsed.p_search.trim();
    if(search.length>100)return res.status(400).json({message:'Search is too long'});
    if(!search)search=null;
  }

  const supabaseUrl=(process.env.SUPABASE_URL||'').replace(/\/+$/,'');
  const secretKey=process.env.SUPABASE_SECRET_KEY||'';
  const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!supabaseUrl||!secretKey||!serviceRoleKey){
    return res.status(500).json({message:'Public data service is not configured'});
  }

  const rpcName=PUBLIC_RPC_OPERATIONS[operation];
  const body=operation==='public-workspace'
    ? {p_workspace_slug:workspace}
    : {p_workspace_slug:workspace,p_search:search};
  try{
    const upstream=await fetch(`${supabaseUrl}/rest/v1/rpc/${rpcName}`,{
      method:'POST',
      headers:{
        apikey:secretKey,
        Authorization:'Bearer '+serviceRoleKey,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(body),
      cache:'no-store',
      signal:AbortSignal.timeout(10000)
    });
    const text=await upstream.text();
    if(!upstream.ok){
      return res.status(upstream.status).json({message:'Public data query failed'});
    }
    res.status(upstream.status);
    res.setHeader('Content-Type',upstream.headers.get('content-type')||'application/json; charset=utf-8');
    return res.send(text);
  }catch{
    return res.status(502).json({message:'Public data service is unavailable'});
  }
}

function capabilityForMethod(method){
  if(method === 'GET') return 'data:read';
  if(method === 'POST' || method === 'PATCH') return 'data:write';
  if(method === 'DELETE') return 'data:delete';
  return null;
}

export default async function handler(req,res){
  if(req.query?.operation==='deployment-asset')return serveDeploymentAsset(req,res);
  if(PUBLIC_RPC_OPERATIONS[req.query?.operation])return servePublicRpc(req,res,req.query.operation);
  res.setHeader('Cache-Control','no-store, private');
  if(rejectMaintenanceWrite(req,res))return;
  const table=String(req.query.table||''),rawPath=String(req.query.path||''),method=String(req.method||'GET').toUpperCase();
  if(!TABLES.has(table))return res.status(400).json({message:'Table not allowed'});
  if(!METHODS.has(method))return res.status(405).json({message:'Method not allowed'});
  if(rawPath&&(!rawPath.startsWith('?')||/[\r\n]/.test(rawPath)))return res.status(400).json({message:'Invalid query path'});
  if(/(^|[?&])workspace_id=/.test(rawPath))return res.status(400).json({message:'workspace_id is server controlled'});

  // H-01: 메서드별 역할 검사
  const capability = capabilityForMethod(method);
  if(!capability)return res.status(405).json({message:'Method not allowed'});
  // 쿠키에 서명된 과거 role만 신뢰하지 않고, 매 요청마다 멤버십·워크스페이스 상태를 재확인한다.
  const session=await requireCapabilityLive(req,res,capability); if(!session)return;

  const workspaceId=await workspaceForSession(session);
  if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  const path=addWorkspaceFilter(rawPath,workspaceId);

  const supabaseUrl=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),secretKey=process.env.SUPABASE_SECRET_KEY||'',serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!supabaseUrl||!secretKey||!serviceRoleKey)return res.status(500).json({message:'Supabase server environment variables are not configured'});
  const headers={apikey:secretKey,Authorization:'Bearer '+serviceRoleKey,'Content-Type':'application/json',Prefer:req.headers.prefer||'return=representation'};
  let body;
  if(method!=='GET'&&req.body!==undefined&&req.body!==null){
    let parsed=req.body;
    if(typeof parsed==='string'){try{parsed=JSON.parse(parsed)}catch{return res.status(400).json({message:'Invalid JSON body'})}}
    body=JSON.stringify(withWorkspaceBody(parsed,workspaceId));
  }
  try{
    const upstream=await fetch(`${supabaseUrl}/rest/v1/${table}${path}`,{method,headers,body,cache:'no-store'});
    const text=await upstream.text();res.status(upstream.status);res.setHeader('Content-Type',upstream.headers.get('content-type')||'application/json; charset=utf-8');return res.send(text);
  }catch(e){return res.status(502).json({message:'Supabase proxy failed'});}
}
