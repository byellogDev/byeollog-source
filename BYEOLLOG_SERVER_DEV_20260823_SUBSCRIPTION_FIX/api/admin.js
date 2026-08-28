import crypto from 'node:crypto';
import {getSession,isPlatformAdmin,requireSession,requireCapabilityLive,clearSessionCookie} from '../lib/auth.js';
import {ADMIN_HTML_BASE64} from '../lib/admin-html.js';
import {handleSignupApplications} from '../lib/signup.js';
import {workspaceForSession,q} from '../lib/workspace.js';
import {sb} from '../lib/supabase-rest.js';
import {removeStorageManifest} from '../lib/backup.js';
import {rejectMaintenanceWrite} from '../lib/maintenance.js';
import {getAgentRolloutHtml} from '../lib/agent-rollout-html.js';
import {loadStableAgentRelease,sanitizeAgentRolloutSnapshot} from '../lib/agent-rollout.js';
import {getProductDashboardHtml} from '../lib/product-dashboard-html.js';
import {normalizeNativeRouletteWebDraft,NativeRouletteValidationError} from '../lib/native-roulette.js';
import {NATIVE_ROULETTE_ASSETS,publicNativeRouletteAsset} from '../lib/native-roulette-assets.js';
import {fetchWeflabPublicRoulette,WeflabPublicImportError,normalizeWeflabPublicUrl} from '../lib/weflab-public-roulette-import.js';
import {
  RouletteAssetError,createRouletteAssetUploadTicket,verifyRouletteAssetUpload,
  rouletteAssetPublicUrl,rouletteAssetOrigin,rouletteAssetPaths,removeRouletteAssets
} from '../lib/roulette-custom-assets.js';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function bodyOf(req){
  if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return null}}
  return req.body&&typeof req.body==='object'&&!Array.isArray(req.body)?req.body:{};
}

export function rewriteInlineEventHandlers(source){
  return String(source).replace(/\s(on(?:click|input|change))=(["'])([\s\S]*?)\2/g,(_all,eventName,quote,code)=>` data-bl-${eventName}=${quote}${code}${quote}`);
}

async function handleInquiryAdmin(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const session=await requireCapabilityLive(req,res,'data:read');
  if(!session)return;
  if(!isPlatformAdmin(session))return res.status(403).json({message:'플랫폼 관리자만 사용할 수 있습니다.'});
  const bodyOf=(req)=>{if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}};
  if(req.method==='GET'){
    try{
      const rows=await sb('byeollog_inquiries','?select=id,contact,message,status,created_at,read_at&order=created_at.desc&limit=100');
      return res.status(200).json({ok:true,rows:Array.isArray(rows)?rows:[]});
    }catch(e){
      return res.status(500).json({message:'문의 목록을 불러오지 못했습니다.'});
    }
  }
  if(req.method==='DELETE'){
    const b=bodyOf(req);
    const id=String(b.id||req.query?.id||'').trim();
    if(!id)return res.status(400).json({message:'id가 필요합니다.'});
    try{
      await sb('byeollog_inquiries','?id=eq.'+encodeURIComponent(id),{method:'DELETE',prefer:'return=minimal'});
      return res.status(200).json({ok:true});
    }catch(e){
      return res.status(500).json({message:'문의 삭제에 실패했습니다.'});
    }
  }
  if(req.method==='PATCH'||req.method==='POST'){
    const b=bodyOf(req);
    if(b.action==='delete'||b.delete){
      const id=String(b.id||'').trim();
      if(!id)return res.status(400).json({message:'id가 필요합니다.'});
      try{
        await sb('byeollog_inquiries','?id=eq.'+encodeURIComponent(id),{method:'DELETE',prefer:'return=minimal'});
        return res.status(200).json({ok:true});
      }catch(e){
        return res.status(500).json({message:'문의 삭제에 실패했습니다.'});
      }
    }
    const id=String(b.id||'').trim();
    const status=String(b.status||'').trim();
    if(!id)return res.status(400).json({message:'id가 필요합니다.'});
    if(!['new','read','archived'].includes(status))return res.status(400).json({message:'status가 올바르지 않습니다.'});
    try{
      const patch={status};
      if(status==='read')patch.read_at=new Date().toISOString();
      await sb('byeollog_inquiries','?id=eq.'+encodeURIComponent(id),{method:'PATCH',body:patch});
      return res.status(200).json({ok:true});
    }catch(e){
      return res.status(500).json({message:'상태 변경에 실패했습니다.'});
    }
  }
  return res.status(405).json({message:'Method not allowed'});
}


async function handleAccountWithdraw(req,res){
  res.setHeader('Cache-Control','no-store');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const session=requireSession(req,res);
  if(!session)return;
  const bodyOf=(req)=>{if(typeof req.body==='string'){try{return JSON.parse(req.body)}catch{return {}}}return req.body||{}};
  const b=bodyOf(req);
  const confirm=String(b.confirm||'').trim();
  if(confirm!=='탈퇴합니다'){
    return res.status(400).json({message:'확인 문구를 정확히 입력해주세요. (탈퇴합니다)'});
  }
  try{
    const workspaceId=await workspaceForSession(session);
    const userId=session.user_id||null;
    if(!workspaceId||!userId)return res.status(400).json({message:'탈퇴할 계정 또는 워크스페이스를 확인할 수 없습니다.'});

    // Storage API는 DB 트랜잭션에 포함될 수 없다. 먼저 의도를 고정해 새 백업 lease를
    // 차단하고, DB가 반환한 exact manifest만 삭제한 뒤 0건을 재검증한다.
    const prepared=await sb('rpc/prepare_account_withdrawal_v1','',{
      method:'POST',
      body:{p_user_id:userId,p_workspace_id:workspaceId}
    });
    const intentToken=String(prepared?.intentToken||'').trim();
    if(prepared?.workspaceId!==workspaceId
      || typeof prepared?.blocksWorkspaceBackups!=='boolean'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(intentToken)){
      throw new Error('회원 탈퇴 준비 응답이 올바르지 않습니다.');
    }
    await removeStorageManifest(prepared.storageManifest);
    const storageConfirmed=await sb('rpc/confirm_account_withdrawal_storage_v1','',{
      method:'POST',
      body:{
        p_user_id:userId,
        p_workspace_id:workspaceId,
        p_intent_token:intentToken
      }
    });
    if(storageConfirmed!==true){
      throw new Error('회원 탈퇴 Storage 재검증이 완료되지 않았습니다.');
    }

    // 준비 token, active lease 0건, Storage 0건을 다시 확인한 DB 단일 트랜잭션이
    // workspace 데이터와 Auth 계정을 마지막에 삭제한다.
    const result=await sb('rpc/byeollog_withdraw_account','',{
      method:'POST',
      body:{p_user_id:userId,p_workspace_id:workspaceId}
    });
    if(!result?.ok)throw new Error('회원 탈퇴 트랜잭션이 완료되지 않았습니다.');

    // 세션 쿠키 제거
    clearSessionCookie(res);
    return res.status(200).json({ok:true,result,message:'회원 탈퇴가 완료되었습니다.'});
  }catch(e){
    return res.status(500).json({message:'회원 탈퇴 처리에 실패했습니다.'});
  }
}

async function loadDashboardBootstrapData(liveSession){
  const workspaceId=await workspaceForSession(liveSession);
  if(!workspaceId)throw Object.assign(new Error('workspace unavailable'),{status:403});
  const workspaceFilter=`workspace_id=eq.${q(workspaceId)}`;
  const signal=AbortSignal.timeout(15000);
  const [workspaceRows,tasks,fanStations,fans,rouletteRules,taskImportItems]=await Promise.all([
    sb('byeollog_workspaces',`?select=display_name,slug,public_page_enabled&id=eq.${q(workspaceId)}&limit=1`,{signal}),
    sb('bangsel_tasks',`?select=*&${workspaceFilter}&order=created_at.asc`,{signal}),
    sb('bangsel_fan_stations',`?select=fan,station_url&${workspaceFilter}&order=fan.asc`,{signal}),
    sb('bangsel_fans',`?select=*&${workspaceFilter}&order=alias.asc`,{signal}),
    sb('bangsel_roulette_rules',`?select=*&${workspaceFilter}&order=result_text.asc`,{signal}),
    sb('bangsel_task_import_items',`?select=source_event_key,task_id,created_at&${workspaceFilter}`,{signal})
  ]);
  const workspace=Array.isArray(workspaceRows)?workspaceRows[0]:null;
  const slug=String(workspace?.slug||'').trim();
  return {
    ok:true,
    context:{
      streamer_name:String(workspace?.display_name||'').trim()||'관리자',
      workspace_slug:slug||null,
      public_page_enabled:workspace?.public_page_enabled!==false,
      public_page_path:slug?`/u/${encodeURIComponent(slug)}`:null,
      email:liveSession.email||null,
      user_id:liveSession.user_id||null,
      role:liveSession.role||null,
      mode:liveSession.mode||null
    },
    tasks:Array.isArray(tasks)?tasks:[],
    fan_stations:Array.isArray(fanStations)?fanStations:[],
    fans:Array.isArray(fans)?fans:[],
    roulette_rules:Array.isArray(rouletteRules)?rouletteRules:[],
    task_import_items:Array.isArray(taskImportItems)?taskImportItems:[]
  };
}

function logDashboardTiming(mode,startedAt,data){
  console.info(JSON.stringify({
    level:'info',
    message:'dashboard bootstrap completed',
    route:mode==='embedded'?'/dashboard':'/api/admin',
    mode,
    duration_ms:Math.round(performance.now()-startedAt),
    region:process.env.VERCEL_REGION||'local',
    tasks:Array.isArray(data?.tasks)?data.tasks.length:0
  }));
}

export function serializeInlineJson(value){
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,char=>({
    '<':'\\u003c','>':'\\u003e','&':'\\u0026','\u2028':'\\u2028','\u2029':'\\u2029'
  })[char]);
}

async function handleDashboardBootstrap(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const startedAt=performance.now();
  const liveSession=await requireCapabilityLive(req,res,'data:read');
  if(!liveSession)return;
  try{
    const data=await loadDashboardBootstrapData(liveSession);
    res.setHeader('Server-Timing',`dashboard-bootstrap;dur=${(performance.now()-startedAt).toFixed(1)}`);
    logDashboardTiming('api',startedAt,data);
    return res.status(200).json(data);
  }catch(e){
    console.error('[dashboard-bootstrap] failed',{name:e?.name||'Error',status:e?.status||null});
    if(e?.status===403)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
    return res.status(502).json({message:'대시보드 초기 데이터를 불러오지 못했습니다.'});
  }
}

async function handleAgentRolloutStatus(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const liveSession=await requireCapabilityLive(req,res,'data:read');
  if(!liveSession)return;
  try{
    const workspaceId=await workspaceForSession(liveSession);
    if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
    const includeAll=isPlatformAdmin(liveSession);
    const [raw,release]=await Promise.all([
      sb('rpc/get_agent_rollout_dashboard_v2','',{
        method:'POST',
        body:{p_workspace_id:workspaceId,p_include_all_workspaces:includeAll,p_recent_limit:50},
        signal:AbortSignal.timeout(10000)
      }),
      loadStableAgentRelease()
    ]);
    return res.status(200).json(sanitizeAgentRolloutSnapshot(raw,release));
  }catch(error){
    console.error('[agent-rollout] status failed',{name:error?.name||'Error',status:error?.status||null});
    return res.status(502).json({message:'Agent 배포 현황을 불러오지 못했습니다.'});
  }
}

async function handleAgentRolloutPage(req,res){
  const liveSession=await requireCapabilityLive(req,res,'data:read');
  if(!liveSession)return;
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  const nonce=crypto.randomBytes(18).toString('base64url');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'nonce-${nonce}'; style-src-attr 'none'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send(getAgentRolloutHtml(nonce));
}

function publicRule(rule){
  const conditions=Array.isArray(rule?.rule_conditions)?rule.rule_conditions:[];
  const actions=Array.isArray(rule?.rule_actions)?rule.rule_actions:[];
  return {
    id:rule?.id,name:rule?.name,enabled:rule?.enabled===true,priority:rule?.priority,
    versionNumber:rule?.version_number,createdAt:rule?.created_at,
    conditions:conditions.map(item=>({position:item.position,path:item.path,operator:item.operator,value:item.value})),
    actions:actions.map(item=>({position:item.position,actionType:item.action_type,executionTarget:item.execution_target,agentDeviceId:item.agent_device_id}))
  };
}

function publicRouletteDraft(row){
  const draft=row.draft&&typeof row.draft==='object'?structuredClone(row.draft):row.draft;
  for(const key of ['customSingleImage','customSeriesImage']){
    if(draft?.[key]?.storagePath)draft[key].previewUrl=rouletteAssetPublicUrl(draft[key].storagePath);
  }
  return {
    id:row.id,rouletteName:row.roulette_name,versionNumber:row.version_number,
    draft,publicVisible:row.public_visible===true,sourceKind:row.source_kind,sourceUrl:row.source_url,
    sourceFingerprint:row.source_fingerprint,createdAt:row.created_at,updatedAt:row.updated_at
  };
}

async function handleRouletteAsset(req,res,operation){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const session=await requireCapabilityLive(req,res,'data:write');if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  try{
    if(operation==='roulette-image-upload-ticket'){
      return res.status(200).json(await createRouletteAssetUploadTicket(workspaceId,body));
    }
    const confirmed=await verifyRouletteAssetUpload(workspaceId,body.path);
    return res.status(200).json({ok:true,image:confirmed});
  }catch(error){
    if(error instanceof RouletteAssetError||error instanceof NativeRouletteValidationError){
      return res.status(error.status||400).json({message:error.message,code:error.code||'invalid_roulette_asset'});
    }
    console.error('[roulette-image] operation failed',{operation,name:error?.name||'Error',status:error?.status||null});
    return res.status(502).json({message:'룰렛 이미지를 처리하지 못했습니다.'});
  }
}

async function verifyDraftCustomAssets(workspaceId,draft){
  for(const key of ['customSingleImage','customSeriesImage']){
    const current=draft[key];
    if(!current)continue;
    const verified=await verifyRouletteAssetUpload(workspaceId,current.storagePath);
    const {previewUrl:_previewUrl,...reference}=verified;
    draft[key]=reference;
  }
}

async function removeDraftAssetsBestEffort(paths,context){
  try{await removeRouletteAssets(paths)}
  catch(error){console.error('[roulette-image] cleanup failed',{context,name:error?.name||'Error',status:error?.status||null})}
}

async function loadProductControlState(liveSession){
  const workspaceId=await workspaceForSession(liveSession);
  if(!workspaceId)throw Object.assign(new Error('workspace unavailable'),{status:403});
  const filter=q(workspaceId);
  const rulesPromise=sb('rules',`?workspace_id=eq.${filter}&superseded_at=is.null&select=id,name,enabled,priority,created_at,version_number,rule_conditions(position,path,operator,value),rule_actions(position,action_type,execution_target,agent_device_id)&order=created_at.desc&limit=100`,{signal:AbortSignal.timeout(12000)});
  const draftsPromise=sb('byeollog_roulette_drafts',`?workspace_id=eq.${filter}&select=id,roulette_name,version_number,draft,public_visible,source_kind,source_url,source_fingerprint,created_at,updated_at&order=updated_at.desc&limit=100`,{signal:AbortSignal.timeout(12000)}).catch(error=>error?.status===404?[]:Promise.reject(error));
  const devicesPromise=sb('rpc/list_agent_devices_v1','',{method:'POST',body:{p_workspace_id:workspaceId},signal:AbortSignal.timeout(12000)}).catch(()=>[]);
  const [rules,drafts,devices]=await Promise.all([rulesPromise,draftsPromise,devicesPromise]);
  return {
    ok:true,
    section:'control',
    rules:(Array.isArray(rules)?rules:[]).map(publicRule),
    rouletteDrafts:(Array.isArray(drafts)?drafts:[]).map(publicRouletteDraft),
    agentDevices:Array.isArray(devices)?devices:[],
    assets:NATIVE_ROULETTE_ASSETS.map(publicNativeRouletteAsset),
    rouletteActivationAvailable:false,
    actionRulesAlreadyServerBacked:true
  };
}

async function handleProductControlState(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const session=await requireCapabilityLive(req,res,'data:read');if(!session)return;
  try{return res.status(200).json(await loadProductControlState(session))}
  catch(error){
    console.error('[product-control] bootstrap failed',{name:error?.name||'Error',status:error?.status||null});
    return res.status(error?.status===403?403:502).json({message:'룰렛·액션 설정을 불러오지 못했습니다.'});
  }
}

async function handleWeflabPublicImport(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const session=await requireCapabilityLive(req,res,'data:write');if(!session)return;
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  try{
    const result=await fetchWeflabPublicRoulette(body.url);
    return res.status(200).json({...result,requiresNewRouletteName:true});
  }catch(error){
    if(error instanceof WeflabPublicImportError)return res.status(error.status).json({message:error.message,code:error.code});
    console.error('[weflab-public-import] failed',{name:error?.name||'Error'});
    return res.status(502).json({message:'위플랩 공개 페이지를 불러오지 못했습니다.'});
  }
}

async function handleRouletteDraft(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const capability=req.method==='GET'?'data:read':req.method==='DELETE'?'data:delete':'data:write';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  if(req.method==='GET')return handleProductControlState(req,res);
  if(rejectMaintenanceWrite(req,res))return;
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  const requestedId=String(body.id||req.query?.id||'').trim().toLowerCase();
  if(req.method==='DELETE'){
    if(!UUID_PATTERN.test(requestedId))return res.status(400).json({message:'룰렛 초안 ID가 올바르지 않습니다.'});
    const removed=await sb('byeollog_roulette_drafts',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}`,{method:'DELETE',prefer:'return=representation'});
    if(!Array.isArray(removed)||removed.length!==1)return res.status(404).json({message:'룰렛 초안을 찾지 못했습니다.'});
    await removeDraftAssetsBestEffort(rouletteAssetPaths(removed[0]?.draft),'delete');
    return res.status(200).json({ok:true,id:requestedId});
  }
  if(req.method!=='POST'&&req.method!=='PATCH')return res.status(405).json({message:'Method not allowed'});
  try{
    const draft=normalizeNativeRouletteWebDraft(body.draft||body);
    await verifyDraftCustomAssets(workspaceId,draft);
    const rouletteName=String(body.rouletteName||draft.name||'').trim();
    if(!rouletteName||rouletteName.length>120)return res.status(400).json({message:'룰렛명을 1~120자로 입력해주세요.'});
    draft.name=rouletteName;
    const sourceKind=body.sourceKind==='weflab_public'?'weflab_public':'manual';
    const sourceUrl=sourceKind==='weflab_public'?normalizeWeflabPublicUrl(body.sourceUrl):null;
    const sourceFingerprint=sourceKind==='weflab_public'?String(body.sourceFingerprint||'').trim().toLowerCase():null;
    if(sourceKind==='weflab_public'&&!/^[0-9a-f]{64}$/.test(sourceFingerprint))return res.status(400).json({message:'가져온 룰렛 원본 확인값이 올바르지 않습니다.'});
    if(requestedId){
      if(!UUID_PATTERN.test(requestedId))return res.status(400).json({message:'룰렛 초안 ID가 올바르지 않습니다.'});
      const expected=Number(body.expectedVersion);
      if(!Number.isSafeInteger(expected)||expected<1)return res.status(400).json({message:'룰렛 초안 버전이 올바르지 않습니다.'});
      const previous=await sb('byeollog_roulette_drafts',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}&version_number=eq.${expected}&select=draft&limit=1`);
      if(!Array.isArray(previous)||previous.length!==1)return res.status(409).json({message:'다른 화면에서 룰렛이 변경되었습니다. 새로고침 후 다시 저장해주세요.'});
      const updated=await sb('byeollog_roulette_drafts',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}&version_number=eq.${expected}`,{method:'PATCH',body:{roulette_name:rouletteName,draft,public_visible:body.publicVisible===true,source_kind:sourceKind,source_url:sourceUrl,source_fingerprint:sourceFingerprint,version_number:expected+1,updated_at:new Date().toISOString()},prefer:'return=representation'});
      if(!Array.isArray(updated)||updated.length!==1)return res.status(409).json({message:'다른 화면에서 룰렛이 변경되었습니다. 새로고침 후 다시 저장해주세요.'});
      const retained=new Set(rouletteAssetPaths(draft));
      await removeDraftAssetsBestEffort(rouletteAssetPaths(previous[0].draft).filter(path=>!retained.has(path)),'replace');
      return res.status(200).json({ok:true,draft:publicRouletteDraft(updated[0])});
    }
    const inserted=await sb('byeollog_roulette_drafts','?select=*',{method:'POST',body:{workspace_id:workspaceId,roulette_name:rouletteName,draft,public_visible:body.publicVisible===true,source_kind:sourceKind,source_url:sourceUrl,source_fingerprint:sourceFingerprint,created_by_user_id:session.user_id||null},prefer:'return=representation'});
    if(!Array.isArray(inserted)||inserted.length!==1)throw new Error('draft insert failed');
    return res.status(201).json({ok:true,draft:publicRouletteDraft(inserted[0])});
  }catch(error){
    if(error instanceof NativeRouletteValidationError||error instanceof WeflabPublicImportError||error instanceof RouletteAssetError)return res.status(error.status).json({message:error.message,code:error.code});
    console.error('[roulette-draft] save failed',{name:error?.name||'Error',status:error?.status||null});
    return res.status(error?.status===404?503:500).json({message:error?.status===404?'룰렛 초안 저장소가 아직 준비되지 않았습니다.':'룰렛 초안을 저장하지 못했습니다.'});
  }
}

async function handleProductControlPage(req,res,section){
  const session=await requireCapabilityLive(req,res,'data:read');if(!session)return;
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  const nonce=crypto.randomBytes(18).toString('base64url');
  const assetOrigin=rouletteAssetOrigin();
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'none'; img-src 'self' data: ${assetOrigin}; connect-src 'self' ${assetOrigin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send(getProductDashboardHtml(nonce,section));
}

export default async function handler(req,res){
  if(rejectMaintenanceWrite(req,res))return;
  const operation=String(req.query?.operation||'');
  if(operation==='signup-applications')return handleSignupApplications(req,res);
  if(operation==='inquiries')return handleInquiryAdmin(req,res);
  if(operation==='withdraw')return handleAccountWithdraw(req,res);
  const session=getSession(req);
  if(!session){
    res.setHeader('Cache-Control','no-store');
    if(operation==='context'||operation==='agent-rollout-status')return res.status(401).json({message:'Unauthorized'});
    res.setHeader('Location','/login?expired=1');
    return res.status(302).end();
  }

  if(operation==='dashboard-bootstrap')return handleDashboardBootstrap(req,res);
  if(operation==='agent-rollout-status')return handleAgentRolloutStatus(req,res);
  if(operation==='product-control-state')return handleProductControlState(req,res);
  if(operation==='weflab-public-import')return handleWeflabPublicImport(req,res);
  if(operation==='roulette-image-upload-ticket'||operation==='roulette-image-confirm')return handleRouletteAsset(req,res,operation);
  if(operation==='roulette-draft')return handleRouletteDraft(req,res);
  if(String(req.query?.view||'')==='agent-rollout')return handleAgentRolloutPage(req,res);
  if(['roulette','actions'].includes(String(req.query?.view||'')))return handleProductControlPage(req,res,String(req.query.view));

  if(operation==='context'){
    res.setHeader('Cache-Control','no-store, private');
    const liveSession=await requireCapabilityLive(req,res,'data:read');
    if(!liveSession)return;
    try{
      const workspaceId=await workspaceForSession(liveSession);
      if(!workspaceId)return res.status(200).json({streamer_name:'관리자'});
      const rows=await sb('byeollog_workspaces',`?select=display_name,slug,public_page_enabled&id=eq.${q(workspaceId)}&limit=1`);
      const row=Array.isArray(rows)?rows[0]:null;
      const streamerName=String(row?.display_name||'').trim();
      const slug=String(row?.slug||'').trim();
      const enabled=row?.public_page_enabled!==false;
      return res.status(200).json({
        streamer_name:streamerName||'관리자',
        workspace_slug:slug||null,
        public_page_enabled:enabled,
        public_page_path:slug?`/u/${encodeURIComponent(slug)}`:null,
        email:liveSession.email||null,
        user_id:liveSession.user_id||null,
        role:liveSession.role||null,
        mode:liveSession.mode||null
      });
    }catch(e){
      return res.status(200).json({streamer_name:'관리자'});
    }
  }

  if(operation==='viewer-page'){
    res.setHeader('Cache-Control','no-store, private');
    res.setHeader('Content-Type','application/json; charset=utf-8');
    const capability=(req.method==='PATCH'||req.method==='POST')?'data:write':'data:read';
    const liveSession=await requireCapabilityLive(req,res,capability);
    if(!liveSession)return;
    try{
      const workspaceId=await workspaceForSession(liveSession);
      if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
      if(req.method==='GET'){
        const rows=await sb('byeollog_workspaces',`?select=id,slug,display_name,public_page_enabled,status&id=eq.${q(workspaceId)}&limit=1`);
        const row=Array.isArray(rows)?rows[0]:null;
        if(!row)return res.status(404).json({message:'워크스페이스를 찾을 수 없습니다.'});
        const slug=String(row.slug||'').trim();
        const enabled=row.public_page_enabled!==false;
        return res.status(200).json({
          ok:true,
          workspace_id:row.id,
          slug,
          display_name:row.display_name||'',
          public_page_enabled:enabled,
          public_page_path:slug?`/u/${encodeURIComponent(slug)}`:null
        });
      }
      if(req.method==='PATCH'||req.method==='POST'){
        const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
        if(typeof body.public_page_enabled!=='boolean')
          return res.status(400).json({message:'public_page_enabled(boolean)가 필요합니다.'});
        await sb('byeollog_workspaces',`?id=eq.${q(workspaceId)}`,{
          method:'PATCH',
          body:{public_page_enabled:body.public_page_enabled}
        });
        const rows=await sb('byeollog_workspaces',`?select=slug,display_name,public_page_enabled&id=eq.${q(workspaceId)}&limit=1`);
        const row=Array.isArray(rows)?rows[0]:null;
        const slug=String(row?.slug||'').trim();
        return res.status(200).json({
          ok:true,
          public_page_enabled:row?.public_page_enabled!==false,
          slug,
          public_page_path:slug?`/u/${encodeURIComponent(slug)}`:null
        });
      }
      return res.status(405).json({message:'Method not allowed'});
    }catch(e){
      return res.status(500).json({message:'시청자 페이지 설정 처리에 실패했습니다.'});
    }
  }

  const pageStartedAt=performance.now();
  const liveSession=await requireCapabilityLive(req,res,'data:read');
  if(!liveSession)return;
  let initialBootstrap=null;
  try{
    initialBootstrap=await loadDashboardBootstrapData(liveSession);
    res.setHeader('Server-Timing',`dashboard-embedded;dur=${(performance.now()-pageStartedAt).toFixed(1)}`);
    logDashboardTiming('embedded',pageStartedAt,initialBootstrap);
  }catch(e){
    console.error('[dashboard-embedded] preload failed',{name:e?.name||'Error',status:e?.status||null});
  }

  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','no-referrer');
  const nonce=crypto.randomBytes(18).toString('base64url');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'none'; script-src 'nonce-${nonce}'; script-src-elem 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self'; style-src-elem 'self' 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`
  );
  res.setHeader('Content-Type','text/html; charset=utf-8');
  const decoded=Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8');
  const bootstrapScript=initialBootstrap
    ?`<script nonce="${nonce}">window.__BYEOLLOG_DASHBOARD_BOOTSTRAP__=${serializeInlineJson(initialBootstrap)};</script>`
    :'';
  const html=rewriteInlineEventHandlers(decoded)
    .replace(/<script(\s|>)/g,`<script nonce="${nonce}"$1`)
    .replace(/<style(\s|>)/g,`<style nonce="${nonce}"$1`)
    .replace('</head>',`${bootstrapScript}</head>`);
  return res.status(200).send(html);
}
