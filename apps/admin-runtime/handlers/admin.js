import {sendDashboardShell,prepareDashboardContent,wantsDashboardShell} from '../lib/dashboard-shell.js';
import {reverseFanDayRequest,reverseFanDayError} from '../lib/reverse-fan-day.js';
import {rouletteExceptionsRequest,exceptionError} from '../lib/roulette-exceptions.js';
import {uxControlsRequest,uxError} from '../lib/ux-controls.js';
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
import {getRouletteClassificationHtml} from '../lib/roulette-classification-html.js';
import {fetchWeflabPublicRoulette,WeflabPublicImportError,normalizeWeflabPublicUrl} from '../lib/weflab-public-roulette-import.js';
import {
  SignatureBalloonValidationError,normalizeSignatureBalloonInput,
  signatureBalloonAssetPaths,SIGNATURE_BALLOON_MAX_ITEMS
} from '../lib/signature-balloon-registry.js';
import {
  createSignatureAssetUploadTicket,verifySignatureAssetUpload,
  deriveSignatureWallpaperAsset,
  hydrateSignatureAssetPreview,hydrateSignatureAssetPreviews,removeSignatureAssets,signatureAssetOrigin
} from '../lib/signature-balloon-assets.js';
import {
  DEFAULT_DONATION_IMAGE_MAX_ITEMS,defaultDonationImageAssetPaths,
  defaultDonationImageRangesOverlap,normalizeDefaultDonationImageInput
} from '../lib/default-donation-images.js';
import {isJsonRequest,isTrustedMutationOrigin} from '../lib/request-origin.js';
import {loadWallpaperState} from '../lib/wallpaper-service.js';
import {createWallpaperImageMask} from '../lib/wallpaper-image-mask.js';
import {WALLPAPER_CANVAS_HEIGHT,WALLPAPER_CANVAS_WIDTH,WALLPAPER_EDITOR_MARGIN_X,WALLPAPER_EDITOR_MARGIN_Y} from '../lib/wallpaper-layout.js';

const UUID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DASHBOARD_NAVIGATION_AUTH={navigation:true,loginPath:'/login?expired=1',retryPath:'/login?check=retry'};
const WALLPAPER_LAYOUT_SAVE_PROTOCOL=3;
const CONNECTION_STATUS_ADMIN_EMAIL='redacted-contact@example.invalid';
const wallpaperLayoutWrites=new Map();

export async function serializeWallpaperLayoutWrite(workspaceId,payload,write){
  const key=String(workspaceId);
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
  const active=wallpaperLayoutWrites.get(key);
  if(active?.fingerprint===fingerprint)return active.promise;
  const promise=Promise.resolve(active?.promise).catch(()=>{}).then(write);
  const entry={fingerprint,promise};
  wallpaperLayoutWrites.set(key,entry);
  try{return await promise}
  finally{if(wallpaperLayoutWrites.get(key)===entry)wallpaperLayoutWrites.delete(key)}
}

function isConnectionStatusAdmin(session){
  return isPlatformAdmin(session)&&String(session?.email||'').trim().toLowerCase()===CONNECTION_STATUS_ADMIN_EMAIL;
}

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
  if(!isConnectionStatusAdmin(liveSession))return res.status(403).json({message:'사이트 관리자만 사용할 수 있습니다.'});
  try{
    const workspaceId=await workspaceForSession(liveSession);
    if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
    const includeAll=isPlatformAdmin(liveSession);
    const scopeFilter=includeAll?'':`&workspace_id=eq.${encodeURIComponent(workspaceId)}`;
    const [raw,release,coreControls,gatewaySessions]=await Promise.all([
      sb('rpc/get_agent_rollout_dashboard_v2','',{
        method:'POST',
        body:{p_workspace_id:workspaceId,p_include_all_workspaces:includeAll,p_recent_limit:50},
        signal:AbortSignal.timeout(10000)
      }),
      loadStableAgentRelease(),
      sb('byeollog_soop_runtime_controls',`?select=workspace_id,gateway_enabled,core_collection_enabled${scopeFilter}&order=workspace_id`,{signal:AbortSignal.timeout(10000)}),
      sb('byeollog_soop_gateway_sessions',`?select=workspace_id,state,heartbeat_at,last_event_at,last_error_code,connected_at${scopeFilter}&order=workspace_id`,{signal:AbortSignal.timeout(10000)})
    ]);
    return res.status(200).json(sanitizeAgentRolloutSnapshot(raw,release,{controls:coreControls,sessions:gatewaySessions}));
  }catch(error){
    console.error('[agent-rollout] status failed',{name:error?.name||'Error',status:error?.status||null});
    return res.status(502).json({message:'Agent 배포 현황을 불러오지 못했습니다.'});
  }
}

async function handleAgentRolloutPage(req,res){
  const liveSession=await requireCapabilityLive(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH);
  if(!liveSession)return;
  if(!isConnectionStatusAdmin(liveSession))return res.status(403).send('사이트 관리자만 사용할 수 있습니다.');
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

async function publicSignatureBalloon(row,workspaceId){
  const pcImage=await hydrateSignatureAssetPreview(workspaceId,row.pc_image,'pc');
  return {
    id:row.id,balloonCount:row.balloon_count,displayName:row.display_name,
    pcImage,versionNumber:row.version_number,
    createdAt:row.created_at,updatedAt:row.updated_at
  };
}

async function publicSignatureBalloons(rows,workspaceId){
  const source=Array.isArray(rows)?rows:[];
  const previews=await hydrateSignatureAssetPreviews(workspaceId,source.map(row=>({kind:'pc',reference:row.pc_image})));
  let cursor=0;
  return source.map(row=>{
    const pcImage=previews[cursor++];
    return {
      id:row.id,balloonCount:row.balloon_count,displayName:row.display_name,
      pcImage,versionNumber:row.version_number,
      createdAt:row.created_at,updatedAt:row.updated_at
    };
  });
}

async function backfillMissingSignatureWallpapers(rows,workspaceId){
  const source=Array.isArray(rows)?rows:[];
  const pending=source.filter(row=>!row.wallpaper_image&&row.pc_image).slice(0,4);
  await Promise.all(pending.map(async row=>{
    let reference=null;
    try{
      const derived=await deriveSignatureWallpaperAsset(workspaceId,row.pc_image);
      const {previewUrl:_previewUrl,...safeReference}=derived;
      reference=safeReference;
      const updated=await sb('byeollog_signature_balloons',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(row.id)}&wallpaper_image=is.null`,{
        method:'PATCH',prefer:'return=representation',body:{wallpaper_image:reference}
      });
      if(Array.isArray(updated)&&updated.length===1)row.wallpaper_image=reference;
      else await removeSignatureAssetsBestEffort([reference.storagePath],'wallpaper-backfill-race');
    }catch(error){
      if(reference?.storagePath)await removeSignatureAssetsBestEffort([reference.storagePath],'wallpaper-backfill-failed');
      console.error('[signature-balloon] wallpaper backfill failed',{name:error?.name||'Error',status:error?.status||null});
    }
  }));
  return source;
}

async function removeSignatureAssetsBestEffort(paths,context){
  try{await removeSignatureAssets(paths)}
  catch(error){console.error('[signature-balloon] asset cleanup failed',{context,name:error?.name||'Error',status:error?.status||null})}
}

async function handleSignatureAsset(req,res,operation){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  const session=await requireCapabilityLive(req,res,'data:write');if(!session)return;
  if(!requireSafeJsonMutation(req,res))return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  try{
    if(operation==='signature-image-upload-ticket'||operation==='default-donation-image-upload-ticket')return res.status(200).json(await createSignatureAssetUploadTicket(workspaceId,body));
    const image=await verifySignatureAssetUpload(workspaceId,body.path,body.kind);
    return res.status(200).json({ok:true,image});
  }catch(error){
    if(error instanceof SignatureBalloonValidationError)return res.status(error.status||400).json({message:error.message,code:error.code});
    console.error('[signature-balloon] image operation failed',{operation,name:error?.name||'Error',status:error?.status||null});
    return res.status(502).json({message:'시그풍 이미지를 처리하지 못했습니다.'});
  }
}

async function publicDefaultDonationImages(rows,workspaceId){
  const source=Array.isArray(rows)?rows:[];
  const previews=await hydrateSignatureAssetPreviews(workspaceId,source.map(row=>({kind:'default-pc',reference:row.pc_image})));
  let cursor=0;
  return source.map(row=>({
    id:row.id,minAmount:row.min_amount,maxAmount:row.max_amount,
    pcImage:previews[cursor++],wallpaperImage:null,
    versionNumber:row.version_number,createdAt:row.created_at,updatedAt:row.updated_at
  }));
}

async function verifyDefaultDonationImageAssets(workspaceId,normalized){
  const verified=await verifySignatureAssetUpload(workspaceId,normalized.pcImage.storagePath,'default-pc');
  const {previewUrl:_preview,...pcImage}=verified;
  return {...normalized,pcImage,wallpaperImage:null};
}

async function handleDefaultDonationImageRegistry(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const capability=req.method==='GET'?'data:read':req.method==='DELETE'?'data:delete':'data:write';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  if(req.method==='GET'){
    try{
      const rows=await sb('byeollog_default_donation_images',`?workspace_id=eq.${q(workspaceId)}&select=id,min_amount,max_amount,pc_image,wallpaper_image,version_number,created_at,updated_at&order=min_amount.asc&limit=${DEFAULT_DONATION_IMAGE_MAX_ITEMS}`);
      return res.status(200).json({ok:true,items:await publicDefaultDonationImages(rows,workspaceId)});
    }catch(error){
      console.error('[default-donation-image] registry load failed',{name:error?.name||'Error',status:error?.status||null});
      return res.status(error?.status===404?503:502).json({message:error?.status===404?'기본 후원 이미지 저장소가 아직 준비되지 않았습니다.':'기본 후원 이미지 목록을 불러오지 못했습니다.'});
    }
  }
  if(req.method!=='POST'&&req.method!=='PATCH'&&req.method!=='DELETE')return res.status(405).json({message:'Method not allowed'});
  if(rejectMaintenanceWrite(req,res))return;
  if(!requireSafeJsonMutation(req,res))return;
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  const requestedId=String(body.id||req.query?.id||'').trim().toLowerCase();
  try{
    if(req.method==='DELETE'){
      if(!UUID_PATTERN.test(requestedId))throw new SignatureBalloonValidationError('기본 후원 이미지 ID가 올바르지 않습니다.');
      const removed=await sb('byeollog_default_donation_images',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}`,{method:'DELETE',prefer:'return=representation'});
      if(!Array.isArray(removed)||removed.length!==1)return res.status(404).json({message:'기본 후원 이미지를 찾지 못했습니다.'});
      await removeSignatureAssetsBestEffort(defaultDonationImageAssetPaths({pcImage:removed[0].pc_image,wallpaperImage:removed[0].wallpaper_image}),'default-delete');
      return res.status(200).json({ok:true,id:requestedId});
    }
    const base=normalizeDefaultDonationImageInput(body,workspaceId);
    const existing=await sb('byeollog_default_donation_images',`?workspace_id=eq.${q(workspaceId)}&select=id,min_amount,max_amount&order=min_amount.asc&limit=${DEFAULT_DONATION_IMAGE_MAX_ITEMS}`);
    if((Array.isArray(existing)?existing:[]).some(row=>row.id!==requestedId&&defaultDonationImageRangesOverlap(base,row)))return res.status(409).json({message:'이미 등록된 다른 기본 이미지 범위와 겹칩니다.'});
    const normalized=await verifyDefaultDonationImageAssets(workspaceId,base);
    if(req.method==='PATCH'){
      if(!UUID_PATTERN.test(requestedId))throw new SignatureBalloonValidationError('기본 후원 이미지 ID가 올바르지 않습니다.');
      const expected=Number(body.expectedVersion);
      if(!Number.isSafeInteger(expected)||expected<1)throw new SignatureBalloonValidationError('기본 후원 이미지 버전이 올바르지 않습니다.');
      const previous=await sb('byeollog_default_donation_images',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}&version_number=eq.${expected}&select=pc_image,wallpaper_image&limit=1`);
      if(!Array.isArray(previous)||previous.length!==1)return res.status(409).json({message:'다른 화면에서 설정이 변경되었습니다. 새로고침 후 다시 저장해주세요.'});
      const updated=await sb('byeollog_default_donation_images',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}&version_number=eq.${expected}`,{method:'PATCH',prefer:'return=representation',body:{min_amount:normalized.minAmount,max_amount:normalized.maxAmount,pc_image:normalized.pcImage,wallpaper_image:normalized.wallpaperImage,version_number:expected+1,updated_at:new Date().toISOString()}});
      if(!Array.isArray(updated)||updated.length!==1)return res.status(409).json({message:'다른 화면에서 설정이 변경되었습니다. 새로고침 후 다시 저장해주세요.'});
      const retained=new Set(defaultDonationImageAssetPaths(normalized));
      await removeSignatureAssetsBestEffort(defaultDonationImageAssetPaths({pcImage:previous[0].pc_image,wallpaperImage:previous[0].wallpaper_image}).filter(path=>!retained.has(path)),'default-replace');
      return res.status(200).json({ok:true,items:await publicDefaultDonationImages(updated,workspaceId)});
    }
    if(Array.isArray(existing)&&existing.length>=DEFAULT_DONATION_IMAGE_MAX_ITEMS)return res.status(409).json({message:`기본 후원 이미지는 최대 ${DEFAULT_DONATION_IMAGE_MAX_ITEMS}개까지 등록할 수 있습니다.`});
    const inserted=await sb('byeollog_default_donation_images','?select=*',{method:'POST',prefer:'return=representation',body:{workspace_id:workspaceId,min_amount:normalized.minAmount,max_amount:normalized.maxAmount,pc_image:normalized.pcImage,wallpaper_image:normalized.wallpaperImage,created_by_user_id:session.user_id||null}});
    return res.status(201).json({ok:true,items:await publicDefaultDonationImages(inserted,workspaceId)});
  }catch(error){
    if(error instanceof SignatureBalloonValidationError)return res.status(error.status||400).json({message:error.message,code:error.code});
    if(error?.code==='23P01')return res.status(409).json({message:'이미 등록된 다른 기본 이미지 범위와 겹칩니다.'});
    console.error('[default-donation-image] registry mutation failed',{method:req.method,name:error?.name||'Error',status:error?.status||null,code:error?.code||null});
    return res.status(error?.status===404?503:500).json({message:error?.status===404?'기본 후원 이미지 저장소가 아직 준비되지 않았습니다.':'기본 후원 이미지를 저장하지 못했습니다.'});
  }
}

async function verifySignatureBalloonAssets(workspaceId,normalized){
  const pcImage=await verifySignatureAssetUpload(workspaceId,normalized.pcImage.storagePath,'pc');
  const {previewUrl:_pcPreview,...pcReference}=pcImage;
  const wallpaperImage=await deriveSignatureWallpaperAsset(workspaceId,pcReference);
  const wallpaperReference=Object.fromEntries(Object.entries(wallpaperImage).filter(([key])=>key!=='previewUrl'));
  return {...normalized,pcImage:pcReference,mobileImage:null,wallpaperImage:wallpaperReference};
}

async function handleSignatureBalloonRegistry(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  const capability=req.method==='GET'?'data:read':req.method==='DELETE'?'data:delete':'data:write';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'Workspace not resolved'});
  if(req.method==='GET'){
    try{
      const rows=await sb('byeollog_signature_balloons',`?workspace_id=eq.${q(workspaceId)}&select=id,balloon_count,display_name,pc_image,wallpaper_image,version_number,created_at,updated_at&order=balloon_count.asc&limit=${SIGNATURE_BALLOON_MAX_ITEMS}`);
      await backfillMissingSignatureWallpapers(rows,workspaceId);
      return res.status(200).json({ok:true,items:await publicSignatureBalloons(rows,workspaceId)});
    }catch(error){
      console.error('[signature-balloon] registry load failed',{name:error?.name||'Error',status:error?.status||null});
      return res.status(error?.status===404?503:502).json({message:error?.status===404?'시그풍 등록 저장소가 아직 준비되지 않았습니다.':'시그풍 목록을 불러오지 못했습니다.'});
    }
  }
  if(req.method!=='POST'&&req.method!=='PATCH'&&req.method!=='DELETE')return res.status(405).json({message:'Method not allowed'});
  if(rejectMaintenanceWrite(req,res))return;
  if(!requireSafeJsonMutation(req,res))return;
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  const requestedId=String(body.id||req.query?.id||'').trim().toLowerCase();
  try{
    if(req.method==='DELETE'){
      if(!UUID_PATTERN.test(requestedId))throw new SignatureBalloonValidationError('시그풍 ID가 올바르지 않습니다.');
      const removed=await sb('byeollog_signature_balloons',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}`,{method:'DELETE',prefer:'return=representation'});
      if(!Array.isArray(removed)||removed.length!==1)return res.status(404).json({message:'시그풍을 찾지 못했습니다.'});
      await removeSignatureAssetsBestEffort(signatureBalloonAssetPaths({pcImage:removed[0].pc_image,mobileImage:removed[0].mobile_image,wallpaperImage:removed[0].wallpaper_image}),'delete');
      return res.status(200).json({ok:true,id:requestedId});
    }
    const normalized=await verifySignatureBalloonAssets(workspaceId,normalizeSignatureBalloonInput(body,workspaceId));
    if(req.method==='PATCH'){
      if(!UUID_PATTERN.test(requestedId))throw new SignatureBalloonValidationError('시그풍 ID가 올바르지 않습니다.');
      const expected=Number(body.expectedVersion);
      if(!Number.isSafeInteger(expected)||expected<1)throw new SignatureBalloonValidationError('시그풍 버전이 올바르지 않습니다.');
      const previous=await sb('byeollog_signature_balloons',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}&version_number=eq.${expected}&select=pc_image,mobile_image,wallpaper_image&limit=1`);
      if(!Array.isArray(previous)||previous.length!==1)return res.status(409).json({message:'다른 화면에서 시그풍이 변경되었습니다. 새로고침 후 다시 저장해주세요.'});
      const updated=await sb('byeollog_signature_balloons',`?workspace_id=eq.${q(workspaceId)}&id=eq.${q(requestedId)}&version_number=eq.${expected}`,{method:'PATCH',prefer:'return=representation',body:{balloon_count:normalized.balloonCount,display_name:normalized.displayName,pc_image:normalized.pcImage,mobile_image:normalized.mobileImage,wallpaper_image:normalized.wallpaperImage,version_number:expected+1,updated_at:new Date().toISOString()}});
      if(!Array.isArray(updated)||updated.length!==1)return res.status(409).json({message:'다른 화면에서 시그풍이 변경되었습니다. 새로고침 후 다시 저장해주세요.'});
      const retained=new Set(signatureBalloonAssetPaths(normalized));
      await removeSignatureAssetsBestEffort(signatureBalloonAssetPaths({pcImage:previous[0].pc_image,mobileImage:previous[0].mobile_image,wallpaperImage:previous[0].wallpaper_image}).filter(path=>!retained.has(path)),'replace');
      return res.status(200).json({ok:true,item:await publicSignatureBalloon(updated[0],workspaceId)});
    }
    const existing=await sb('byeollog_signature_balloons',`?workspace_id=eq.${q(workspaceId)}&select=id&limit=${SIGNATURE_BALLOON_MAX_ITEMS}`);
    if(Array.isArray(existing)&&existing.length>=SIGNATURE_BALLOON_MAX_ITEMS)return res.status(409).json({message:`시그풍은 최대 ${SIGNATURE_BALLOON_MAX_ITEMS}개까지 등록할 수 있습니다.`});
    const inserted=await sb('byeollog_signature_balloons','?select=*',{method:'POST',prefer:'return=representation',body:{workspace_id:workspaceId,balloon_count:normalized.balloonCount,display_name:normalized.displayName,pc_image:normalized.pcImage,mobile_image:normalized.mobileImage,wallpaper_image:normalized.wallpaperImage,created_by_user_id:session.user_id||null}});
    if(!Array.isArray(inserted)||inserted.length!==1)throw new Error('signature balloon insert failed');
    return res.status(201).json({ok:true,item:await publicSignatureBalloon(inserted[0],workspaceId)});
  }catch(error){
    if(error instanceof SignatureBalloonValidationError)return res.status(error.status||400).json({message:error.message,code:error.code});
    if(error?.code==='23505')return res.status(409).json({message:'이미 같은 별풍선 개수로 등록된 시그풍이 있습니다.'});
    console.error('[signature-balloon] registry mutation failed',{method:req.method,name:error?.name||'Error',status:error?.status||null,code:error?.code||null});
    return res.status(error?.status===404?503:500).json({message:error?.status===404?'시그풍 등록 저장소가 아직 준비되지 않았습니다.':'시그풍을 저장하지 못했습니다.'});
  }
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
    rouletteActivationAvailable:true,
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

async function handleWallpaperImageMask(req,res){
  if(req.method!=='POST'){
    res.setHeader('Cache-Control','no-store');
    return res.status(405).json({message:'Method not allowed'});
  }
  if(!requireSafeJsonMutation(req,res))return;
  const session=await requireCapabilityLive(req,res,'data:read');if(!session)return;
  try{
    const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
    const result=await createWallpaperImageMask(body.url);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store, private');
    return res.status(200).json({width:result.width,height:result.height,maskWidth:result.maskWidth,maskHeight:result.maskHeight,alpha:result.alpha,density:result.density});
  }catch(error){
    res.setHeader('Cache-Control','no-store');
    return res.status(Number(error?.status)||500).json({message:error?.message||'풍벽지 이미지를 분석하지 못했습니다.'});
  }
}

async function handleWallpaperControl(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(!['GET','POST'].includes(req.method))return res.status(405).json({message:'Method not allowed'});
  if(req.method==='POST')return res.status(410).json({message:'풍벽지 배치는 별록 풍벽지 프로그램에서만 편집할 수 있습니다.',code:'wallpaper_editor_agent_only'});
  if(req.method==='POST'&&!requireSafeJsonMutation(req,res))return;
  const capability=req.method==='POST'?'data:write':'data:read';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  try{
    const state=await loadWallpaperState(workspaceId,{authorizedUserId:session.user_id,readConsistentSnapshot:true});
    const overlayUrl='http://127.0.0.1:43120/overlay/wallpaper';
    return res.status(200).json({ok:true,...state,overlayUrl,overlayAvailable:true,localAgentOverlay:true,retentionDays:7,maxVisibleTiles:216,layoutSaveProtocol:WALLPAPER_LAYOUT_SAVE_PROTOCOL});
  }catch(error){
    if(error?.code==='40001'||error?.code==='PT409')return res.status(409).json({message:'다른 변경 사항이 먼저 저장되었습니다. 최신 상태를 확인한 뒤 다시 저장해주세요.',code:'wallpaper_revision_conflict'});
    if(error?.code==='P0002')return res.status(409).json({message:'풍벽지 회차 구성이 바뀌었습니다. 새로고침 후 다시 시도해주세요.',code:'wallpaper_session_changed'});
    console.error('[wallpaper-control] failed',{code:error?.code||'wallpaper_control_failed'});
    return res.status(502).json({message:'풍벽지 상태를 처리하지 못했습니다.'});
  }
}

function firstRow(value){return Array.isArray(value)?value[0]||null:null}
function ageMilliseconds(value,now=Date.now()){
  const parsed=Date.parse(value||'');
  return Number.isFinite(parsed)?Math.max(0,now-parsed):null;
}

async function loadSoopRuntimeStatus(liveSession){
  const workspaceId=await workspaceForSession(liveSession);
  if(!workspaceId)throw Object.assign(new Error('workspace unavailable'),{status:403});
  const filter=q(workspaceId);
  const [connectionRows,controlRows,gatewayRows,serviceRows,activationRows,observationRows,incidentRows]=await Promise.all([
    sb('byeollog_soop_connections',`?workspace_id=eq.${filter}&select=status,access_token_expires_at,refreshed_at,last_error_code,updated_at&limit=1`),
    sb('byeollog_soop_runtime_controls',`?workspace_id=eq.${filter}&select=gateway_enabled,native_roulette_enabled,live_diagnostics_enabled,updated_at&limit=1`),
    sb('byeollog_soop_gateway_sessions',`?workspace_id=eq.${filter}&select=state,generation,reconnect_count,last_sequence,chat_number,token_expires_at,connected_at,last_event_at,heartbeat_at,last_error_code,updated_at&limit=1`),
    sb('byeollog_native_roulette_services',`?workspace_id=eq.${filter}&select=active_draft_id,active_draft_version,state,service_revision,overlay_token_version,sound_volume_percent,tts_volume_percent,activated_at,paused_at,updated_at&limit=1`).catch(error=>error?.status===404?[]:Promise.reject(error)),
    sb('byeollog_native_roulette_activations',`?workspace_id=eq.${filter}&select=draft_id,draft_version,trigger_amounts,activated_at,updated_at&order=activated_at.asc`).catch(error=>error?.status===404?[]:Promise.reject(error)),
    sb('byeollog_soop_event_observations',`?workspace_id=eq.${filter}&select=event_type,provider_occurred_at,gateway_received_at,server_received_at,normalized_at,roulette_committed_at,overlay_queued_at,tts_queued_at,action_queued_at,deduplicated,outcome,details&order=server_received_at.desc&limit=20`),
    sb('byeollog_soop_gateway_incidents',`?workspace_id=eq.${filter}&resolved_at=is.null&select=id,kind,opened_at,last_observed_at,last_heartbeat_at,last_reported_state&order=opened_at.desc&limit=1`).catch(error=>error?.status===404?[]:Promise.reject(error)),
  ]);
  const connection=firstRow(connectionRows),control=firstRow(controlRows),gateway=firstRow(gatewayRows),service=firstRow(serviceRows);
  const heartbeatAgeMs=ageMilliseconds(gateway?.heartbeat_at);
  const gatewayFreshLimitMs=gateway?.state==='connected'?150_000:10*60_000;
  const gatewayFresh=heartbeatAgeMs!==null&&heartbeatAgeMs<=gatewayFreshLimitMs;
  return {
    ok:true,
    connection:{
      connected:connection?.status==='connected',status:connection?.status||'not_connected',
      tokenExpiresAt:connection?.access_token_expires_at||null,refreshedAt:connection?.refreshed_at||null,
      lastErrorCode:connection?.last_error_code||null
    },
    control:{
      gatewayEnabled:control?.gateway_enabled===true,nativeRouletteEnabled:control?.native_roulette_enabled===true,
      liveDiagnosticsEnabled:control?.live_diagnostics_enabled!==false
    },
    service:service?{
      active:service.state==='active',state:service.state,activeDraftId:service.active_draft_id,
      activeDraftVersion:service.active_draft_version,serviceRevision:service.service_revision,
      soundVolumePercent:service.sound_volume_percent,ttsVolumePercent:service.tts_volume_percent,
      activatedAt:service.activated_at,pausedAt:service.paused_at,updatedAt:service.updated_at,
      activeDrafts:service.state==='active'?(Array.isArray(activationRows)?activationRows:[]).map(row=>({draftId:row.draft_id,draftVersion:row.draft_version,triggerAmounts:row.trigger_amounts||[],activatedAt:row.activated_at,updatedAt:row.updated_at})):[]
    }:{active:false,state:'not_configured',activeDraftId:null,activeDraftVersion:null,serviceRevision:0,activeDrafts:[]},
    gateway:gateway?{
      state:gatewayFresh?gateway.state:'stale',reportedState:gateway.state,fresh:gatewayFresh,heartbeatAgeMs,
      generation:gateway.generation,reconnectCount:gateway.reconnect_count,lastSequence:gateway.last_sequence,
      chatNumber:gateway.chat_number,connectedAt:gateway.connected_at,lastEventAt:gateway.last_event_at,
      heartbeatAt:gateway.heartbeat_at,lastErrorCode:gateway.last_error_code
    }:{state:'not_started',reportedState:null,fresh:false,heartbeatAgeMs:null},
    incident:firstRow(incidentRows)?{
      active:true,kind:firstRow(incidentRows).kind,openedAt:firstRow(incidentRows).opened_at,
      lastObservedAt:firstRow(incidentRows).last_observed_at,lastHeartbeatAt:firstRow(incidentRows).last_heartbeat_at,
      lastReportedState:firstRow(incidentRows).last_reported_state
    }:{active:false},
    observations:Array.isArray(observationRows)?observationRows:[]
  };
}

async function handleNativeRouletteService(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='POST')return res.status(405).json({message:'Method not allowed'});
  if(!requireSafeJsonMutation(req,res))return;
  const session=await requireCapabilityLive(req,res,'roulette:configure');if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  const action=String(body.action||'').trim();
  try{
    if(action==='pause'){
      const result=await sb('rpc/pause_native_roulette_service_v2','',{method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:session.user_id}});
      return res.status(200).json({ok:true,active:false,result,message:'룰렛 운영을 일시정지했습니다.'});
    }
    if(action==='deactivate'){
      const draftId=String(body.draftId||'').trim().toLowerCase();
      if(!UUID_PATTERN.test(draftId))return res.status(400).json({message:'방송에서 해제할 룰렛을 선택해주세요.'});
      const result=await sb('rpc/deactivate_native_roulette_draft_v3','',{method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:session.user_id,p_draft_id:draftId}});
      return res.status(200).json({ok:true,result,message:'이 룰렛을 방송에서 해제했습니다.'});
    }
    if(action==='rotate-overlay'){
      const version=await sb('rpc/rotate_native_roulette_overlay_token_v2','',{method:'POST',body:{p_workspace_id:workspaceId,p_authorized_user_id:session.user_id}});
      const token=createRouletteServiceOverlayToken(workspaceId,String(version).replace(/^"|"$/g,''));
      return res.status(200).json({ok:true,overlayUrl:rouletteOverlayUrl(token),message:'기존 오버레이 주소를 폐기하고 새 주소를 발급했습니다.'});
    }
    if(action==='overlay-url'){
      const rows=await sb('byeollog_native_roulette_services',`?workspace_id=eq.${q(workspaceId)}&select=state,overlay_token_version&limit=1`);
      const service=firstRow(rows);
      if(!service)return res.status(409).json({message:'먼저 방송에 적용할 룰렛을 선택해주세요.'});
      const token=createRouletteServiceOverlayToken(workspaceId,service.overlay_token_version);
      return res.status(200).json({ok:true,active:service.state==='active',overlayUrl:rouletteOverlayUrl(token)});
    }
    if(action==='donation-test'){
      const amount=Number(body.amount);
      const message=String(body.message??'').trim();
      if(!Number.isSafeInteger(amount)||amount<1||amount>1_000_000){
        return res.status(400).json({message:'테스트 별풍선 개수는 1~1,000,000 사이의 정수로 입력해주세요.'});
      }
      if(message.length>120||/[\u0000-\u001f\u007f]/.test(message)){
        return res.status(400).json({message:'후원 멘트는 줄바꿈 없이 120자까지 입력할 수 있습니다.'});
      }
      const occurredAt=new Date().toISOString();
      const eventId=`overlay-test:${crypto.randomUUID()}`;
      const rawEvent={eventId,actor:{id:'byeollog-overlay-test',name:'후원 테스트'},
        amount,message:message||null,imageUrl:null,occurredAt};
      const relay=normalizeSoopSdkRelayEnvelope({
        schemaVersion:SOOP_SDK_RELAY_SCHEMA_VERSION,provider:'soop',eventType:'donation',
        event:rawEvent,receivedAt:occurredAt,
        connection:{id:`dashboard-test:${workspaceId}`,sequence:Date.now(),reconnectCount:0},
        rawPayloadSha256:crypto.createHash('sha256').update(JSON.stringify(rawEvent),'utf8').digest('hex')
      });
      const {resultRow}=await ingestNormalizedSoopDonation(workspaceId,relay,{testMode:true});
      const spinCount=Math.max(0,Math.trunc(Number(resultRow.spinCount)||0));
      const presentationCount=Math.max(0,Math.trunc(Number(resultRow.presentationCount)||0));
      const ttsQueued=resultRow.ttsQueued===true;
      const queued=resultRow.queued===true||presentationCount>0||ttsQueued;
      return res.status(200).json({
        ok:true,testMode:true,queued,spinCount,presentationCount,ttsQueued,
        dataIsolation:resultRow.dataIsolation,
        message:queued
          ?'후원 테스트를 공통 OBS 오버레이에 전송했습니다.'
          :message
            ?'후원 멘트를 TTS 대기열에 넣지 못했습니다.'
            :'입력한 별풍선 개수에 표시할 이미지나 읽을 후원 멘트가 없습니다.'
      });
    }
    if(action!=='activate')return res.status(400).json({message:'룰렛 운영 요청이 올바르지 않습니다.'});
    const draftId=String(body.draftId||'').trim().toLowerCase();
    if(!UUID_PATTERN.test(draftId))return res.status(400).json({message:'방송에 적용할 룰렛을 선택해주세요.'});
    const filter=q(workspaceId);
    const [connections,drafts]=await Promise.all([
      sb('byeollog_soop_connections',`?workspace_id=eq.${filter}&status=eq.connected&select=workspace_id&limit=1`),
      sb('byeollog_roulette_drafts',`?workspace_id=eq.${filter}&id=eq.${q(draftId)}&select=id,roulette_name,version_number,draft&limit=1`)
    ]);
    if(!firstRow(connections))return res.status(409).json({message:'먼저 이 스트리머의 SOOP 계정을 연결해주세요.',code:'soop_connection_required'});
    const stored=firstRow(drafts);if(!stored)return res.status(404).json({message:'선택한 룰렛을 찾지 못했습니다.'});
    const snapshot=normalizeNativeRouletteWebDraft(stored.draft);
    await refreshSoopConnection(workspaceId,{force:false});
    const activated=await sb('rpc/activate_native_roulette_draft_v3','',{method:'POST',body:{
      p_workspace_id:workspaceId,p_authorized_user_id:session.user_id,p_draft_id:draftId,
      p_snapshot:snapshot,p_expected_draft_version:stored.version_number,
      p_sound_volume_percent:Math.max(0,Math.min(100,Math.trunc(Number(body.soundVolumePercent??80)))),
      p_tts_volume_percent:Math.max(0,Math.min(100,Math.trunc(Number(body.ttsVolumePercent??80))))
    }});
    const tokenVersion=activated?.overlayTokenVersion||activated?.overlay_token_version;
    const token=createRouletteServiceOverlayToken(workspaceId,tokenVersion);
    return res.status(200).json({ok:true,active:true,draftId,rouletteName:stored.roulette_name,
      serviceRevision:activated?.serviceRevision||activated?.service_revision,
      overlayUrl:rouletteOverlayUrl(token),
      activeRouletteCount:activated?.activeRouletteCount||activated?.active_roulette_count,
      message:'이 룰렛을 방송에 추가했습니다.'});
  }catch(error){
    if(error instanceof NativeRouletteValidationError)return res.status(error.status||400).json({message:error.message,code:error.code});
    if(action==='donation-test'&&error?.code==='P0001'){
      return res.status(429).json({message:'후원 테스트를 너무 빠르게 반복했습니다. 잠시 후 다시 시도해주세요.',code:'donation_test_rate_limited'});
    }
    if(action==='donation-test'&&error?.code==='55000'){
      return res.status(409).json({message:'먼저 방송에 적용할 룰렛을 선택해주세요.',code:'active_roulette_required'});
    }
    if(action==='activate'&&error?.code==='P0001'&&/draft version changed/i.test(error?.message||'')){
      return res.status(409).json({message:'다른 화면에서 룰렛이 변경되었습니다. 최신 내용을 불러온 뒤 다시 적용해주세요.',code:'roulette_draft_stale'});
    }
    if(action==='activate'&&error?.code==='23505'&&/trigger amount overlaps/i.test(error?.message||'')){
      return res.status(409).json({message:'같은 별풍선 개수를 사용하는 룰렛이 이미 방송에 적용되어 있습니다.',code:'roulette_trigger_overlap'});
    }
    console.error('[native-roulette-service] operation failed',{action,code:error?.code||'native_roulette_service_failed',status:error?.status||null});
    return res.status(error?.status===404?409:502).json({message:error?.status===404?'SOOP 연결을 다시 확인해주세요.':'룰렛 운영 상태를 변경하지 못했습니다.',code:error?.code||'native_roulette_service_failed'});
  }
}

async function handleSoopRuntimeStatus(req,res){
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('Content-Type','application/json; charset=utf-8');
  if(req.method!=='GET')return res.status(405).json({message:'Method not allowed'});
  const session=await requireCapabilityLive(req,res,'roulette:configure');if(!session)return;
  try{return res.status(200).json(await loadSoopRuntimeStatus(session))}
  catch(error){
    console.error('[soop-runtime-status] failed',{name:error?.name||'Error',status:error?.status||null});
    return res.status(error?.status===403?403:502).json({message:'SOOP 실시간 경로 상태를 불러오지 못했습니다.'});
  }
}

function requireSafeJsonMutation(req,res){
  if(!isTrustedMutationOrigin(req))return res.status(403).json({message:'허용되지 않은 요청 출처입니다.'}),false;
  if(!isJsonRequest(req))return res.status(415).json({message:'JSON 요청만 사용할 수 있습니다.'}),false;
  return true;
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

import {normalizeRouletteAmountMapping} from '../lib/roulette-amount-mapping.js';

async function handleRouletteClassificationRules(req,res){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Content-Type','application/json; charset=utf-8');
  const capability=req.method==='GET'?'data:read':req.method==='DELETE'?'data:delete':'data:write';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  if(req.method==='GET'){
    const rows=await sb('byeollog_roulette_amount_mappings',`?workspace_id=eq.${q(workspaceId)}&select=balloons,balloons_max,roulette_name,expected_spins,enabled,updated_at&order=balloons.asc`);
    return res.status(200).json({ok:true,rules:Array.isArray(rows)?rows:[]});
  }
  if(!['POST','PATCH','DELETE'].includes(req.method))return res.status(405).json({message:'Method not allowed'});
  if(!requireSafeJsonMutation(req,res))return;
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  try{
    if(req.method==='PATCH'){
      if(!Number.isSafeInteger(body.balloons)||body.balloons<1||body.balloons>1000000000||typeof body.enabled!=='boolean')return res.status(400).json({message:'별풍선 개수와 활성 상태를 확인해주세요.'});
      const rows=await sb('byeollog_roulette_amount_mappings',`?workspace_id=eq.${q(workspaceId)}&balloons=eq.${body.balloons}&select=balloons,enabled`,{method:'PATCH',body:{enabled:body.enabled,updated_at:new Date().toISOString()},prefer:'return=representation'});
      if(!Array.isArray(rows)||!rows.length)return res.status(404).json({message:'저장된 룰렛을 찾을 수 없습니다.'});
      return res.status(200).json({ok:true,rule:rows[0]});
    }
    if(req.method==='DELETE'){
      const mapping=normalizeRouletteAmountMapping(body.rule||body);
      await sb('byeollog_roulette_amount_mappings',`?workspace_id=eq.${q(workspaceId)}&balloons=eq.${mapping.balloons}`,{method:'DELETE',prefer:'return=minimal'});
      return res.status(200).json({ok:true});
    }
    if(Array.isArray(body.rules)&&body.rules.length>50)throw new Error('룰렛은 한 번에 최대 50개까지 저장할 수 있습니다.');
    const mappings=Array.isArray(body.rules)
      ?body.rules.map(normalizeRouletteAmountMapping)
      :[normalizeRouletteAmountMapping(body.rule||body)];
    if(!mappings.length)throw new Error('저장할 룰렛이 없습니다.');
    if(new Set(mappings.map(item=>item.balloons)).size!==mappings.length)throw new Error('같은 별풍선 개수는 한 번만 입력해주세요.');
    if(new Set(mappings.map(item=>Object.hasOwn(item,'expected_spins'))).size!==1)throw new Error('회전 수 항목을 모든 룰렛에 동일한 형식으로 입력해주세요.');
    const previous=body.replace?normalizeRouletteAmountMapping(body.replace):null;
    if(previous&&mappings.length!==1)throw new Error('수정할 룰렛은 하나만 입력해주세요.');
    await sb('rpc/byeollog_save_roulette_ranges_v1','',{method:'POST',body:{p_workspace_id:workspaceId,p_user_id:session.user_id,p_rules:mappings,p_previous:previous?.balloons??null}});
    const mapping=mappings[0];
    return res.status(200).json({ok:true,rule:mapping,rules:mappings});
  }catch(error){if(error?.code==='23P01')return res.status(409).json({message:'다른 룰렛과 별풍선 범위가 겹칩니다. 최소·최대 개수를 확인해주세요.'});if(error?.code==='PT409')return res.status(409).json({message:'룰렛 설정이 변경되었습니다. 새로고침 후 다시 수정해주세요.'});if(req.method==='PATCH')return res.status(502).json({message:'활성 상태를 저장하지 못했습니다. 다시 시도해주세요.'});return res.status(400).json({message:error?.message||'룰렛 설정을 저장하지 못했습니다.'})}
}

function normalizeFixedUpboRule(input){
  const balloons=Math.trunc(Number(input?.balloons));
  const eventName=String(input?.eventName||input?.event_name||'').trim().normalize('NFC');
  const upboType=String(input?.upboType||input?.upbo_type||'').trim().normalize('NFC');
  const outputTypes=upboType.split(/\s*&\s*/u).map(value=>value.trim()).filter(Boolean);
  const quantity=Math.trunc(Number(input?.quantity||1));
  if(!Number.isSafeInteger(balloons)||balloons<1||balloons>1000000000)throw new Error('별풍선 개수는 1~1,000,000,000 사이의 정수로 입력해주세요.');
  if(!eventName||eventName.length>120||!upboType||upboType.length>120)throw new Error('이벤트명과 업보명은 1~120자로 입력해주세요.');
  if(!outputTypes.length||outputTypes.length>20)throw new Error('업보명은 &로 최대 20개까지 구분할 수 있습니다.');
  if(!Number.isSafeInteger(quantity)||quantity<1||quantity>1000)throw new Error('수량은 1~1,000 사이의 정수로 입력해주세요.');
  return {balloons,event_name:eventName,upbo_type:upboType,quantity,updated_at:new Date().toISOString()};
}

async function handleFixedUpboRules(req,res){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Content-Type','application/json; charset=utf-8');
  const capability=req.method==='GET'?'data:read':req.method==='DELETE'?'data:delete':'data:write';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  if(req.method==='GET'){
    const rows=await sb('byeollog_fixed_upbo_rules',`?workspace_id=eq.${q(workspaceId)}&select=balloons,event_name,upbo_type,quantity,updated_at&order=balloons.asc,event_name.asc,upbo_type.asc`);
    return res.status(200).json({ok:true,rules:Array.isArray(rows)?rows:[]});
  }
  if(!['POST','DELETE'].includes(req.method))return res.status(405).json({message:'Method not allowed'});
  if(!requireSafeJsonMutation(req,res))return;
  const body=bodyOf(req);if(!body)return res.status(400).json({message:'Invalid JSON body'});
  try{
    if(req.method==='DELETE'){
      const key=normalizeFixedUpboRule(body.rule||body);
      await sb('byeollog_fixed_upbo_rules',`?workspace_id=eq.${q(workspaceId)}&balloons=eq.${key.balloons}&event_name=eq.${q(key.event_name)}&upbo_type=eq.${q(key.upbo_type)}`,{method:'DELETE',prefer:'return=minimal'});
      return res.status(200).json({ok:true});
    }
    const rule=normalizeFixedUpboRule(body.rule||body);
    await sb('byeollog_fixed_upbo_rules','?on_conflict=workspace_id,balloons,event_name,upbo_type',{method:'POST',body:{workspace_id:workspaceId,...rule},prefer:'resolution=merge-duplicates,return=minimal'});
    if(body.replace){
      const previous=normalizeFixedUpboRule(body.replace);
      const changed=previous.balloons!==rule.balloons||previous.event_name!==rule.event_name||previous.upbo_type!==rule.upbo_type;
      if(changed)await sb('byeollog_fixed_upbo_rules',`?workspace_id=eq.${q(workspaceId)}&balloons=eq.${previous.balloons}&event_name=eq.${q(previous.event_name)}&upbo_type=eq.${q(previous.upbo_type)}`,{method:'DELETE',prefer:'return=minimal'});
    }
    return res.status(200).json({ok:true,rule});
  }catch(error){return res.status(400).json({message:error?.message||'고정 업보 규칙을 저장하지 못했습니다.'})}
}

function normalizeSpecialRouletteRule(input,{keyOnly=false}={}){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('특수룰렛 항목을 확인해주세요.');
  const allowed=new Set(['result_text','allow_stacking','enabled','workspace_id']);
  if(Object.keys(input).some(key=>!allowed.has(key)))throw new Error('특수룰렛 기능은 룰렛 두배로 고정됩니다. 허용된 설정만 입력해주세요.');
  if(typeof input.result_text!=='string'||/[\u0000-\u001f\u007f-\u009f]/u.test(input.result_text))throw new Error('룰렛명에 제어 문자를 사용할 수 없습니다. 결과 문구를 입력해주세요.');
  const result_text=input.result_text.normalize('NFC').trim();
  if(!result_text||[...result_text].length>120)throw new Error('룰렛명은 1~120자로 입력해주세요.');
  if(Object.hasOwn(input,'allow_stacking')&&typeof input.allow_stacking!=='boolean')throw new Error('중첩 사용 여부를 확인해주세요.');
  if(Object.hasOwn(input,'enabled')&&typeof input.enabled!=='boolean')throw new Error('사용 여부를 확인해주세요.');
  if(keyOnly)return {result_text};
  if(typeof input.allow_stacking!=='boolean')throw new Error('중첩 사용 여부를 확인해주세요.');
  return {result_text,allow_stacking:input.allow_stacking,enabled:input.enabled??true};
}

// Quote PostgREST text literals as well as URL-encoding them: result names may
// contain commas, parentheses, quotes, ampersands, and other filter punctuation.
function specialRouletteRuleFilter(workspaceId,resultText){
  return `?workspace_id=eq.${q(workspaceId)}&result_text=eq.${q(JSON.stringify(resultText))}`;
}

async function handleSpecialRouletteRules(req,res){
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Content-Type','application/json; charset=utf-8');
  const capability=req.method==='GET'?'data:read':req.method==='DELETE'?'data:delete':'data:write';
  const session=await requireCapabilityLive(req,res,capability);if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  if(req.method==='GET'){
    try{
      const rows=await sb('byeollog_special_roulette_rules',`?workspace_id=eq.${q(workspaceId)}&select=result_text,allow_stacking,enabled,created_at,updated_at&order=result_text.asc`);
      return res.status(200).json({ok:true,rules:Array.isArray(rows)?rows:[]});
    }catch{return res.status(502).json({message:'특수룰렛 설정을 불러오지 못했습니다.'})}
  }
  if(!['POST','DELETE'].includes(req.method))return res.status(405).json({message:'Method not allowed'});
  if(!requireSafeJsonMutation(req,res))return;
  const body=bodyOf(req);if(!body||typeof body!=='object'||Array.isArray(body))return res.status(400).json({message:'Invalid JSON body'});
  let rule,previous;
  try{
    if(Object.hasOwn(body,'rule')&&Object.keys(body).some(key=>!['rule','replace','workspace_id'].includes(key)))throw new Error('허용된 특수룰렛 설정만 입력해주세요.');
    rule=normalizeSpecialRouletteRule(body.rule??body,{keyOnly:req.method==='DELETE'});
    if(body.replace!=null){
      if(req.method!=='POST')throw new Error('삭제 요청에는 수정할 항목을 지정할 수 없습니다.');
      previous=normalizeSpecialRouletteRule(body.replace,{keyOnly:true});
    }
  }catch(error){return res.status(400).json({message:error.message})}
  try{
    if(req.method==='DELETE'){
      await sb('byeollog_special_roulette_rules',specialRouletteRuleFilter(workspaceId,rule.result_text),{method:'DELETE',prefer:'return=minimal'});
      return res.status(200).json({ok:true});
    }
    await sb('byeollog_special_roulette_rules','?on_conflict=workspace_id,result_text',{method:'POST',body:{workspace_id:workspaceId,...rule,updated_at:new Date().toISOString()},prefer:'resolution=merge-duplicates,return=minimal'});
    if(previous&&previous.result_text!==rule.result_text){
      await sb('byeollog_special_roulette_rules',specialRouletteRuleFilter(workspaceId,previous.result_text),{method:'DELETE',prefer:'return=minimal'});
    }
    return res.status(200).json({ok:true,rule});
  }catch{return res.status(502).json({message:'특수룰렛 설정을 저장하지 못했습니다. 목록을 다시 확인해주세요.'})}
}

async function handleReverseFanDay(req,res){
  res.setHeader('Cache-Control','no-store, private');
  const session=await requireCapabilityLive(req,res,req.method==='GET'?'data:read':'data:write');if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  if(req.method==='POST'&&!requireSafeJsonMutation(req,res))return;
  let result;
  try{result=await reverseFanDayRequest({sb,workspaceId,userId:session.user_id,method:req.method,query:req.query,body:bodyOf(req)})}
  catch(error){result=reverseFanDayError(error)}
  return res.status(result.status).json(result.body);
}

async function handleRouletteExceptions(req,res){
  res.setHeader('Cache-Control','no-store, private');
  const session=await requireCapabilityLive(req,res,req.method==='GET'?'data:read':'data:write');if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  if(req.method==='POST'&&!requireSafeJsonMutation(req,res))return;
  let result;
  try{result=await rouletteExceptionsRequest({sb,workspaceId,userId:session.user_id,method:req.method,query:req.query,body:bodyOf(req)})}
  catch(error){result=exceptionError(error)}
  return res.status(result.status).json(result.body);
}

async function handleRouletteClassificationPage(req,res){
  const session=await requireCapabilityLive(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH);if(!session)return;
  res.setHeader('Cache-Control','no-store, private');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  const nonce=crypto.randomBytes(18).toString('base64url');
  if(wantsDashboardShell(req))return sendDashboardShell(req,res,nonce,'roulette-rules');
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'none'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('Content-Type','text/html; charset=utf-8');return res.status(200).send(prepareDashboardContent(req,res,getRouletteClassificationHtml(nonce),nonce));
}

async function handleUxControls(req,res){
  res.setHeader('Cache-Control','no-store, private');
  const session=await requireCapabilityLive(req,res,req.method==='GET'?'data:read':'data:write');if(!session)return;
  const workspaceId=await workspaceForSession(session);if(!workspaceId)return res.status(403).json({message:'워크스페이스를 확인할 수 없습니다.'});
  if(req.method!=='GET'&&!requireSafeJsonMutation(req,res))return;
  let result;try{result=await uxControlsRequest({sb,workspaceId,userId:session.user_id,method:req.method,query:req.query,body:bodyOf(req)||{}})}catch(error){result=uxError(error)}
  return res.status(result.status).json(result.body);
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
    const active=await sb('byeollog_native_roulette_activations',`?workspace_id=eq.${q(workspaceId)}&draft_id=eq.${q(requestedId)}&select=draft_id&limit=1`).catch(error=>error?.status===404?[]:Promise.reject(error));
    if(firstRow(active))return res.status(409).json({message:'방송 적용 중인 룰렛은 삭제할 수 없습니다. 먼저 해당 룰렛을 방송에서 해제해주세요.'});
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
    if(!rouletteName||rouletteName.length>120)return res.status(400).json({message:'이벤트명을 1~120자로 입력해주세요.'});
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
  const session=await requireCapabilityLive(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH);if(!session)return;
  res.setHeader('Cache-Control','no-store, private');
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  const nonce=crypto.randomBytes(18).toString('base64url');
  if(section==='signatures'&&wantsDashboardShell(req))return sendDashboardShell(req,res,nonce,section);
  const assetOrigin=signatureAssetOrigin();
  res.setHeader('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'nonce-${nonce}'; style-src-attr 'none'; img-src 'self' data: ${assetOrigin} https://sooplive.com https://*.sooplive.com https://afreecatv.com https://*.afreecatv.com https://afreecatvcdn.com https://*.afreecatvcdn.com; connect-src 'self' ${assetOrigin}; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send(prepareDashboardContent(req,res,getProductDashboardHtml(nonce,section),nonce));
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
    const view=String(req.query?.view||'');
    const isBrowserPage=!operation||view==='agent-rollout'||['roulette','actions','signatures','wallpaper','roulette-rules'].includes(view);
    if(!isBrowserPage)return res.status(401).json({message:'Unauthorized'});
    res.setHeader('Location','/login?expired=1');
    return res.status(302).end();
  }

  if(['roulette','actions'].includes(String(req.query?.view||''))){
    res.setHeader('Cache-Control','no-store, private');
    res.setHeader('Location','/dashboard/signatures');
    return res.status(302).end();
  }

  if(['native-roulette-service','roulette-image-upload-ticket','roulette-image-confirm','roulette-draft','product-control-state','soop-runtime-status'].includes(operation)){
    return res.status(410).json({message:'이 기능은 풍벽지·업보 중심 버전에서 종료되었습니다.',code:'feature_retired'});
  }

  if(operation==='dashboard-bootstrap')return handleDashboardBootstrap(req,res);
  if(operation==='weflab-public-import')return handleWeflabPublicImport(req,res);
  if(operation==='roulette-classification-rules')return handleRouletteClassificationRules(req,res);
  if(operation==='fixed-upbo-rules')return handleFixedUpboRules(req,res);
  if(operation==='reverse-fan-day')return handleReverseFanDay(req,res);
  if(operation==='special-roulette-rules')return handleSpecialRouletteRules(req,res);
  if(operation==='roulette-exceptions')return handleRouletteExceptions(req,res);
  if(operation==='ux-controls')return handleUxControls(req,res);
  if(operation==='agent-rollout-status')return handleAgentRolloutStatus(req,res);
  if(operation==='product-control-state')return handleProductControlState(req,res);
  if(operation==='wallpaper-image-mask')return handleWallpaperImageMask(req,res);
  if(operation==='soop-runtime-status')return handleSoopRuntimeStatus(req,res);
  if(['signature-image-upload-ticket','signature-image-confirm','default-donation-image-upload-ticket','default-donation-image-confirm'].includes(operation))return handleSignatureAsset(req,res,operation);
  if(operation==='signature-balloon-registry')return handleSignatureBalloonRegistry(req,res);
  if(operation==='default-donation-image-registry')return handleDefaultDonationImageRegistry(req,res);
  if(operation==='wallpaper-control')return handleWallpaperControl(req,res);
  if(String(req.query?.view||'')==='agent-rollout')return handleAgentRolloutPage(req,res);
  if(['signatures','wallpaper'].includes(String(req.query?.view||'')))return handleProductControlPage(req,res,String(req.query.view));
  if(String(req.query?.view||'')==='roulette-rules')return handleRouletteClassificationPage(req,res);

  if(operation==='context'){
    res.setHeader('Cache-Control','no-store, private');
    const liveSession=await requireCapabilityLive(req,res,'data:read');
    if(!liveSession)return;
    try{
      const workspaceId=await workspaceForSession(liveSession);
      if(!workspaceId)return res.status(403).json({message:'연결된 스트리머 계정을 확인할 수 없습니다.'});
      const rows=await sb('byeollog_workspaces',`?select=display_name,slug,public_page_enabled&id=eq.${q(workspaceId)}&limit=1`);
      const row=Array.isArray(rows)?rows[0]:null;
      if(!row)return res.status(403).json({message:'연결된 스트리머 계정을 확인할 수 없습니다.'});
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
      return res.status(503).json({message:'서버 연결을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.'});
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
        const rows=await sb('byeollog_workspaces',`?select=id,slug,display_name,public_page_enabled,public_completed_enabled,status&id=eq.${q(workspaceId)}&limit=1`);
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
          visibility:!enabled?'private':row.public_completed_enabled?'all':'pending',
          public_page_path:slug?`/u/${encodeURIComponent(slug)}`:null
        });
      }
      if(req.method==='PATCH'||req.method==='POST'){
        const body=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{});
        if(body.visibility!==undefined&&!['all','pending','private'].includes(body.visibility))return res.status(400).json({message:'공개 범위를 다시 선택해주세요.'});
        if(body.visibility===undefined&&typeof body.public_page_enabled!=='boolean')
          return res.status(400).json({message:'공개 범위를 선택해주세요.'});
        await sb('byeollog_workspaces',`?id=eq.${q(workspaceId)}`,{
          method:'PATCH',
          body:body.visibility===undefined?{public_page_enabled:body.public_page_enabled}:{public_page_enabled:body.visibility!=='private',public_completed_enabled:body.visibility==='all'}
        });
        const rows=await sb('byeollog_workspaces',`?select=slug,display_name,public_page_enabled,public_completed_enabled&id=eq.${q(workspaceId)}&limit=1`);
        const row=Array.isArray(rows)?rows[0]:null;
        const slug=String(row?.slug||'').trim();
        return res.status(200).json({
          ok:true,
          public_page_enabled:row?.public_page_enabled!==false,
          visibility:row?.public_page_enabled===false?'private':row?.public_completed_enabled?'all':'pending',
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
  const liveSession=await requireCapabilityLive(req,res,'data:read',DASHBOARD_NAVIGATION_AUTH);
  if(!liveSession)return;
  if(wantsDashboardShell(req))return sendDashboardShell(req,res,crypto.randomBytes(18).toString('base64url'),'upbo');
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
  return res.status(200).send(prepareDashboardContent(req,res,html,nonce));
}
