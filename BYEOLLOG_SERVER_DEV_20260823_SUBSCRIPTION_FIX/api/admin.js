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
  res.setHeader('Content-Security-Policy',`default-src 'self'; script-src 'nonce-${nonce}'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.status(200).send(getAgentRolloutHtml(nonce));
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
  if(String(req.query?.view||'')==='agent-rollout')return handleAgentRolloutPage(req,res);

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
    `default-src 'self'; script-src 'nonce-${nonce}'; script-src-elem 'nonce-${nonce}'; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
  );
  res.setHeader('Content-Type','text/html; charset=utf-8');
  const decoded=Buffer.from(ADMIN_HTML_BASE64,'base64').toString('utf8');
  const bootstrapScript=initialBootstrap
    ?`<script nonce="${nonce}">window.__BYEOLLOG_DASHBOARD_BOOTSTRAP__=${serializeInlineJson(initialBootstrap)};</script>`
    :'';
  const html=rewriteInlineEventHandlers(decoded)
    .replace(/<script(\s|>)/g,`<script nonce="${nonce}"$1`)
    .replace('</head>',`${bootstrapScript}</head>`);
  return res.status(200).send(html);
}
