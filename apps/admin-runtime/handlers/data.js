import {createHash} from 'node:crypto';
import {publicReadConfig,fetchPublicRead} from '../lib/public-read.js';
import {requireCapabilityLive} from '../lib/auth.js';
import {DEPLOYMENT_ASSETS} from '../lib/deployment-assets.js';
import {VERCEL_PREVIEW_ASSETS} from '../lib/vercel-binary-assets/preview-assets.js';
import {workspaceForSession,WORKSPACE_TABLES} from '../lib/workspace.js';
import {buildDataRequest,readBoundedResponse} from '../lib/data-query-policy.js';
import {isJsonRequest,isTrustedMutationOrigin} from '../lib/request-origin.js';
import {allowPublicRequest,coalescePublicRead} from '../lib/public-request-guard.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {loadTaskCompletionHistory} from '../lib/task-completion-history.js';
import {loadDonationReport} from '../lib/donation-report.js';
import {
  NATIVE_ROULETTE_MAX_RESULT_CODE_POINTS,
  NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES,
  unicodeGraphemeCount
} from '../lib/native-roulette.js';

const TABLES=new Set([...WORKSPACE_TABLES]);
const METHODS=new Set(['GET','POST','PATCH','DELETE']);
const PUBLIC_RPC_OPERATIONS=Object.freeze({
  'public-workspace':'get_public_workspace',
  'public-bangsel':'get_public_bangsel',
  'public-upbo-page':'byeollog_public_upbo_page_v1',
  'public-viewer':'byeollog_public_viewer_snapshot_v1'
});
const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEPLOYMENT_ASSET_CATALOG=Object.freeze({...DEPLOYMENT_ASSETS,...VERCEL_PREVIEW_ASSETS});
const verifiedDeploymentAssets=new Map();
function verifiedDeploymentAsset(name){
    if(!Object.hasOwn(DEPLOYMENT_ASSET_CATALOG,name))return null;
    if(verifiedDeploymentAssets.has(name))return verifiedDeploymentAssets.get(name);
    const asset=DEPLOYMENT_ASSET_CATALOG[name];
    const bytes=Buffer.from(asset.data.replace(/\s+/g,''),'base64');
    const digest=createHash('sha256').update(bytes).digest('hex');
    if(bytes.length!==asset.size||digest!==asset.sha256){
      throw new Error(`Deployment asset integrity check failed: ${name}`);
    }
    const verified=Object.freeze({bytes,mimeType:asset.mimeType||'image/png'});
    verifiedDeploymentAssets.set(name,verified);
    return verified;
}

function serveDeploymentAsset(req,res){
  if(req.method!=='GET'&&req.method!=='HEAD')return res.status(405).json({message:'Method not allowed'});
  const name=Array.isArray(req.query?.name)?req.query.name[0]:String(req.query?.name||'');
  const asset=verifiedDeploymentAsset(name);
  if(!asset)return res.status(404).json({message:'Asset not found'});
  const {bytes,mimeType}=asset;
  res.setHeader('Content-Type',mimeType);
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

function legacyPublicRows(rows,operation){
  if(!Array.isArray(rows))throw new Error('Invalid public response');
  const workspace=operation==='public-workspace';
  const textFields=workspace?['slug','display_name']:['fan','event','type','comment'];
  return rows.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row))throw new Error('Invalid public row');
    const result={};
    // Keep SQL text/null values intact, but never forward new columns or nested objects.
    for(const field of textFields){
      const value=row[field];
      if(value!==null&&typeof value!=='string')throw new Error('Invalid public field');
      result[field]=value;
    }
    if(workspace){
      if(typeof row.public_page_enabled!=='boolean')throw new Error('Invalid public visibility');
      result.public_page_enabled=row.public_page_enabled;
      result.viewer_roulette_enabled=publicRouletteViewerEnabled();
    }else{
      if(!Number.isInteger(row.remaining)||row.remaining<0)throw new Error('Invalid public quantity');
      result.remaining=row.remaining;
    }
    return result;
  });
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
  if(['public-bangsel','public-upbo-page','public-viewer'].includes(operation)&&parsed.p_search!==undefined&&parsed.p_search!==null){
    if(typeof parsed.p_search!=='string')return res.status(400).json({message:'Invalid search'});
    search=parsed.p_search.trim();
    if(search.length>100)return res.status(400).json({message:'Search is too long'});
    if(!search)search=null;
  }

  const paged=['public-upbo-page','public-viewer'].includes(operation);
  if(paged&&(!Number.isInteger(parsed.p_page??0)||(parsed.p_page??0)<0||(parsed.p_page??0)>2000||!['name','remaining','newest'].includes(parsed.p_sort??'name')))return res.status(400).json({message:'Invalid page'});
  const readConfig=publicReadConfig();
  if(!readConfig){
    return res.status(500).json({message:'Public data service is not configured'});
  }

  const view=parsed.p_view;
  if(operation==='public-viewer'&&view!==undefined&&!['pending','completed'].includes(view))return res.status(400).json({message:'Invalid view'});
  const body=operation==='public-workspace'
    ? {p_workspace_slug:workspace}
    : {p_workspace_slug:workspace,p_search:search,...(paged?{p_page:parsed.p_page??0,p_sort:parsed.p_sort??'name'}:{}),...(operation==='public-viewer'&&view!==undefined?{p_view:view}:{})};
  try{
    const {upstreamStatus,text}=await coalescePublicRead(JSON.stringify([readConfig.url,operation,body]),()=>fetchPublicRead(readConfig,operation,body));
    if(upstreamStatus<200||upstreamStatus>=300){
      return res.status(upstreamStatus).json({message:'Public data query failed'});
    }
    if(paged){
      const payload=JSON.parse(text),data=operation==='public-viewer'?payload.pageData:payload;
      const metadata=operation==='public-viewer'&&payload.workspace?{
        slug:String(payload.workspace.slug||''),display_name:String(payload.workspace.display_name||''),
        public_page_enabled:payload.workspace.public_page_enabled===true,public_completed_enabled:payload.workspace.public_completed_enabled===true,viewer_roulette_enabled:publicRouletteViewerEnabled()
      }:null;
      const visible=operation!=='public-viewer'||(metadata?.public_page_enabled===true&&(view!=='completed'||metadata?.public_completed_enabled===true));
      const sourceItems=visible&&Array.isArray(data?.items)?data.items:[];
      if(sourceItems.some(row=>!row||!/^[a-f0-9]{64}$/.test(row.fan_key)))throw new Error('Invalid public identity');
      const items=sourceItems.map(row=>({
        fan:String(row.fan||''),event:String(row.event||''),type:String(row.type||''),
        remaining:Number(row.remaining)||0,fan_remaining:Number(row.fan_remaining)||0,comment:String(row.comment||''),
        ...(view==='completed'?{completed_qty:Number(row.completed_qty)||0,fan_completed:Number(row.fan_completed)||0,completed_at:typeof row.completed_at==='string'?row.completed_at:null}:{}),
        fan_key:row.fan_key
      }));
      return res.status(200).json({items,hasMore:visible&&data?.hasMore===true,totalRows:visible?Number(data?.totalRows)||0:0,page:parsed.p_page??0,
        ...(operation==='public-viewer'?{workspace:metadata}:{})});
    }
    const safeRows=legacyPublicRows(JSON.parse(text),operation);
    res.status(upstreamStatus);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    return res.send(JSON.stringify(safeRows));
  }catch{
    return res.status(502).json({message:'Public data service is unavailable'});
  }
}

function publicRouletteViewerEnabled(){
  return process.env.VIEWER_ROULETTE_PUBLIC_ENABLED==='true';
}

function toPublicRoulette(row){
  const name=String(row?.roulette_name||'').trim();
  const draft=row?.draft&&typeof row.draft==='object'&&!Array.isArray(row.draft)?row.draft:null;
  const balloons=Number(draft?.balloonsPerSpin);
  const rawItems=Array.isArray(draft?.items)?draft.items:[];
  if(!name||name.length>120||!Number.isSafeInteger(balloons)||balloons<1||balloons>1000000||rawItems.length<2||rawItems.length>200)return null;
  const items=[];
  let total=0;
  for(const raw of rawItems){
    const resultText=String(raw?.resultText||'').trim().normalize('NFC');
    const probabilityPpm=Number(raw?.probabilityPpm);
    if(!resultText||unicodeGraphemeCount(resultText)>NATIVE_ROULETTE_MAX_RESULT_GRAPHEMES||[...resultText].length>NATIVE_ROULETTE_MAX_RESULT_CODE_POINTS||!Number.isSafeInteger(probabilityPpm)||probabilityPpm<1||probabilityPpm>=1000000)return null;
    total+=probabilityPpm;
    items.push({resultText,probabilityPpm});
  }
  if(total!==1000000)return null;
  return {rouletteName:name,balloonsPerSpin:balloons,items,updatedAt:row?.updated_at||null};
}

async function servePublicRoulette(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(!publicRouletteViewerEnabled())return res.status(404).json({message:'Not found'});
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const parsed=parseJsonBody(req.body);
  if(!parsed)return res.status(400).json({message:'Invalid JSON body'});
  const workspace=String(parsed.p_workspace_slug||'').trim().toLowerCase();
  if(!/^[a-z0-9][a-z0-9_-]{1,62}$/.test(workspace))return res.status(400).json({message:'Invalid workspace'});

  const readConfig=publicReadConfig();
  if(!readConfig)return res.status(500).json({message:'Public data service is not configured'});
  try{
    const {upstreamStatus,text}=await fetchPublicRead(readConfig,'public-roulette',{p_workspace_slug:workspace});
    if(upstreamStatus<200||upstreamStatus>=300)return res.status(upstreamStatus).json({message:'Public data query failed'});
    const draftRows=JSON.parse(text);
    const roulettes=(Array.isArray(draftRows)?draftRows:[]).map(toPublicRoulette).filter(Boolean);
    return res.status(200).json({enabled:true,roulettes});
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
  if(req.query?.operation==='public-roulette'||PUBLIC_RPC_OPERATIONS[req.query?.operation]){
    if(req.method==='POST'){
      const gate=allowPublicRequest(req);
      if(!gate.allowed){res.setHeader('Cache-Control','no-store');res.setHeader('Retry-After',String(gate.retryAfter));return res.status(429).json({message:'요청이 많습니다. 잠시 후 다시 조회해주세요.'})}
      if(Buffer.byteLength(typeof req.body==='string'?req.body:JSON.stringify(req.body??{}))>2048)return res.status(413).json({message:'Request too large'});
    }
  }
  if(req.query?.operation==='public-roulette')return servePublicRoulette(req,res);
  if(PUBLIC_RPC_OPERATIONS[req.query?.operation])return servePublicRpc(req,res,req.query.operation);
  res.setHeader('Cache-Control','no-store, private');
  if(req.query?.operation==='donation-report'){
    if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
    const session=await requireCapabilityLive(req,res,'data:read');if(!session)return;
    try{return res.status(200).json(await loadDonationReport(await workspaceForSession(session),req.query))}
    catch(error){const status=[400,403,422].includes(error.status)?error.status:503;return res.status(status).json({message:status===400||status===422?error.message:'리포트를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'})}
  }
  if(req.query?.operation==='task-completion-history'){
    if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
    const session=await requireCapabilityLive(req,res,'data:read');if(!session)return;
    try{return res.status(200).json(await loadTaskCompletionHistory(await workspaceForSession(session),req.query.cursor))}
    catch(error){return res.status(error.status===400||error.status===403?error.status:503).json({message:error.status===400?error.message:'업보 처리 이력을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.'})}
  }
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
  if(method!=='GET'&&!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'});
  if(['POST','PATCH'].includes(method)&&!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'});
  let request;
  try{request=buildDataRequest({table,rawPath,method,workspaceId,body:req.body,prefer:req.headers.prefer})}
  catch(error){return res.status(400).json({message:error.message})}
  const {path}=request;

  const supabaseUrl=(process.env.SUPABASE_URL||'').replace(/\/+$/,''),secretKey=process.env.SUPABASE_SECRET_KEY||'',serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY||'';
  if(!supabaseUrl||!secretKey||!serviceRoleKey)return res.status(500).json({message:'Supabase server environment variables are not configured'});
  const headers={apikey:secretKey,Authorization:'Bearer '+serviceRoleKey,'Content-Type':'application/json',Prefer:request.prefer};
  const body=request.body===undefined?undefined:JSON.stringify(request.body);
  try{
    if(table==='bangsel_task_import_items'&&request.body){
      const ids=[...new Set((Array.isArray(request.body)?request.body:[request.body]).map(row=>row.task_id).filter(Boolean))];
      if(ids.length){
        const query=new URLSearchParams({workspace_id:'eq.'+workspaceId,id:'in.('+ids.join(',')+')',select:'id',limit:'1000'});
        const checked=await fetch(`${supabaseUrl}/rest/v1/bangsel_tasks?${query}`,{headers,cache:'no-store',signal:AbortSignal.timeout(10000)});
        if(!checked.ok)throw Error('Reference check failed');
        const found=JSON.parse(await readBoundedResponse(checked));
        if(!Array.isArray(found)||ids.some(id=>!found.some(row=>row.id===id)))return res.status(400).json({message:'Task reference unavailable'});
      }
    }
    const upstream=await fetch(`${supabaseUrl}/rest/v1/${table}${path}`,{method,headers,body,cache:'no-store',signal:AbortSignal.timeout(15000)});
    const text=await readBoundedResponse(upstream);
    if(!upstream.ok)return res.status(upstream.status>=500?502:upstream.status).json({message:'데이터 처리 요청을 완료하지 못했습니다.'});
    res.status(upstream.status);res.setHeader('Content-Type','application/json; charset=utf-8');return res.send(text);
  }catch(e){return res.status(502).json({message:'Supabase proxy failed'});}
}
